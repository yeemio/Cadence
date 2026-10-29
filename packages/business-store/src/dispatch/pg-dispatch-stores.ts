/**
 * dispatch 五端口的 PG 实现 + 组合根装配工厂（M2-W6，经本包 `./dispatch` 子路径
 * 导出——与 `./listing` / `./workorder` 同模式：主入口保持零 @prisma/client
 * 依赖）。启动零 DB 依赖：connectDispatchStore 只构造 PrismaClient（惰性连接），
 * 无 DATABASE_URL 时组合根不调用本工厂。
 *
 * 五个实现（表 ↔ 端口分工见 prisma/schema.prisma dispatch 节与迁移头注）：
 *  - PgDispatchOrderStore        → dispatch_orders 投影（六类派工单头，
 *                                  advance 乐观可回填 doneQty/assignee；transfer
 *                                  转单字段重写不推进版本——fix-wave-6 6a-1）
 *  - PgOutsourcingLineStore      → outsourcing_lines 投影（外协明细，
 *                                  appendLines 批量插入行号唯一；backfillPrice /
 *                                  cancel = object_version 条件更新 +1 版本，
 *                                  零行命中 → null——cancel 落两列取消事实）
 *  - PgDispatchOperationStore    → dispatch_operations 幂等记账（PK=租户|operationId，
 *                                  P2002 = 已落账 → record 返回 null）
 *  - PgDispatchDomainEventStore  → 域事件 + Outbox 同事务落账（**复用既有
 *                                  event_records / outbox_records**，不建新表）
 *  - PgDispatchMachineEventStore → engine-flow ApprovalEventStore（dispatch_events
 *                                  账本；dispatch-order 聚合专用，(aggregate_id,
 *                                  aggregate_revision) 唯一 = DB 级乐观锁）
 *  - PgAftercareClaimStore       → aftercare_claims / aftercare_claim_lines
 *                                  报销两表（U5 A12 增量；实现移 pg-aftercare-
 *                                  claim-stores.ts——一单一报销 + 行费用整批
 *                                  乐观重写）
 *
 * 租户解析取舍（同 workorder/listing）：engine 机器事件端口不带租户参数——聚合
 * 锚定合同 = 投影行（dispatch_orders），租户经投影行解析（孤儿聚合 fail-fast
 * 拒写）。域事件自带 tenantId，直落 event_records。
 *
 * 已知边界（共享账本既定取舍）：pendingOutbox/markDelivered 作用于全表
 * outbox_records——跨模块共享的投递记账由单例投递器统一扫（与 workorder/listing
 * 口径一致）。
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';
import {
  EventId,
  TenantId,
  UserId,
  type BusinessEvent,
  type OutboxRecord,
} from '@smes/business-core';
import {
  makeApprovalEvent,
  type ApprovalEvent,
  type ApprovalEventCursor,
  type ApprovalEventPage,
  type ApprovalEventPayload,
  type ApprovalEventStore,
} from '@smes/engine-flow';
import {
  DISPATCH_ORDER_AGGREGATE_TYPE,
  DispatchConflictError,
  type AftercareClaimStore,
  type AppendOutsourcingLineInput,
  type BackfillOutsourcingPriceFields,
  type CreateDispatchOrderInput,
  type DispatchDomainEventStore,
  type DispatchOperationRecord,
  type DispatchOperationStore,
  type DispatchOrder,
  type DispatchOrderStore,
  type ListDispatchOrdersFilter,
  type OutsourcingLine,
  type OutsourcingLineStore,
} from '@smes/application';
import { fromBusinessEventRow, toBusinessEventRow } from '../events/event-row.js';
import { initialOutboxRow, toOutboxRecord } from '../events/outbox-row.js';
import { PgAftercareClaimStore } from './pg-aftercare-claim-stores.js';

// ---- 小工具（同 workorder / listing 体例） ----

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** 领域 JSON 载荷（对象或数组）→ Prisma JSON 输入。 */
function json(value: Readonly<Record<string, unknown>> | readonly unknown[]): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

// ---- 行 <-> 领域形状映射 ----

