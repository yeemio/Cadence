/**
 * inspection 五端口的 PG 实现 + 组合根装配工厂（M2-W4，经本包 `./inspection`
 * 子路径导出——与 `./workorder` 同模式：主入口保持零 @prisma/client 依赖）。
 * 启动零 DB 依赖：connectInspectionStore 只构造 PrismaClient（惰性连接），
 * 无 DATABASE_URL 时组合根不调用本工厂。
 *
 * 五个实现（表 ↔ 端口分工见 prisma/schema.prisma inspection 节与迁移头注）：
 *  - PgInspectionOrderStore        → inspections 投影行（advance = object_version
 *                                    条件更新 + 判定字段；updateJudgment 无迁移
 *                                    路径同乐观检查；(tenant, source_type,
 *                                    source_ref_id) 唯一 = 来源幂等 DB 防线）
 *  - PgNonconformStore             → nonconformities 投影行（advance 可回填处置/
 *                                    闭环字段）
 *  - PgInspectionOperationStore    → inspection_operations 幂等记账（PK=租户|
 *                                    operationId，P2002 = 已落账 → record 返回 null）
 *  - PgInspectionDomainEventStore  → 域事件 + Outbox 同事务落账（**复用既有
 *                                    event_records / outbox_records**，不建新表；
 *                                    eventId 幂等锚点，P2002 → InspectionConflictError）
 *  - PgInspectionMachineEventStore → engine-flow ApprovalEventStore（inspection_
 *                                    events 账本；inspection-order / nonconform
 *                                    两类聚合共用，(aggregate_id, aggregate_revision)
 *                                    唯一 = DB 级乐观锁）
 *
 * 租户解析取舍（同 ./workorder）：engine 机器事件端口不带租户参数——聚合锚定
 * 合同 = 投影行（service 恒以 aggregate.type='inspection-order'/'nonconform'、
 * aggregate.id=投影行 id 写入），租户经 inspections / nonconformities 行解析
 * （孤儿聚合 fail-fast 拒写）。域事件（BusinessEvent）自带 tenantId，直落
 * event_records，无需解析。
 *
 * 已知边界（共享账本既定取舍）：pendingOutbox/markDelivered 作用于全表
 * outbox_records——跨模块共享的投递记账由单例投递器统一扫（本端口不含租户
 * 参数，与内存实现合同一致；联动验证按 eventId 过滤消费）。
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';
import {
  EventId,
  InspectionId,
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
  INSPECTION_AGGREGATE_TYPE,
  NONCONFORM_AGGREGATE_TYPE,
  InspectionConflictError,
  type CreateInspectionInput,
  type CreateNonconformInput,
  type InspectionOrder,
  type InspectionOrderStore,
  type JudgmentFields,
  type ListInspectionsFilter,
  type ListNonconformsFilter,
  type Nonconform,
  type NonconformAdvanceExtra,
  type NonconformStore,
  type OperationRecord,
  type InspectionDomainEventStore,
  type InspectionOperationStore,
} from '@smes/application';
import { fromBusinessEventRow, toBusinessEventRow } from '../events/event-row.js';
import { initialOutboxRow, toOutboxRecord } from '../events/outbox-row.js';

// ---- 小工具（同 workorder 体例） ----

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** 领域 JSON 载荷（对象或数组）→ Prisma JSON 输入（结构同构，类型面窄化唯一换算点）。 */
function json(value: Readonly<Record<string, unknown>> | readonly unknown[]): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

