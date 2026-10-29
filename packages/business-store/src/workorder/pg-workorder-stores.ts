import { PgWorkOrderEquipmentStore } from './pg-workorder-equipment-store.js';
import type { WorkOrderEquipmentStore } from '@smes/application';
/**
 * workorder 七端口的 PG 实现 + 组合根装配工厂（M2-W1，经本包 `./workorder`
 * 子路径导出——与 `./approval` / `./baseline` 同模式：主入口保持零 @prisma/client
 * 依赖）。启动零 DB 依赖：connectWorkOrderStore 只构造 PrismaClient（惰性连接），
 * 无 DATABASE_URL 时组合根不调用本工厂。
 *
 * 七个实现（表 ↔ 端口分工见 prisma/schema.prisma workorder 节与迁移头注）：
 *  - PgWorkOrderStore          → work_orders 投影行（advance = object_version
 *                                条件更新，零行命中 → WorkOrderConflictError）
 *  - PgPartsRequestStore       → parts_requests 投影行（同上；advance 可回填 shipment_ref）
 *  - PgWorkOrderAttachmentStore→ work_order_attachments 事实（append-only 触发器护栏）
 *  - PgKitCheckStore           → kit_checks 不可变快照（latest = refreshed_at DESC,
 *                                seq DESC——seq bigserial 插入序是同毫秒决胜）
 *  - PgWorkOrderOperationStore → workorder_operations 幂等记账（PK=租户|operationId，
 *                                P2002 = 已落账 → record 返回 null）
 *  - PgWorkOrderDomainEventStore → 域事件 + Outbox 同事务落账（**复用既有
 *                                event_records / outbox_records**，不建新表——迁移
 *                                设计如此；eventId 幂等锚点，P2002 → WorkOrderConflictError）
 *  - PgWorkOrderMachineEventStore→ engine-flow ApprovalEventStore（workorder_events
 *                                账本；work-order / parts-request 两类聚合共用，
 *                                (aggregate_id, aggregate_revision) 唯一 = DB 级乐观锁）
 *
 * 租户解析取舍：engine 机器事件端口不带租户参数——聚合锚定合同 = 投影行
 * （service 恒以 aggregate.type='work-order'/'parts-request'、aggregate.id=投影行 id
 * 写入），租户经 work_orders / parts_requests 行解析（孤儿聚合 fail-fast 拒写）。
 * 域事件（BusinessEvent）自带 tenantId，直落 event_records，无需解析。
 *
 * 已知边界（共享账本既定取舍）：pendingOutbox/markDelivered 作用于全表
 * outbox_records——跨模块共享的投递记账由单例投递器统一扫（本端口不含租户
 * 参数，与内存实现合同一致；联动验证按 eventId 过滤消费）。
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';
import { EventId, TenantId, UserId, WorkOrderId, type BusinessEvent, type OutboxRecord } from '@smes/business-core';
import {
  makeApprovalEvent,
  type ApprovalEvent,
  type ApprovalEventCursor,
  type ApprovalEventPage,
  type ApprovalEventPayload,
  type ApprovalEventStore,
} from '@smes/engine-flow';
import {
  ATTACHMENT_AUDIT_STATUS,
  KIT_CHECK_AUDIT_STATUS,
  PARTS_REQUEST_AGGREGATE_TYPE,
  WORK_ORDER_AGGREGATE_TYPE,
  WorkOrderConflictError,
  type AppendAttachmentInput,
  type AppendKitCheckInput,
  type CreatePartsRequestInput,
  type CreateWorkOrderInput,
  type KitCheck,
  type KitCheckKindSummaryPayload,
  type KitCheckLineGapPayload,
  type KitCheckStore,
  type ListPartsRequestsFilter,
  type ListWorkOrdersFilter,
  type OperationRecord,
  type PartsRequest,
  type PartsRequestStore,
  type UpdateWorkOrderFields,
  type WorkOrder,
  type WorkOrderAttachment,
  type WorkOrderAttachmentStore,
  type WorkOrderDomainEventStore,
  type WorkOrderOperationStore,
  type WorkOrderStore,
} from '@smes/application';
import { fromBusinessEventRow, toBusinessEventRow } from '../events/event-row.js';
import { initialOutboxRow, toOutboxRecord } from '../events/outbox-row.js';

// ---- 小工具（同 baseline 体例） ----

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** 领域 JSON 载荷（对象或数组）→ Prisma JSON 输入（结构同构，类型面窄化唯一换算点）。 */
function json(value: Readonly<Record<string, unknown>> | readonly unknown[]): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