interface DispatchOrderDbRow {
  readonly equipmentRefs?: unknown;
  readonly rollup?: boolean;
  readonly id: string;
  readonly tenantId: string;
  readonly workOrderId: string | null;
  readonly kind: string;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly title: string;
  readonly drawingNo: string | null;
  readonly operationCode: string | null;
  readonly material: string | null;
  readonly sizeSpec: string | null;
  readonly quantity: number;
  readonly doneQty: number;
  readonly assignee: string | null;
  readonly dueAt: Date | null;
  readonly remark: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function rowToDispatchOrder(row: DispatchOrderDbRow): DispatchOrder {
  return {
    equipmentRefs: Array.isArray(row.equipmentRefs) ? row.equipmentRefs as string[] : [],
    rollup: row.rollup ?? false,
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    workOrderId: row.workOrderId,
    kind: row.kind as DispatchOrder['kind'],
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    title: row.title,
    drawingNo: row.drawingNo,
    operationCode: row.operationCode,
    material: row.material,
    sizeSpec: row.sizeSpec,
    quantity: row.quantity,
    doneQty: row.doneQty,
    assignee: row.assignee === null ? null : UserId.create(row.assignee),
    dueAt: row.dueAt === null ? null : row.dueAt.toISOString(),
    remark: row.remark,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface OutsourcingLineDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly dispatchId: string;
  readonly lineNo: number;
  readonly processCode: string;
  readonly drawingNo: string | null;
  readonly supplierRef: string;
  readonly supplierName: string | null;
  readonly quantity: number;
  readonly unitPriceMinor: number | null;
  readonly priceSource: string | null;
  readonly marginPermyriad: number | null;
  readonly promisedAt: Date | null;
  readonly sourceListingLineId: string | null;
  readonly cancelledAt: Date | null;
  readonly cancelReason: string | null;
  readonly objectVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function rowToOutsourcingLine(row: OutsourcingLineDbRow): OutsourcingLine {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    dispatchId: row.dispatchId,
    lineNo: row.lineNo,
    processCode: row.processCode,
    drawingNo: row.drawingNo,
    supplierRef: row.supplierRef,
    supplierName: row.supplierName,
    quantity: row.quantity,
    unitPriceMinor: row.unitPriceMinor,
    priceSource: row.priceSource as OutsourcingLine['priceSource'],
    marginPermyriad: row.marginPermyriad,
    promisedAt: row.promisedAt === null ? null : row.promisedAt.toISOString(),
    sourceListingLineId: row.sourceListingLineId,
    cancelledAt: row.cancelledAt === null ? null : row.cancelledAt.toISOString(),
    cancelReason: row.cancelReason,
    objectVersion: row.objectVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface DispatchEventDbRow {
  readonly seq: bigint;
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly aggregateRevision: number;
  readonly occurredAt: Date;
  readonly payload: unknown;
}

export function rowToDispatchEvent(row: DispatchEventDbRow): ApprovalEvent {
  return makeApprovalEvent({
    eventId: EventId.create(row.eventId),
    eventType: row.eventType,
    aggregate: {
      id: row.aggregateId,
      type: row.aggregateType,
      revision: row.aggregateRevision,
    },
    occurredAt: row.occurredAt.toISOString(),
    payload: row.payload as ApprovalEventPayload,
  });
}

// ---- 派工单（application DispatchOrderStore） ----

export class PgDispatchOrderStore implements DispatchOrderStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateDispatchOrderInput): Promise<DispatchOrder> {
    try {
      const row = await this.prisma.dispatchOrderRecord.create({
        data: {
          id: input.id,
          tenantId: input.tenant,
          workOrderId: input.workOrderId,
          kind: input.kind,
          flowConfigId: input.flowConfigId,
          state: input.state,
          objectVersion: input.objectVersion,
          title: input.title,
          equipmentRefs: json(input.equipmentRefs ?? []),
          rollup: input.rollup ?? false,
          drawingNo: input.drawingNo,
          operationCode: input.operationCode,
          material: input.material,
          sizeSpec: input.sizeSpec,
          quantity: input.quantity,
          assignee: input.assignee,
          dueAt: input.dueAt === null ? null : new Date(input.dueAt),
          remark: input.remark,
        },
      });
      return rowToDispatchOrder(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DispatchConflictError(`派工单 '${input.id}' 已存在`);
      }
      throw error;
    }
  }

  async find(tenant: TenantId, id: string): Promise<DispatchOrder | null> {
    const row = await this.prisma.dispatchOrderRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : rowToDispatchOrder(row);
  }

  async list(tenant: TenantId, filter?: ListDispatchOrdersFilter): Promise<readonly DispatchOrder[]> {
    const rows = await this.prisma.dispatchOrderRecord.findMany({
      where: {
        tenantId: tenant,
        ...(filter?.kind === undefined ? {} : { kind: filter.kind }),
        ...(filter?.state === undefined ? {} : { state: filter.state }),
        ...(filter?.workOrderId === undefined ? {} : { workOrderId: filter.workOrderId }),
        ...(filter?.assignee === undefined ? {} : { assignee: filter.assignee }),
      },
      orderBy: { createdAt: 'desc' }, // 新的在前（与内存实现同序）
    });
    return rows.map(rowToDispatchOrder);
  }

  async advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: { readonly doneQty?: number; readonly assignee?: UserId | null },
  ): Promise<DispatchOrder> {
    const updated = await this.prisma.dispatchOrderRecord.updateMany({
      where: { tenantId: tenant, id, objectVersion: expectedObjectVersion },
      data: {
        state: nextState,
        objectVersion: nextObjectVersion,
        updatedAt: new Date(),
        ...(extra?.doneQty === undefined ? {} : { doneQty: extra.doneQty }),
        ...(extra?.assignee === undefined ? {} : { assignee: extra.assignee }),
      },
    });
    if (updated.count === 0) {
      const current = await this.prisma.dispatchOrderRecord.findFirst({ where: { tenantId: tenant, id } });
      throw new DispatchConflictError(
        `派工单 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${current?.objectVersion ?? '不存在'}`,
      );
    }
    const row = await this.prisma.dispatchOrderRecord.findFirstOrThrow({ where: { tenantId: tenant, id } });
    return rowToDispatchOrder(row);
  }

  /**
   * 转单字段重写（fix-wave-6 6a-1，RREQ-DP-024）：非状态机迁移——**不推进
   * objectVersion、不写机器事件**（审计快照 DispatchTransferred 由服务层落
   * event_records）。乐观条件更新（同 advance 的 where 口径）：零行命中
   * （不存在/版本不符）返回 null；fields 只携带显式变更维（undefined = 不动）。
   */
  async transfer(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    fields: { readonly assignee?: UserId | null; readonly operationCode?: string | null },
  ): Promise<DispatchOrder | null> {
    const updated = await this.prisma.dispatchOrderRecord.updateMany({
      where: { tenantId: tenant, id, objectVersion: expectedObjectVersion },
      data: {
        ...(fields.assignee === undefined ? {} : { assignee: fields.assignee }),
        ...(fields.operationCode === undefined ? {} : { operationCode: fields.operationCode }),
        updatedAt: new Date(),
      },
    });
    if (updated.count === 0) return null;
    const row = await this.prisma.dispatchOrderRecord.findFirstOrThrow({ where: { tenantId: tenant, id } });
    return rowToDispatchOrder(row);
  }
}

// ---- 外协明细（投影，backfillPrice 乐观更新） ----

export class PgOutsourcingLineStore implements OutsourcingLineStore {
  constructor(private readonly prisma: PrismaClient) {}