function isoToDate(value: string, column: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid ${column}: expected an ISO 8601 date-time string, got ${value}`);
  }
  return parsed;
}

// ---- 行 <-> 领域形状映射 ----

interface InspectionDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly kind: string;
  readonly sourceType: string | null;
  readonly sourceRefId: string | null;
  readonly itemId: string | null;
  readonly drawingNo: string | null;
  readonly quantity: number;
  readonly passedQty: number | null;
  readonly failedQty: number | null;
  readonly judgeRemark: string | null;
  readonly judgedBy: string | null;
  readonly judgedAt: Date | null;
  readonly closeDueAt: Date | null;
  readonly overdueNotifiedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function rowToInspectionOrder(row: InspectionDbRow): InspectionOrder {
  return {
    id: InspectionId.create(row.id),
    tenant: TenantId.create(row.tenantId),
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    kind: row.kind as InspectionOrder['kind'],
    sourceType: row.sourceType as InspectionOrder['sourceType'],
    sourceRefId: row.sourceRefId,
    itemId: row.itemId,
    drawingNo: row.drawingNo,
    quantity: row.quantity,
    passedQty: row.passedQty,
    failedQty: row.failedQty,
    judgeRemark: row.judgeRemark,
    judgedBy: row.judgedBy === null ? null : UserId.create(row.judgedBy),
    judgedAt: row.judgedAt === null ? null : row.judgedAt.toISOString(),
    closeDueAt: row.closeDueAt === null ? null : row.closeDueAt.toISOString(),
    overdueNotifiedAt: row.overdueNotifiedAt === null ? null : row.overdueNotifiedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface NonconformDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly inspectionId: string;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly itemId: string | null;
  readonly quantity: number;
  readonly reason: string | null;
  readonly disposal: string | null;
  readonly disposeRemark: string | null;
  readonly disposedBy: string | null;
  readonly disposedAt: Date | null;
  readonly closeRemark: string | null;
  readonly closedBy: string | null;
  readonly closedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function rowToNonconform(row: NonconformDbRow): Nonconform {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    inspectionId: InspectionId.create(row.inspectionId),
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    itemId: row.itemId,
    quantity: row.quantity,
    reason: row.reason,
    disposal: row.disposal as Nonconform['disposal'],
    disposeRemark: row.disposeRemark,
    disposedBy: row.disposedBy === null ? null : UserId.create(row.disposedBy),
    disposedAt: row.disposedAt === null ? null : row.disposedAt.toISOString(),
    closeRemark: row.closeRemark,
    closedBy: row.closedBy === null ? null : UserId.create(row.closedBy),
    closedAt: row.closedAt === null ? null : row.closedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface InspectionEventDbRow {
  readonly seq: bigint;
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly aggregateRevision: number;
  readonly occurredAt: Date;
  readonly payload: unknown;
}

export function rowToInspectionEvent(row: InspectionEventDbRow): ApprovalEvent {
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

/** 判定字段块（advance/updateJudgment 共用；ISO ↔ Date 换算唯一换算点）。 */
function judgmentData(fields: JudgmentFields): Prisma.InspectionOrderRecordUpdateInput {
  return {
    passedQty: fields.passedQty,
    failedQty: fields.failedQty,
    judgeRemark: fields.judgeRemark,
    judgedBy: fields.judgedBy,
    judgedAt: isoToDate(fields.judgedAt, 'judgedAt'),
    closeDueAt: fields.closeDueAt === null ? null : isoToDate(fields.closeDueAt, 'closeDueAt'),
  };
}

// ---- 质检单投影行（application InspectionOrderStore） ----

export class PgInspectionOrderStore implements InspectionOrderStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateInspectionInput): Promise<InspectionOrder> {
    try {
      const row = await this.prisma.inspectionOrderRecord.create({
        data: {
          id: input.id,
          tenantId: input.tenant,
          flowConfigId: input.flowConfigId,
          state: input.state,
          objectVersion: input.objectVersion,
          kind: input.kind,
          sourceType: input.sourceType,
          sourceRefId: input.sourceRefId,
          itemId: input.itemId,
          drawingNo: input.drawingNo,
          quantity: input.quantity,
        },
      });
      return rowToInspectionOrder(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        // PK 冲突 = 同 id 重建；复合唯一冲突 = 来源幂等（同来源对象只生成一张待检单）。
        throw new InspectionConflictError(`质检单 '${input.id}' 已存在或来源 '${String(input.sourceType)}:${String(input.sourceRefId)}' 已有待检单`);
      }
      throw error;
    }
  }

  async find(tenant: TenantId, id: InspectionId): Promise<InspectionOrder | null> {
    const row = await this.prisma.inspectionOrderRecord.findFirst({
      where: { tenantId: tenant, id },
    });
    return row === null ? null : rowToInspectionOrder(row);
  }

  async findBySourceRef(
    tenant: TenantId,
    sourceType: InspectionOrder['sourceType'],
    sourceRefId: string,
  ): Promise<InspectionOrder | null> {
    const row = await this.prisma.inspectionOrderRecord.findFirst({
      where: { tenantId: tenant, sourceType, sourceRefId },
    });
    return row === null ? null : rowToInspectionOrder(row);
  }

  async list(tenant: TenantId, filter?: ListInspectionsFilter): Promise<readonly InspectionOrder[]> {
    const rows = await this.prisma.inspectionOrderRecord.findMany({
      where: {
        tenantId: tenant,
        ...(filter?.kind === undefined ? {} : { kind: filter.kind }),
        ...(filter?.state === undefined ? {} : { state: filter.state }),
      },
      orderBy: { createdAt: 'desc' }, // 新的在前（与内存实现同序）
    });
    return rows.map(rowToInspectionOrder);
  }

  async advance(
    tenant: TenantId,
    id: InspectionId,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: JudgmentFields,
  ): Promise<InspectionOrder> {
    // 乐观推进：按 (tenant, id, object_version=expected) 条件更新，零行 = 版本不符或不存在。
    const updated = await this.prisma.inspectionOrderRecord.updateMany({
      where: { tenantId: tenant, id, objectVersion: expectedObjectVersion },
      data: {
        state: nextState,
        objectVersion: nextObjectVersion,
        updatedAt: new Date(),
        ...(extra === undefined ? {} : judgmentData(extra)),
      },
    });
    if (updated.count === 0) {
      const current = await this.prisma.inspectionOrderRecord.findFirst({ where: { tenantId: tenant, id } });
      throw new InspectionConflictError(
        `质检单 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${current?.objectVersion ?? '不存在'}`,
      );
    }
    const row = await this.prisma.inspectionOrderRecord.findFirstOrThrow({
      where: { tenantId: tenant, id },
    });
    return rowToInspectionOrder(row);
  }

  async updateJudgment(
    tenant: TenantId,
    id: InspectionId,
    expectedObjectVersion: number,
    fields: JudgmentFields,
  ): Promise<InspectionOrder | null> {
    // 端口合同：不存在 → null（404 语义由用例层翻译）；版本不符 → Conflict。
    const existing = await this.prisma.inspectionOrderRecord.findFirst({ where: { tenantId: tenant, id } });
    if (existing === null) return null;
    const updated = await this.prisma.inspectionOrderRecord.updateMany({
      where: { tenantId: tenant, id, objectVersion: expectedObjectVersion },
      data: { updatedAt: new Date(), ...judgmentData(fields) },
    });
    if (updated.count === 0) {
      throw new InspectionConflictError(
        `质检单 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${existing.objectVersion}`,
      );
    }
    const row = await this.prisma.inspectionOrderRecord.findFirstOrThrow({ where: { tenantId: tenant, id } });
    return rowToInspectionOrder(row);
  }

  async markOverdueNotified(
    tenant: TenantId,
    id: InspectionId,
    notifiedAt: string,
  ): Promise<InspectionOrder | null> {
    // 点名幂等标记（运营字段 UPDATE）；不存在 → null（与端口合同一致）。
    const updated = await this.prisma.inspectionOrderRecord.updateMany({
      where: { tenantId: tenant, id },
      data: { overdueNotifiedAt: isoToDate(notifiedAt, 'overdueNotifiedAt'), updatedAt: new Date() },
    });
    if (updated.count === 0) return null;
    const row = await this.prisma.inspectionOrderRecord.findFirstOrThrow({ where: { tenantId: tenant, id } });
    return rowToInspectionOrder(row);
  }
}

// ---- 不合格处置投影行 ----

export class PgNonconformStore implements NonconformStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateNonconformInput): Promise<Nonconform> {
    try {
      const row = await this.prisma.nonconformRecord.create({
        data: {
          id: input.id,
          tenantId: input.tenant,
          inspectionId: input.inspectionId,
          flowConfigId: input.flowConfigId,
          state: input.state,
          objectVersion: input.objectVersion,
          itemId: input.itemId,
          quantity: input.quantity,
        },
      });
      return rowToNonconform(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new InspectionConflictError(`不合格处置 '${input.id}' 已存在`);
      }
      throw error;
    }
  }

  async find(tenant: TenantId, id: string): Promise<Nonconform | null> {
    const row = await this.prisma.nonconformRecord.findFirst({
      where: { tenantId: tenant, id },
    });
    return row === null ? null : rowToNonconform(row);
  }

  async list(tenant: TenantId, filter?: ListNonconformsFilter): Promise<readonly Nonconform[]> {
    const rows = await this.prisma.nonconformRecord.findMany({
      where: {
        tenantId: tenant,
        ...(filter?.state === undefined ? {} : { state: filter.state }),
        ...(filter?.inspectionId === undefined ? {} : { inspectionId: filter.inspectionId }),
      },
      orderBy: { createdAt: 'desc' }, // 新的在前（与内存实现同序）
    });
    return rows.map(rowToNonconform);
  }

  async advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: NonconformAdvanceExtra,
  ): Promise<Nonconform> {
    const updated = await this.prisma.nonconformRecord.updateMany({
      where: { tenantId: tenant, id, objectVersion: expectedObjectVersion },
      data: {
        state: nextState,
        objectVersion: nextObjectVersion,
        updatedAt: new Date(),
        ...(extra?.disposal === undefined ? {} : { disposal: extra.disposal }),
        ...(extra?.reason === undefined ? {} : { reason: extra.reason }),
        ...(extra?.disposeRemark === undefined ? {} : { disposeRemark: extra.disposeRemark }),
        ...(extra?.disposedBy === undefined ? {} : { disposedBy: extra.disposedBy }),
        ...(extra?.disposedAt === undefined ? {} : { disposedAt: isoToDate(extra.disposedAt, 'disposedAt') }),
        ...(extra?.closeRemark === undefined ? {} : { closeRemark: extra.closeRemark }),
        ...(extra?.closedBy === undefined ? {} : { closedBy: extra.closedBy }),
        ...(extra?.closedAt === undefined ? {} : { closedAt: isoToDate(extra.closedAt, 'closedAt') }),
      },
    });
    if (updated.count === 0) {
      const current = await this.prisma.nonconformRecord.findFirst({ where: { tenantId: tenant, id } });
      throw new InspectionConflictError(
        `不合格处置 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${current?.objectVersion ?? '不存在'}`,
      );
    }
    const row = await this.prisma.nonconformRecord.findFirstOrThrow({ where: { tenantId: tenant, id } });
    return rowToNonconform(row);
  }
}

// ---- 命令幂等记账 ----

export class PgInspectionOperationStore implements InspectionOperationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async record(entry: OperationRecord): Promise<OperationRecord | null> {
    try {
      await this.prisma.inspectionOperationRecord.create({
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

export class PgInspectionDomainEventStore implements InspectionDomainEventStore {
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
        throw new InspectionConflictError(`事件 '${row.eventId}' 已落账（eventId 幂等锚点）`);
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
    // 不存在即零行命中（与内存实现的 no-op 语义一致）。
    await this.prisma.outboxRecord.updateMany({
      where: { eventId },
      data: { deliveredAt: new Date(deliveredAt) },
    });
  }
}

// ---- 机器事件账本（engine-flow ApprovalEventStore → inspection_events） ----

/**
 * 租户解析：聚合锚定 = 投影行（见文件头取舍注释）。inspection-order →
 * inspections、nonconform → nonconformities；其余类型 / 不存在的聚合 =
 * 孤儿账目 fail-fast 拒写。
 */
async function tenantOfInspectionAggregate(
  prisma: PrismaClient,
  aggregate: { readonly id: string; readonly type: string },
): Promise<string> {
  if (aggregate.type === INSPECTION_AGGREGATE_TYPE) {
    const row = await prisma.inspectionOrderRecord.findUnique({ where: { id: aggregate.id } });
    if (row !== null) return row.tenantId;
  } else if (aggregate.type === NONCONFORM_AGGREGATE_TYPE) {
    const row = await prisma.nonconformRecord.findUnique({ where: { id: aggregate.id } });
    if (row !== null) return row.tenantId;
  }
  throw new Error(
    `inspection aggregate '${aggregate.type}:${aggregate.id}' 不存在于投影行：拒绝写入孤儿账目（聚合锚定合同 = inspections / nonconformities）`,
  );
}

export class PgInspectionMachineEventStore implements ApprovalEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: ApprovalEvent): Promise<void> {
    const tenantId = await tenantOfInspectionAggregate(this.prisma, event.aggregate);
    try {
      await this.prisma.inspectionEventRecord.create({
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
          throw new InspectionConflictError(
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
    const tenantId = await tenantOfInspectionAggregate(this.prisma, aggregate);
    const after = options?.afterCursor ?? 0;
    const rows = await this.prisma.inspectionEventRecord.findMany({
      where: {
        tenantId,
        aggregateId: aggregate.id,
        aggregateType: aggregate.type,
        seq: { gt: BigInt(after) },
      },
      orderBy: { seq: 'asc' },
    });
    return {
      events: rows.map(rowToInspectionEvent),
      nextCursor: rows.length === 0 ? null : Number(rows[rows.length - 1]!.seq),
    };
  }
}

// ---- 组合根装配工厂（惰性连接：同 ./workorder） ----

export interface InspectionStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/** 组合根装配句柄：五端口实现（可直接喂 InspectionModule.register）+ 优雅断连。 */
export interface InspectionStoreHandle {
  readonly orderStore: InspectionOrderStore;
  readonly nonconformStore: NonconformStore;
  readonly operationStore: InspectionOperationStore;
  readonly domainEventStore: InspectionDomainEventStore;
  readonly machineEventStore: ApprovalEventStore;
  disconnect(): Promise<void>;
}

/** 构造 inspection PG 存储装配（惰性连接：构造不握手，首查询才连库）。 */
export function connectInspectionStore(options: InspectionStoreOptions = {}): InspectionStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  // RLS session 接线（ESCALATION-2 收尾）：门控与机制/取舍见 ../rls-session.ts 文件头。
  const client = rlsSessionEnabled() ? withRlsTenantSession(prisma) : prisma;
  return {
    orderStore: new PgInspectionOrderStore(client),
    nonconformStore: new PgNonconformStore(client),
    operationStore: new PgInspectionOperationStore(client),
    domainEventStore: new PgInspectionDomainEventStore(client),
    machineEventStore: new PgInspectionMachineEventStore(client),
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}