// ---- 行 <-> 领域形状映射 ----

interface OrderDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly customerRef: string | null;
  readonly projectName: string;
  readonly salesRep: string | null;
  readonly manager: string | null;
  readonly plannedDeliveryAt: Date | null;
  readonly packagingArrivalAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function rowToWorkOrder(row: OrderDbRow): WorkOrder {
  return {
    id: WorkOrderId.create(row.id),
    tenant: TenantId.create(row.tenantId),
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    customerRef: row.customerRef,
    projectName: row.projectName,
    salesRep: row.salesRep === null ? null : UserId.create(row.salesRep),
    manager: row.manager === null ? null : UserId.create(row.manager),
    plannedDeliveryAt: row.plannedDeliveryAt === null ? null : row.plannedDeliveryAt.toISOString(),
    packagingArrivalAt: row.packagingArrivalAt === null ? null : row.packagingArrivalAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface PartsDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly workOrderId: string;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly itemId: string;
  readonly quantity: number;
  readonly requester: string;
  readonly remark: string | null;
  readonly shipmentRef: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function rowToPartsRequest(row: PartsDbRow): PartsRequest {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    workOrderId: WorkOrderId.create(row.workOrderId),
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    itemId: row.itemId,
    quantity: row.quantity,
    requester: UserId.create(row.requester),
    remark: row.remark,
    shipmentRef: row.shipmentRef,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface AttachmentDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly workOrderId: string;
  readonly name: string;
  readonly kind: string;
  readonly ref: string;
  readonly attachedBy: string;
  readonly attachedAt: Date;
  readonly objectVersion: number;
  readonly auditStatus: string;
  readonly provenance: unknown;
  readonly supersedes: string | null;
  readonly businessTime: Date | null;
  readonly availableTime: Date | null;
}

export function rowToAttachment(row: AttachmentDbRow): WorkOrderAttachment {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    workOrderId: WorkOrderId.create(row.workOrderId),
    name: row.name,
    kind: row.kind,
    ref: row.ref,
    attachedBy: UserId.create(row.attachedBy),
    attachedAt: row.attachedAt.toISOString(),
    objectVersion: row.objectVersion,
    auditStatus: row.auditStatus,
    ...(row.provenance === null || row.provenance === undefined
      ? {}
      : { provenance: row.provenance as Readonly<Record<string, unknown>> }),
    ...(row.supersedes === null ? {} : { supersedes: row.supersedes }),
    ...(row.businessTime === null ? {} : { businessTime: row.businessTime.toISOString() }),
    ...(row.availableTime === null ? {} : { availableTime: row.availableTime.toISOString() }),
  };
}

interface KitCheckDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly workOrderId: string;
  readonly kinds: unknown;
  readonly gapLines: unknown;
  readonly complete: boolean;
  readonly refreshedBy: string;
  readonly refreshedAt: Date;
  readonly objectVersion: number;
  readonly auditStatus: string;
  readonly provenance: unknown;
  readonly supersedes: string | null;
  readonly businessTime: Date | null;
  readonly availableTime: Date | null;
}