  async appendLines(inputs: readonly AppendOutsourcingLineInput[]): Promise<readonly OutsourcingLine[]> {
    try {
      // 交互式事务：整批原子落（端口合同）；唯一冲突（id/行号）整批回滚。
      return await this.prisma.$transaction(async (tx) => {
        const rows: OutsourcingLine[] = [];
        for (const input of inputs) {
          const row = await tx.outsourcingLineRecord.create({
            data: {
              id: input.id,
              tenantId: input.tenant,
              dispatchId: input.dispatchId,
              lineNo: input.lineNo,
              processCode: input.processCode,
              drawingNo: input.drawingNo,
              supplierRef: input.supplierRef,
              supplierName: input.supplierName,
              quantity: input.quantity,
              unitPriceMinor: input.unitPriceMinor,
              priceSource: input.priceSource,
              marginPermyriad: input.marginPermyriad,
              promisedAt: input.promisedAt === null ? null : new Date(input.promisedAt),
              sourceListingLineId: input.sourceListingLineId,
            },
          });
          rows.push(rowToOutsourcingLine(row));
        }
        return rows;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DispatchConflictError('外协明细插入冲突：id 已存在或 (派工单, 行号) 唯一被违反');
      }
      throw error;
    }
  }

  async find(tenant: TenantId, id: string): Promise<OutsourcingLine | null> {
    const row = await this.prisma.outsourcingLineRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : rowToOutsourcingLine(row);
  }

  async listByDispatch(tenant: TenantId, dispatchId: string): Promise<readonly OutsourcingLine[]> {
    const rows = await this.prisma.outsourcingLineRecord.findMany({
      where: { tenantId: tenant, dispatchId },
      orderBy: { lineNo: 'asc' },
    });
    return rows.map(rowToOutsourcingLine);
  }

  async listBySupplier(tenant: TenantId, supplierRef: string): Promise<readonly OutsourcingLine[]> {
    const rows = await this.prisma.outsourcingLineRecord.findMany({
      where: { tenantId: tenant, supplierRef },
      orderBy: [{ dispatchId: 'asc' }, { lineNo: 'asc' }],
    });
    return rows.map(rowToOutsourcingLine);
  }

  async backfillPrice(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    fields: BackfillOutsourcingPriceFields,
  ): Promise<OutsourcingLine | null> {
    // 乐观更新：按 (tenant, id, object_version=expected) 条件更新，零行 = 版本不符或不存在。
    const updated = await this.prisma.outsourcingLineRecord.updateMany({
      where: { tenantId: tenant, id, objectVersion: expectedObjectVersion },
      data: {
        unitPriceMinor: fields.unitPriceMinor,
        priceSource: fields.priceSource,
        marginPermyriad: fields.marginPermyriad,
        ...(fields.promisedAt === undefined
          ? {}
          : { promisedAt: fields.promisedAt === null ? null : new Date(fields.promisedAt) }),
        objectVersion: expectedObjectVersion + 1,
        updatedAt: new Date(),
      },
    });
    if (updated.count === 0) return null;
    const row = await this.prisma.outsourcingLineRecord.findFirstOrThrow({
      where: { tenantId: tenant, id },
    });
    return rowToOutsourcingLine(row);
  }

  /**
   * 取消外协明细行（fix-wave-6 6a-1，RREQ-DP-031）：行是版本化数据（非状态机）
   * ——落取消事实（cancelled_at + cancel_reason）并 +1 版本，同 backfillPrice
   * 乐观口径（(tenant, id, object_version=expected) 条件更新，零行 = 版本不符
   * 或不存在 → null）。域事件 OutsourcingLineCancelled 由服务层落 event_records。
   */
  async cancel(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    fields: { readonly cancelReason: string | null; readonly cancelledAt: string },
  ): Promise<OutsourcingLine | null> {
    const updated = await this.prisma.outsourcingLineRecord.updateMany({
      where: { tenantId: tenant, id, objectVersion: expectedObjectVersion },
      data: {
        cancelReason: fields.cancelReason,
        cancelledAt: new Date(fields.cancelledAt),
        objectVersion: expectedObjectVersion + 1,
        updatedAt: new Date(),
      },
    });
    if (updated.count === 0) return null;
    const row = await this.prisma.outsourcingLineRecord.findFirstOrThrow({
      where: { tenantId: tenant, id },
    });
    return rowToOutsourcingLine(row);
  }
}

// ---- 命令幂等记账 ----

export class PgDispatchOperationStore implements DispatchOperationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async record(entry: DispatchOperationRecord): Promise<DispatchOperationRecord | null> {
    try {
      await this.prisma.dispatchOperationRecord.create({
        data: {
          operationKey: `${entry.tenant}|${entry.operationId}`, // PK = 租户+operationId（应用侧拼键）
          tenantId: entry.tenant,
          operationId: entry.operationId,
          command: entry.command,
          aggregateType: entry.aggregateType,
          aggregateId: entry.aggregateId,
          occurredAt: new Date(entry.occurredAt),
        },
      });
      return entry;
    } catch (error) {
      if (isUniqueViolation(error)) return null; // 已落账 → 幂等拒绝（端口合同）
      throw error;
    }
  }
}

// ---- 域事件（BusinessEvent + Outbox，复用既有 event_records / outbox_records） ----

export class PgDispatchDomainEventStore implements DispatchDomainEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: BusinessEvent): Promise<OutboxRecord> {
    const row = toBusinessEventRow(event);
    const outbox = initialOutboxRow(row.eventId, row.tenantId);
    try {
      // 交互式事务共享 tx 句柄：event+outbox 原子双写（RLS 接管见 rls-session.ts）。
      await this.prisma.$transaction(async (tx) => {
        await tx.businessEventRecord.create({
          data: {
            eventId: row.eventId,
            tenantId: row.tenantId,
            eventType: row.eventType,
            aggregateId: row.aggregateId,
            aggregateType: row.aggregateType,
            aggregateRevision: row.aggregateRevision,
            occurredAt: row.occurredAt,
            ...(row.businessTime === undefined ? {} : { businessTime: row.businessTime }),
            ...(row.availableTime === undefined ? {} : { availableTime: row.availableTime }),
            ...(row.provenance === undefined ? {} : { provenance: json(row.provenance) }),
            payload: json(row.payload as Readonly<Record<string, unknown>>),
          },
        });
        await tx.outboxRecord.create({
          data: {
            eventId: outbox.eventId,
            tenantId: outbox.tenantId,
            createdAt: outbox.createdAt,
          },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DispatchConflictError(`事件 '${row.eventId}' 已落账（eventId 幂等锚点）`);
      }
      throw error;
    }
    return toOutboxRecord(outbox);
  }

  async byAggregate(
    aggregate: { readonly id: string; readonly type: string },
  ): Promise<readonly BusinessEvent[]> {
    // 聚合 id 带模块前缀 uuidv7，全局唯一——端口不带租户参数（发布账本按聚合收口）。
    const rows = await this.prisma.businessEventRecord.findMany({
      where: { aggregateId: aggregate.id, aggregateType: aggregate.type },
      orderBy: [{ occurredAt: 'asc' }, { eventId: 'asc' }], // eventId=evt-uuidv7 时间序，同毫秒稳定
    });
    return rows.map((row) =>
      fromBusinessEventRow({
        eventId: row.eventId,
        eventType: row.eventType,
        tenantId: TenantId.create(row.tenantId),
        aggregateId: row.aggregateId,
        aggregateType: row.aggregateType,
        aggregateRevision: row.aggregateRevision,
        occurredAt: row.occurredAt,
        ...(row.businessTime === null ? {} : { businessTime: row.businessTime }),
        ...(row.availableTime === null ? {} : { availableTime: row.availableTime }),
        ...(row.provenance === null ? {} : { provenance: row.provenance as Readonly<Record<string, unknown>> }),
        payload: row.payload,
      }),
    );
  }

  async pendingOutbox(): Promise<readonly OutboxRecord[]> {
    const rows = await this.prisma.outboxRecord.findMany({
      where: { deliveredAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) =>
      toOutboxRecord({
        eventId: row.eventId,
        tenantId: TenantId.create(row.tenantId),
        createdAt: row.createdAt,
        attempts: row.attempts,
        ...(row.lastAttemptAt === null ? {} : { lastAttemptAt: row.lastAttemptAt }),
        ...(row.nextAttemptAt === null ? {} : { nextAttemptAt: row.nextAttemptAt }),
        deliveredAt: row.deliveredAt,
      }),
    );
  }

  async markDelivered(eventId: EventId, deliveredAt: string): Promise<void> {
    // Outbox 例外：投递记账可 UPDATE（append-only 触发器对 outbox_records 豁免）。
    await this.prisma.outboxRecord.updateMany({
      where: { eventId },
      data: { deliveredAt: new Date(deliveredAt) },
    });
  }
}

// ---- 机器事件账本（engine-flow ApprovalEventStore → dispatch_events） ----

/**
 * 租户解析：聚合锚定 = 投影行（同 workorder/listing 取舍）。dispatch-order →
 * dispatch_orders；其余类型 / 不存在的聚合 = 孤儿账目 fail-fast 拒写
 * （outsourcing-line 无状态机——其域事件走 event_records，不进本账本）。
 */
async function tenantOfDispatchAggregate(
  prisma: PrismaClient,
  aggregate: { readonly id: string; readonly type: string },
): Promise<string> {
  if (aggregate.type === DISPATCH_ORDER_AGGREGATE_TYPE) {
    const row = await prisma.dispatchOrderRecord.findUnique({ where: { id: aggregate.id } });
    if (row !== null) return row.tenantId;
  }
  throw new Error(
    `dispatch aggregate '${aggregate.type}:${aggregate.id}' 不存在于投影行：拒绝写入孤儿账目（聚合锚定合同 = dispatch_orders）`,
  );
}

export class PgDispatchMachineEventStore implements ApprovalEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: ApprovalEvent): Promise<void> {
    const tenantId = await tenantOfDispatchAggregate(this.prisma, event.aggregate);
    try {
      await this.prisma.dispatchEventRecord.create({
        data: {
          eventId: event.eventId,
          tenantId,
          eventType: event.eventType,
          aggregateId: event.aggregate.id,
          aggregateType: event.aggregate.type,
          aggregateRevision: event.aggregate.revision,
          occurredAt: new Date(event.occurredAt),
          payload: event.payload as object,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target = Array.isArray(error.meta?.target) ? (error.meta.target as string[]) : [];
        if (target.includes('aggregate_id')) {
          // 版本乐观锁：另一迁移已占该 (aggregate, revision)——并发推进必拒其一。
          throw new DispatchConflictError(
            `聚合 '${event.aggregate.id}' 版本 ${event.aggregate.revision} 已被另一迁移占用（并发推进冲突）`,
          );
        }
        // eventId 主键冲突 = 幂等去重纪律（与引擎内存实现同一合同）。
        throw new Error(`append-only violation: eventId "${event.eventId}" is already stored`);
      }
      throw error;
    }
  }

  async readByAggregate(
    aggregate: { readonly id: string; readonly type: string },
    options?: { readonly afterCursor?: ApprovalEventCursor },
  ): Promise<ApprovalEventPage> {
    const tenantId = await tenantOfDispatchAggregate(this.prisma, aggregate);
    const after = options?.afterCursor ?? 0;
    const rows = await this.prisma.dispatchEventRecord.findMany({
      where: {
        tenantId,
        aggregateId: aggregate.id,
        aggregateType: aggregate.type,
        seq: { gt: BigInt(after) },
      },
      orderBy: { seq: 'asc' },
    });
    return {
      events: rows.map(rowToDispatchEvent),
      nextCursor: rows.length === 0 ? null : Number(rows[rows.length - 1]!.seq),
    };
  }
}

// ---- 组合根装配工厂（惰性连接：同 ./listing） ----

export interface DispatchStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/** 组合根装配句柄：六端口实现（可直接喂 DispatchModule / AftercareClaimModule
 * register）+ 优雅断连（aftercareClaimStore 为 U5 增量——售后报销与派工单族
 * 共享同一 PrismaClient）。 */
export interface DispatchStoreHandle {
  readonly orderStore: DispatchOrderStore;
  readonly outsourcingLineStore: OutsourcingLineStore;
  readonly operationStore: DispatchOperationStore;
  readonly domainEventStore: DispatchDomainEventStore;
  readonly machineEventStore: ApprovalEventStore;
  readonly aftercareClaimStore: AftercareClaimStore;
  disconnect(): Promise<void>;
}

/** 构造 dispatch PG 存储装配（惰性连接：构造不握手，首查询才连库）。 */
export function connectDispatchStore(options: DispatchStoreOptions = {}): DispatchStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  // RLS session 接线（ESCALATION-2 收尾）：门控与机制/取舍见 ../rls-session.ts 文件头。
  const client = withRlsTenantSession(prisma, { session: rlsSessionEnabled() });
  return {
    orderStore: new PgDispatchOrderStore(client),
    outsourcingLineStore: new PgOutsourcingLineStore(client),
    operationStore: new PgDispatchOperationStore(client),
    domainEventStore: new PgDispatchDomainEventStore(client),
    machineEventStore: new PgDispatchMachineEventStore(client),
    aftercareClaimStore: new PgAftercareClaimStore(client),
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}