export function rowToKitCheck(row: KitCheckDbRow): KitCheck {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    workOrderId: WorkOrderId.create(row.workOrderId),
    kinds: row.kinds as readonly KitCheckKindSummaryPayload[],
    gapLines: row.gapLines as readonly KitCheckLineGapPayload[],
    complete: row.complete,
    refreshedBy: UserId.create(row.refreshedBy),
    refreshedAt: row.refreshedAt.toISOString(),
    objectVersion: row.objectVersion,
    auditStatus: row.auditStatus,
    ...(row.provenance === null || row.provenance === undefined
      ? {}
      : { provenance: row.provenance as Readonly<Record<string, unknown>> }),
    ...(row.supersedes === null ? {} : { supersedes: row.supersedes }),
    ...(row.businessTime === null ? {} : { businessTime: row.businessTime.toISOString() }),
    ...(row.availableTime === null ? {} : { availableTime: row.availableTime.toISOString() }),
  };
}

interface WorkorderEventDbRow {
  readonly seq: bigint;
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly aggregateRevision: number;
  readonly occurredAt: Date;
  readonly payload: unknown;
}

export function rowToWorkorderEvent(row: WorkorderEventDbRow): ApprovalEvent {
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

// ---- 工作令投影行（application WorkOrderStore） ----

export class PgWorkOrderStore implements WorkOrderStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateWorkOrderInput): Promise<WorkOrder> {
    try {
      const row = await this.prisma.workOrderProjectionRecord.create({
        data: {
          id: input.id,
          tenantId: input.tenant,
          flowConfigId: input.flowConfigId,
          state: input.state,
          objectVersion: input.objectVersion,
          customerRef: input.customerRef,
          projectName: input.projectName,
          salesRep: input.salesRep,
          manager: input.manager,
          plannedDeliveryAt: input.plannedDeliveryAt === null ? null : new Date(input.plannedDeliveryAt),
          packagingArrivalAt: input.packagingArrivalAt === null ? null : new Date(input.packagingArrivalAt),
        },
      });
      return rowToWorkOrder(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new WorkOrderConflictError(`工作令 '${input.id}' 已存在`);
      }
      throw error;
    }
  }

  async find(tenant: TenantId, id: WorkOrderId): Promise<WorkOrder | null> {
    const row = await this.prisma.workOrderProjectionRecord.findFirst({
      where: { tenantId: tenant, id },
    });
    return row === null ? null : rowToWorkOrder(row);
  }

  async list(tenant: TenantId, filter?: ListWorkOrdersFilter): Promise<readonly WorkOrder[]> {
    const rows = await this.prisma.workOrderProjectionRecord.findMany({
      where: { tenantId: tenant, ...(filter?.state === undefined ? {} : { state: filter.state }) },
      orderBy: { createdAt: 'desc' }, // 新的在前（与内存实现同序）
    });
    return rows.map(rowToWorkOrder);
  }

  async update(
    tenant: TenantId,
    id: WorkOrderId,
    fields: UpdateWorkOrderFields,
  ): Promise<WorkOrder | null> {
    // 端口合同：不存在 → null（404 语义由用例层翻译）；未提供的键不变。
    const existing = await this.prisma.workOrderProjectionRecord.findFirst({
      where: { tenantId: tenant, id },
    });
    if (existing === null) return null;
    const row = await this.prisma.workOrderProjectionRecord.update({
      where: { id },
      data: {
        ...(fields.customerRef === undefined ? {} : { customerRef: fields.customerRef }),
        ...(fields.projectName === undefined ? {} : { projectName: fields.projectName }),
        ...(fields.salesRep === undefined ? {} : { salesRep: fields.salesRep }),
        ...(fields.manager === undefined ? {} : { manager: fields.manager }),
        ...(fields.plannedDeliveryAt === undefined
          ? {}
          : { plannedDeliveryAt: fields.plannedDeliveryAt === null ? null : new Date(fields.plannedDeliveryAt) }),
        ...(fields.packagingArrivalAt === undefined
          ? {}
          : { packagingArrivalAt: fields.packagingArrivalAt === null ? null : new Date(fields.packagingArrivalAt) }),
      },
    });
    return rowToWorkOrder(row);
  }

  async advance(
    tenant: TenantId,
    id: WorkOrderId,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
  ): Promise<WorkOrder> {
    // 乐观推进：按 (tenant, id, object_version=expected) 条件更新，零行 = 版本不符或不存在。
    const updated = await this.prisma.workOrderProjectionRecord.updateMany({
      where: { tenantId: tenant, id, objectVersion: expectedObjectVersion },
      data: { state: nextState, objectVersion: nextObjectVersion, updatedAt: new Date() },
    });
    if (updated.count === 0) {
      const current = await this.prisma.workOrderProjectionRecord.findFirst({ where: { tenantId: tenant, id } });
      throw new WorkOrderConflictError(
        `工作令 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${current?.objectVersion ?? '不存在'}`,
      );
    }
    const row = await this.prisma.workOrderProjectionRecord.findFirstOrThrow({
      where: { tenantId: tenant, id },
    });
    return rowToWorkOrder(row);
  }
}

// ---- 附件事实（append-only） ----

export class PgWorkOrderAttachmentStore implements WorkOrderAttachmentStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(input: AppendAttachmentInput): Promise<WorkOrderAttachment> {
    const row = await this.prisma.workOrderAttachmentRecord.create({
      data: {
        id: input.id,
        tenantId: input.tenant,
        workOrderId: input.workOrderId,
        name: input.name,
        kind: input.kind,
        ref: input.ref,
        attachedBy: input.attachedBy,
        attachedAt: new Date(),
        objectVersion: 1,
        auditStatus: ATTACHMENT_AUDIT_STATUS,
        ...(input.provenance === undefined ? {} : { provenance: json(input.provenance) }),
      },
    });
    return rowToAttachment(row);
  }

  async listByWorkOrder(
    tenant: TenantId,
    workOrderId: WorkOrderId,
  ): Promise<readonly WorkOrderAttachment[]> {
    const rows = await this.prisma.workOrderAttachmentRecord.findMany({
      where: { tenantId: tenant, workOrderId },
      orderBy: [{ attachedAt: 'asc' }, { id: 'asc' }], // id=att-uuidv7 时间序，同毫秒稳定
    });
    return rows.map(rowToAttachment);
  }

  async find(tenant: TenantId, id: string): Promise<WorkOrderAttachment | null> {
    const row = await this.prisma.workOrderAttachmentRecord.findFirst({
      where: { tenantId: tenant, id },
    });
    return row === null ? null : rowToAttachment(row);
  }
}

// ---- 配件申请投影行 ----

export class PgPartsRequestStore implements PartsRequestStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreatePartsRequestInput): Promise<PartsRequest> {
    try {
      const row = await this.prisma.partsRequestRecord.create({
        data: {
          id: input.id,
          tenantId: input.tenant,
          workOrderId: input.workOrderId,
          flowConfigId: input.flowConfigId,
          state: input.state,
          objectVersion: input.objectVersion,
          itemId: input.itemId,
          quantity: input.quantity,
          requester: input.requester,
          remark: input.remark,
        },
      });
      return rowToPartsRequest(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new WorkOrderConflictError(`配件申请 '${input.id}' 已存在`);
      }
      throw error;
    }
  }

  async find(tenant: TenantId, id: string): Promise<PartsRequest | null> {
    const row = await this.prisma.partsRequestRecord.findFirst({
      where: { tenantId: tenant, id },
    });
    return row === null ? null : rowToPartsRequest(row);
  }

  async list(tenant: TenantId, filter?: ListPartsRequestsFilter): Promise<readonly PartsRequest[]> {
    const rows = await this.prisma.partsRequestRecord.findMany({
      where: {
        tenantId: tenant,
        ...(filter?.state === undefined ? {} : { state: filter.state }),
        ...(filter?.workOrderId === undefined ? {} : { workOrderId: filter.workOrderId }),
      },
      orderBy: { createdAt: 'desc' }, // 新的在前（与内存实现同序）
    });
    return rows.map(rowToPartsRequest);
  }

  async advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: { readonly shipmentRef?: string | null },
  ): Promise<PartsRequest> {
    const updated = await this.prisma.partsRequestRecord.updateMany({
      where: { tenantId: tenant, id, objectVersion: expectedObjectVersion },
      data: {
        state: nextState,
        objectVersion: nextObjectVersion,
        updatedAt: new Date(),
        ...(extra?.shipmentRef === undefined ? {} : { shipmentRef: extra.shipmentRef }),
      },
    });
    if (updated.count === 0) {
      const current = await this.prisma.partsRequestRecord.findFirst({ where: { tenantId: tenant, id } });
      throw new WorkOrderConflictError(
        `配件申请 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${current?.objectVersion ?? '不存在'}`,
      );
    }
    const row = await this.prisma.partsRequestRecord.findFirstOrThrow({
      where: { tenantId: tenant, id },
    });
    return rowToPartsRequest(row);
  }
}

// ---- 齐套快照（不可变，append-only） ----

export class PgKitCheckStore implements KitCheckStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(input: AppendKitCheckInput): Promise<KitCheck> {
    const row = await this.prisma.kitCheckRecord.create({
      data: {
        id: input.id,
        tenantId: input.tenant,
        workOrderId: input.workOrderId,
        kinds: json(input.kinds as unknown as readonly unknown[]),
        gapLines: json(input.gapLines as unknown as readonly unknown[]),
        complete: input.complete,
        refreshedBy: input.refreshedBy,
        refreshedAt: new Date(),
        objectVersion: 1,
        auditStatus: KIT_CHECK_AUDIT_STATUS,
        ...(input.provenance === undefined ? {} : { provenance: json(input.provenance) }),
      },
    });
    return rowToKitCheck(row);
  }

  // "最新"口径 = (refreshed_at DESC, seq DESC)：同毫秒并列由 bigserial 插入序决胜
  // （毫秒时钟与 uuidv7 随机位都不构成可靠并列序——见 schema.kit_checks 注释）。
  async latestByWorkOrder(tenant: TenantId, workOrderId: WorkOrderId): Promise<KitCheck | null> {
    const row = await this.prisma.kitCheckRecord.findFirst({
      where: { tenantId: tenant, workOrderId },
      orderBy: [{ refreshedAt: 'desc' }, { seq: 'desc' }],
    });
    return row === null ? null : rowToKitCheck(row);
  }

  /** 看板：每工作令最新一条。全局降序扫一遍、首个命中即该令最新（结果天然 refreshedAt 降序）。 */
  async latestPerTenant(tenant: TenantId): Promise<readonly KitCheck[]> {
    const rows = await this.prisma.kitCheckRecord.findMany({
      where: { tenantId: tenant },
      orderBy: [{ refreshedAt: 'desc' }, { seq: 'desc' }],
    });
    const seen = new Set<string>();
    const latest: KitCheck[] = [];
    for (const row of rows) {
      if (seen.has(row.workOrderId)) continue;
      seen.add(row.workOrderId);
      latest.push(rowToKitCheck(row));
    }
    return latest;
  }
}

// ---- 命令幂等记账 ----

export class PgWorkOrderOperationStore implements WorkOrderOperationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async record(entry: OperationRecord): Promise<OperationRecord | null> {
    try {
      await this.prisma.workorderOperationRecord.create({
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

export class PgWorkOrderDomainEventStore implements WorkOrderDomainEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: BusinessEvent): Promise<OutboxRecord> {
    const row = toBusinessEventRow(event);
    const outbox = initialOutboxRow(row.eventId, row.tenantId);
    try {
      // 交互式事务（共享 tx 句柄）：event+outbox 同事务原子双写。
      // RLS=on 时由 rlsTenantSession 扩展接管（回调前同句柄 SET，钩子同句柄重派）；
      // RLS=off 时即原生交互式事务——两种形态原子性等价。
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
        throw new WorkOrderConflictError(`事件 '${row.eventId}' 已落账（eventId 幂等锚点）`);
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

// ---- 机器事件账本（engine-flow ApprovalEventStore → workorder_events） ----

/**
 * 租户解析：聚合锚定 = 投影行（见文件头取舍注释）。work-order → work_orders、
 * parts-request → parts_requests；其余类型 / 不存在的聚合 = 孤儿账目 fail-fast 拒写。
 */
async function tenantOfWorkorderAggregate(
  prisma: PrismaClient,
  aggregate: { readonly id: string; readonly type: string },
): Promise<string> {
  if (aggregate.type === WORK_ORDER_AGGREGATE_TYPE) {
    const row = await prisma.workOrderProjectionRecord.findUnique({ where: { id: aggregate.id } });
    if (row !== null) return row.tenantId;
  } else if (aggregate.type === PARTS_REQUEST_AGGREGATE_TYPE) {
    const row = await prisma.partsRequestRecord.findUnique({ where: { id: aggregate.id } });
    if (row !== null) return row.tenantId;
  }
  throw new Error(
    `workorder aggregate '${aggregate.type}:${aggregate.id}' 不存在于投影行：拒绝写入孤儿账目（聚合锚定合同 = work_orders / parts_requests）`,
  );
}

export class PgWorkOrderMachineEventStore implements ApprovalEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: ApprovalEvent): Promise<void> {
    const tenantId = await tenantOfWorkorderAggregate(this.prisma, event.aggregate);
    try {
      await this.prisma.workorderEventRecord.create({
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
          throw new WorkOrderConflictError(
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
    const tenantId = await tenantOfWorkorderAggregate(this.prisma, aggregate);
    const after = options?.afterCursor ?? 0;
    const rows = await this.prisma.workorderEventRecord.findMany({
      where: {
        tenantId,
        aggregateId: aggregate.id,
        aggregateType: aggregate.type,
        seq: { gt: BigInt(after) },
      },
      orderBy: { seq: 'asc' },
    });
    return {
      events: rows.map(rowToWorkorderEvent),
      nextCursor: rows.length === 0 ? null : Number(rows[rows.length - 1]!.seq),
    };
  }
}

// ---- 组合根装配工厂（惰性连接：同 ./approval） ----

export interface WorkOrderStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/** 组合根装配句柄：七端口实现（可直接喂 WorkOrderModule.register）+ 优雅断连。 */
export interface WorkOrderStoreHandle {
  readonly equipmentStore: WorkOrderEquipmentStore;
  readonly orderStore: WorkOrderStore;
  readonly attachmentStore: WorkOrderAttachmentStore;
  readonly partsStore: PartsRequestStore;
  readonly kitStore: KitCheckStore;
  readonly operationStore: WorkOrderOperationStore;
  readonly domainEventStore: WorkOrderDomainEventStore;
  readonly machineEventStore: ApprovalEventStore;
  disconnect(): Promise<void>;
}

/** 构造 workorder PG 存储装配（惰性连接：构造不握手，首查询才连库）。 */
export function connectWorkOrderStore(options: WorkOrderStoreOptions = {}): WorkOrderStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  // RLS session 接线（ESCALATION-2 收尾）：门控与机制/取舍见 ../rls-session.ts 文件头。
  const client = withRlsTenantSession(prisma, { session: rlsSessionEnabled() });
  return {
    equipmentStore: new PgWorkOrderEquipmentStore(client),
    orderStore: new PgWorkOrderStore(client),
    attachmentStore: new PgWorkOrderAttachmentStore(client),
    partsStore: new PgPartsRequestStore(client),
    kitStore: new PgKitCheckStore(client),
    operationStore: new PgWorkOrderOperationStore(client),
    domainEventStore: new PgWorkOrderDomainEventStore(client),
    machineEventStore: new PgWorkOrderMachineEventStore(client),
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}
