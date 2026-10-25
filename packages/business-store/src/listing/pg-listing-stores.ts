/**
 * listing 八端口的 PG 实现 + 组合根装配工厂（M2-W3，经本包 `./listing` 子路径
 * 导出——与 `./workorder` / `./baseline` 同模式：主入口保持零 @prisma/client
 * 依赖）。启动零 DB 依赖：connectListingStore 只构造 PrismaClient（惰性连接），
 * 无 DATABASE_URL 时组合根不调用本工厂。
 *
 * 八个实现（表 ↔ 端口分工见 prisma/schema.prisma listing 节与迁移头注）：
 *  - PgListingSheetStore         → listing_sheets 投影（(tenant, work_order_id, kind)
 *                                  唯一，P2002 → ListingConflictError）
 *  - PgListingLineStore          → listing_lines 投影（appendLines 批量插入行号唯一；
 *                                  update = object_version 条件更新，零行命中 → null）
 *  - PgGapCheckStore             → gap_checks 不可变快照（latest = checked_at DESC,
 *                                  seq DESC——seq bigserial 插入序是同毫秒决胜）
 *  - PgPurchaseRequestStore      → purchase_requests 投影（advance 乐观；linkOrder
 *                                  运营回填不推版本）
 *  - PgPurchaseOrderStore        → purchase_orders 投影（advance 可回填 lines/receipt_ref）
 *  - PgPurchaseReturnStore       → purchase_returns 投影（advance 乐观）
 *  - PgListingOperationStore     → listing_operations 幂等记账（PK=租户|operationId，
 *                                  P2002 = 已落账 → record 返回 null）
 *  - PgListingDomainEventStore   → 域事件 + Outbox 同事务落账（**复用既有
 *                                  event_records / outbox_records**，不建新表）
 *  - PgListingMachineEventStore  → engine-flow ApprovalEventStore（listing_events 账本；
 *                                  purchase-request / purchase-order / purchase-return
 *                                  三类聚合共用，(aggregate_id, aggregate_revision)
 *                                  唯一 = DB 级乐观锁）
 *  - PgProcessMaterialLinkStore  → process_material_links 工序×原材料关联投影
 *                                  （U4 S10 数据面：replaceSet 事务内删旧插新；
 *                                  (tenant, process_id) 组 UNIQUE 兜底并发）
 *
 * 租户解析取舍（同 workorder）：engine 机器事件端口不带租户参数——聚合锚定合同 =
 * 投影行（purchase_requests / purchase_orders / purchase_returns），租户经投影行
 * 解析（孤儿聚合 fail-fast 拒写）。域事件自带 tenantId，直落 event_records。
 *
 * 已知边界（共享账本既定取舍）：pendingOutbox/markDelivered 作用于全表
 * outbox_records——跨模块共享的投递记账由单例投递器统一扫（与 workorder 口径一致）。
 */
import { Prisma, PrismaClient } from '@prisma/client';
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
  GAP_CHECK_AUDIT_STATUS,
  PURCHASE_ORDER_AGGREGATE_TYPE,
  PURCHASE_REQUEST_AGGREGATE_TYPE,
  PURCHASE_RETURN_AGGREGATE_TYPE,
  ListingConflictError,
  type AppendGapCheckInput,
  type AppendListingLineInput,
  type CreateListingSheetInput,
  type CreatePurchaseOrderInput,
  type CreatePurchaseRequestInput,
  type CreatePurchaseReturnInput,
  type GapCheck,
  type GapCheckStore,
  type GapKindSummary,
  type GapLine,
  type ListingDomainEventStore,
  type ListingLine,
  type ListingLineStore,
  type ListingOperationRecord,
  type ListingOperationStore,
  type ListingSheet,
  type ListingSheetStore,
  type ListPurchaseOrdersFilter,
  type ListPurchaseRequestsFilter,
  type ProcessMaterialLink,
  type ProcessMaterialLinkStore,
  type PurchaseOrder,
  type PurchaseOrderLine,
  type PurchaseOrderStore,
  type PurchaseRequest,
  type PurchaseRequestStore,
  type PurchaseRequestSource,
  type PurchaseReturn,
  type PurchaseReturnLine,
  type PurchaseReturnStore,
  type ReplaceProcessMaterialSetInput,
  type UpdateListingLineFields,
} from '@smes/application';
import { fromBusinessEventRow, toBusinessEventRow } from '../events/event-row.js';
import { initialOutboxRow, toOutboxRecord } from '../events/outbox-row.js';

// ---- 小工具（同 workorder 体例） ----

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** 领域 JSON 载荷（对象或数组）→ Prisma JSON 输入。 */
function json(value: Readonly<Record<string, unknown>> | readonly unknown[]): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

// ---- 行 <-> 领域形状映射 ----

interface SheetDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly workOrderId: string;
  readonly kind: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function rowToListingSheet(row: SheetDbRow): ListingSheet {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    workOrderId: row.workOrderId,
    kind: row.kind as ListingSheet['kind'],
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface LineDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly sheetId: string;
  readonly workOrderId: string;
  readonly kind: string;
  readonly lineNo: number;
  readonly drawingNo: string | null;
  readonly code: string | null;
  readonly name: string | null;
  readonly spec: string | null;
  readonly itemId: string | null;
  readonly requiredQty: number;
  readonly neededBy: Date | null;
  readonly validationStatus: string;
  readonly candidateItemId: string | null;
  readonly candidateItemCode: string | null;
  readonly similarity: number;
  readonly basis: string | null;
  readonly source: string;
  readonly objectVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function rowToListingLine(row: LineDbRow): ListingLine {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    sheetId: row.sheetId,
    workOrderId: row.workOrderId,
    kind: row.kind as ListingLine['kind'],
    lineNo: row.lineNo,
    drawingNo: row.drawingNo,
    code: row.code,
    name: row.name,
    spec: row.spec,
    itemId: row.itemId,
    requiredQty: row.requiredQty,
    neededBy: row.neededBy === null ? null : row.neededBy.toISOString(),
    validationStatus: row.validationStatus as ListingLine['validationStatus'],
    candidateItemId: row.candidateItemId,
    candidateItemCode: row.candidateItemCode,
    similarity: row.similarity,
    basis: row.basis as ListingLine['basis'],
    source: row.source as ListingLine['source'],
    objectVersion: row.objectVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface GapCheckDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly workOrderId: string;
  readonly kinds: unknown;
  readonly gapLines: unknown;
  readonly complete: boolean;
  readonly checkedBy: string;
  readonly checkedAt: Date;
  readonly objectVersion: number;
  readonly auditStatus: string;
  readonly provenance: unknown;
  readonly supersedes: string | null;
  readonly businessTime: Date | null;
  readonly availableTime: Date | null;
}

export function rowToGapCheck(row: GapCheckDbRow): GapCheck {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    workOrderId: row.workOrderId,
    kinds: row.kinds as readonly GapKindSummary[],
    gapLines: row.gapLines as readonly GapLine[],
    complete: row.complete,
    checkedBy: UserId.create(row.checkedBy),
    checkedAt: row.checkedAt.toISOString(),
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

interface RequestDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly workOrderId: string | null;
  readonly kind: string;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly itemId: string;
  readonly quantity: number;
  readonly requester: string;
  readonly remark: string | null;
  readonly sourceType: string;
  readonly sourceGapCheckId: string | null;
  readonly sourceListingLineId: string | null;
  readonly purchaseOrderId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function rowToPurchaseRequest(row: RequestDbRow): PurchaseRequest {
  const source: PurchaseRequestSource =
    row.sourceType === 'gap' && row.sourceGapCheckId !== null && row.sourceListingLineId !== null
      ? { type: 'gap', gapCheckId: row.sourceGapCheckId, listingLineId: row.sourceListingLineId }
      : { type: 'manual' };
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    workOrderId: row.workOrderId,
    kind: row.kind as PurchaseRequest['kind'],
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    itemId: row.itemId,
    quantity: row.quantity,
    requester: UserId.create(row.requester),
    remark: row.remark,
    source,
    purchaseOrderId: row.purchaseOrderId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface OrderDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly workOrderId: string | null;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly supplierRef: string | null;
  readonly supplierName: string | null;
  readonly promisedAt: Date;
  readonly lines: unknown;
  readonly requestIds: unknown;
  readonly buyer: string | null;
  readonly remark: string | null;
  readonly receiptRef: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function rowToPurchaseOrder(row: OrderDbRow): PurchaseOrder {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    workOrderId: row.workOrderId,
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    supplierRef: row.supplierRef,
    supplierName: row.supplierName,
    promisedAt: row.promisedAt.toISOString(),
    lines: row.lines as readonly PurchaseOrderLine[],
    requestIds: row.requestIds as readonly string[],
    buyer: row.buyer === null ? null : UserId.create(row.buyer),
    remark: row.remark,
    receiptRef: row.receiptRef,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface ReturnDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly purchaseOrderId: string;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly lines: unknown;
  readonly returnedBy: string;
  readonly remark: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function rowToPurchaseReturn(row: ReturnDbRow): PurchaseReturn {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    purchaseOrderId: row.purchaseOrderId,
    flowConfigId: row.flowConfigId,
    state: row.state,
    objectVersion: row.objectVersion,
    lines: row.lines as readonly PurchaseReturnLine[],
    returnedBy: UserId.create(row.returnedBy),
    remark: row.remark,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface ListingEventDbRow {
  readonly seq: bigint;
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly aggregateRevision: number;
  readonly occurredAt: Date;
  readonly payload: unknown;
}

export function rowToListingEvent(row: ListingEventDbRow): ApprovalEvent {
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

// ---- 工序×原材料关联行（U4，application ProcessMaterialLinkStore） ----

interface ProcessMaterialDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly listingLineId: string;
  readonly processId: string;
  readonly sortOrder: number;
  readonly rawMaterialId: string;
  readonly quantity: number;
  readonly unitPriceMinor: number | null;
  readonly measureType: string;
  readonly partLength: number;
  readonly partWidth: number | null;
  readonly partHeight: number | null;
  readonly cutSizeForm: string;
  readonly cutSizeUnit: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function rowToProcessMaterialLink(row: ProcessMaterialDbRow): ProcessMaterialLink {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    listingLineId: row.listingLineId,
    processId: row.processId,
    sortOrder: row.sortOrder,
    rawMaterialId: row.rawMaterialId,
    quantity: row.quantity,
    unitPriceMinor: row.unitPriceMinor,
    measureType: row.measureType as ProcessMaterialLink['measureType'],
    partLength: row.partLength,
    partWidth: row.partWidth,
    partHeight: row.partHeight,
    cutSizeForm: row.cutSizeForm as ProcessMaterialLink['cutSizeForm'],
    cutSizeUnit: row.cutSizeUnit as ProcessMaterialLink['cutSizeUnit'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---- 清单单据头（application ListingSheetStore） ----

export class PgListingSheetStore implements ListingSheetStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateListingSheetInput): Promise<ListingSheet> {
    try {
      const row = await this.prisma.listingSheetRecord.create({
        data: {
          id: input.id,
          tenantId: input.tenant,
          workOrderId: input.workOrderId,
          kind: input.kind,
          name: input.name,
        },
      });
      return rowToListingSheet(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ListingConflictError(
          `工作令 '${input.workOrderId}' 的 ${input.kind} 清单已存在（(tenant, workOrderId, kind) 唯一）`,
        );
      }
      throw error;
    }
  }

  async find(tenant: TenantId, id: string): Promise<ListingSheet | null> {
    const row = await this.prisma.listingSheetRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : rowToListingSheet(row);
  }

  async listByWorkOrder(tenant: TenantId, workOrderId: string): Promise<readonly ListingSheet[]> {
    // kind 声明序在应用层排（PG 只按租户+工作令过滤；行数 = 四类量级，排序零开销）。
    const rows = await this.prisma.listingSheetRecord.findMany({
      where: { tenantId: tenant, workOrderId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(rowToListingSheet).sort((a, b) => a.kind.localeCompare(b.kind));
  }
}

// ---- 清单行（投影，乐观更新） ----

export class PgListingLineStore implements ListingLineStore {
  constructor(private readonly prisma: PrismaClient) {}

  async appendLines(inputs: readonly AppendListingLineInput[]): Promise<readonly ListingLine[]> {
    try {
      // 交互式事务：整批原子落（端口合同）；唯一冲突（id/行号）整批回滚。
      return await this.prisma.$transaction(async (tx) => {
        const rows: ListingLine[] = [];
        for (const input of inputs) {
          const row = await tx.listingLineRecord.create({
            data: {
              id: input.id,
              tenantId: input.tenant,
              sheetId: input.sheetId,
              workOrderId: input.workOrderId,
              kind: input.kind,
              lineNo: input.lineNo,
              drawingNo: input.drawingNo,
              code: input.code,
              name: input.name,
              spec: input.spec,
              itemId: input.itemId,
              requiredQty: input.requiredQty,
              neededBy: input.neededBy === null ? null : new Date(input.neededBy),
              validationStatus: input.validationStatus,
              candidateItemId: input.candidateItemId,
              candidateItemCode: input.candidateItemCode,
              similarity: input.similarity,
              basis: input.basis,
              source: input.source,
            },
          });
          rows.push(rowToListingLine(row));
        }
        return rows;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ListingConflictError('清单行插入冲突：id 已存在或 (清单, 行号) 唯一被违反');
      }
      throw error;
    }
  }

  async nextLineNo(tenant: TenantId, sheetId: string): Promise<number> {
    const row = await this.prisma.listingLineRecord.findFirst({
      where: { tenantId: tenant, sheetId },
      orderBy: { lineNo: 'desc' },
      select: { lineNo: true },
    });
    return row === null ? 1 : row.lineNo + 1;
  }

  async find(tenant: TenantId, id: string): Promise<ListingLine | null> {
    const row = await this.prisma.listingLineRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : rowToListingLine(row);
  }

  async listBySheet(tenant: TenantId, sheetId: string): Promise<readonly ListingLine[]> {
    const rows = await this.prisma.listingLineRecord.findMany({
      where: { tenantId: tenant, sheetId },
      orderBy: [{ lineNo: 'asc' }],
    });
    return rows.map(rowToListingLine);
  }

  async listByWorkOrder(tenant: TenantId, workOrderId: string): Promise<readonly ListingLine[]> {
    const rows = await this.prisma.listingLineRecord.findMany({
      where: { tenantId: tenant, workOrderId },
      orderBy: [{ kind: 'asc' }, { lineNo: 'asc' }],
    });
    return rows.map(rowToListingLine);
  }

  async update(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    fields: UpdateListingLineFields,
  ): Promise<ListingLine | null> {
    // 乐观更新：按 (tenant, id, object_version=expected) 条件更新，零行 = 版本不符或不存在。
    const updated = await this.prisma.listingLineRecord.updateMany({
      where: { tenantId: tenant, id, objectVersion: expectedObjectVersion },
      data: {
        ...(fields.drawingNo === undefined ? {} : { drawingNo: fields.drawingNo }),
        ...(fields.code === undefined ? {} : { code: fields.code }),
        ...(fields.name === undefined ? {} : { name: fields.name }),
        ...(fields.spec === undefined ? {} : { spec: fields.spec }),
        ...(fields.itemId === undefined ? {} : { itemId: fields.itemId }),
        ...(fields.requiredQty === undefined ? {} : { requiredQty: fields.requiredQty }),
        ...(fields.neededBy === undefined
          ? {}
          : { neededBy: fields.neededBy === null ? null : new Date(fields.neededBy) }),
        ...(fields.validationStatus === undefined ? {} : { validationStatus: fields.validationStatus }),
        ...(fields.candidateItemId === undefined ? {} : { candidateItemId: fields.candidateItemId }),
        ...(fields.candidateItemCode === undefined ? {} : { candidateItemCode: fields.candidateItemCode }),
        ...(fields.similarity === undefined ? {} : { similarity: fields.similarity }),
        ...(fields.basis === undefined ? {} : { basis: fields.basis }),
        objectVersion: expectedObjectVersion + 1,
        updatedAt: new Date(),
      },
    });
    if (updated.count === 0) return null;
    const row = await this.prisma.listingLineRecord.findFirstOrThrow({
      where: { tenantId: tenant, id },
    });
    return rowToListingLine(row);
  }
}

// ---- 缺口核查快照（不可变，append-only） ----

export class PgGapCheckStore implements GapCheckStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(input: AppendGapCheckInput): Promise<GapCheck> {
    const row = await this.prisma.gapCheckRecord.create({
      data: {
        id: input.id,
        tenantId: input.tenant,
        workOrderId: input.workOrderId,
        kinds: json(input.kinds as unknown as readonly unknown[]),
        gapLines: json(input.gapLines as unknown as readonly unknown[]),
        complete: input.complete,
        checkedBy: input.checkedBy,
        checkedAt: new Date(),
        objectVersion: 1,
        auditStatus: GAP_CHECK_AUDIT_STATUS,
        ...(input.provenance === undefined ? {} : { provenance: json(input.provenance) }),
      },
    });
    return rowToGapCheck(row);
  }

  async find(tenant: TenantId, id: string): Promise<GapCheck | null> {
    const row = await this.prisma.gapCheckRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : rowToGapCheck(row);
  }

  // "最新"口径 = (checked_at DESC, seq DESC)：同毫秒并列由 bigserial 插入序决胜。
  async latestByWorkOrder(tenant: TenantId, workOrderId: string): Promise<GapCheck | null> {
    const row = await this.prisma.gapCheckRecord.findFirst({
      where: { tenantId: tenant, workOrderId },
      orderBy: [{ checkedAt: 'desc' }, { seq: 'desc' }],
    });
    return row === null ? null : rowToGapCheck(row);
  }
}

// ---- 采购申请（投影） ----

export class PgPurchaseRequestStore implements PurchaseRequestStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreatePurchaseRequestInput): Promise<PurchaseRequest> {
    try {
      const row = await this.prisma.purchaseRequestRecord.create({
        data: {
          id: input.id,
          tenantId: input.tenant,
          workOrderId: input.workOrderId,
          kind: input.kind,
          flowConfigId: input.flowConfigId,
          state: input.state,
          objectVersion: input.objectVersion,
          itemId: input.itemId,
          quantity: input.quantity,
          requester: input.requester,
          remark: input.remark,
          sourceType: input.source.type,
          ...(input.source.type === 'gap'
            ? { sourceGapCheckId: input.source.gapCheckId, sourceListingLineId: input.source.listingLineId }
            : {}),
        },
      });
      return rowToPurchaseRequest(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ListingConflictError(`采购申请 '${input.id}' 已存在`);
      }
      throw error;
    }
  }

  async find(tenant: TenantId, id: string): Promise<PurchaseRequest | null> {
    const row = await this.prisma.purchaseRequestRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : rowToPurchaseRequest(row);
  }

  async list(tenant: TenantId, filter?: ListPurchaseRequestsFilter): Promise<readonly PurchaseRequest[]> {
    const rows = await this.prisma.purchaseRequestRecord.findMany({
      where: {
        tenantId: tenant,
        ...(filter?.state === undefined ? {} : { state: filter.state }),
        ...(filter?.workOrderId === undefined ? {} : { workOrderId: filter.workOrderId }),
        ...(filter?.purchaseOrderId === undefined ? {} : { purchaseOrderId: filter.purchaseOrderId }),
      },
      orderBy: { createdAt: 'desc' }, // 新的在前（与内存实现同序）
    });
    return rows.map(rowToPurchaseRequest);
  }

  async advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: { readonly purchaseOrderId?: string | null },
  ): Promise<PurchaseRequest> {
    const updated = await this.prisma.purchaseRequestRecord.updateMany({
      where: { tenantId: tenant, id, objectVersion: expectedObjectVersion },
      data: {
        state: nextState,
        objectVersion: nextObjectVersion,
        updatedAt: new Date(),
        ...(extra?.purchaseOrderId === undefined ? {} : { purchaseOrderId: extra.purchaseOrderId }),
      },
    });
    if (updated.count === 0) {
      const current = await this.prisma.purchaseRequestRecord.findFirst({ where: { tenantId: tenant, id } });
      throw new ListingConflictError(
        `采购申请 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${current?.objectVersion ?? '不存在'}`,
      );
    }
    const row = await this.prisma.purchaseRequestRecord.findFirstOrThrow({ where: { tenantId: tenant, id } });
    return rowToPurchaseRequest(row);
  }

  async linkOrder(tenant: TenantId, requestIds: readonly string[], purchaseOrderId: string): Promise<void> {
    await this.prisma.purchaseRequestRecord.updateMany({
      where: { tenantId: tenant, id: { in: [...requestIds] } },
      data: { purchaseOrderId, updatedAt: new Date() },
    });
  }
}

// ---- 采购订单（投影） ----

export class PgPurchaseOrderStore implements PurchaseOrderStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreatePurchaseOrderInput): Promise<PurchaseOrder> {
    try {
      const row = await this.prisma.purchaseOrderRecord.create({
        data: {
          id: input.id,
          tenantId: input.tenant,
          workOrderId: input.workOrderId,
          flowConfigId: input.flowConfigId,
          state: input.state,
          objectVersion: input.objectVersion,
          supplierRef: input.supplierRef,
          supplierName: input.supplierName,
          promisedAt: new Date(input.promisedAt),
          lines: json(input.lines as unknown as readonly unknown[]),
          requestIds: json(input.requestIds),
          buyer: input.buyer,
          remark: input.remark,
        },
      });
      return rowToPurchaseOrder(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ListingConflictError(`采购订单 '${input.id}' 已存在`);
      }
      throw error;
    }
  }

  async find(tenant: TenantId, id: string): Promise<PurchaseOrder | null> {
    const row = await this.prisma.purchaseOrderRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : rowToPurchaseOrder(row);
  }

  async list(tenant: TenantId, filter?: ListPurchaseOrdersFilter): Promise<readonly PurchaseOrder[]> {
    const rows = await this.prisma.purchaseOrderRecord.findMany({
      where: {
        tenantId: tenant,
        ...(filter?.state === undefined ? {} : { state: filter.state }),
        ...(filter?.workOrderId === undefined ? {} : { workOrderId: filter.workOrderId }),
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(rowToPurchaseOrder);
  }

  async advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: {
      readonly lines?: readonly PurchaseOrderLine[];
      readonly receiptRef?: string | null;
    },
  ): Promise<PurchaseOrder> {
    const updated = await this.prisma.purchaseOrderRecord.updateMany({
      where: { tenantId: tenant, id, objectVersion: expectedObjectVersion },
      data: {
        state: nextState,
        objectVersion: nextObjectVersion,
        updatedAt: new Date(),
        ...(extra?.lines === undefined ? {} : { lines: json(extra.lines as unknown as readonly unknown[]) }),
        ...(extra?.receiptRef === undefined ? {} : { receiptRef: extra.receiptRef }),
      },
    });
    if (updated.count === 0) {
      const current = await this.prisma.purchaseOrderRecord.findFirst({ where: { tenantId: tenant, id } });
      throw new ListingConflictError(
        `采购订单 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${current?.objectVersion ?? '不存在'}`,
      );
    }
    const row = await this.prisma.purchaseOrderRecord.findFirstOrThrow({ where: { tenantId: tenant, id } });
    return rowToPurchaseOrder(row);
  }
}

// ---- 退货单（投影） ----

export class PgPurchaseReturnStore implements PurchaseReturnStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreatePurchaseReturnInput): Promise<PurchaseReturn> {
    try {
      const row = await this.prisma.purchaseReturnRecord.create({
        data: {
          id: input.id,
          tenantId: input.tenant,
          purchaseOrderId: input.purchaseOrderId,
          flowConfigId: input.flowConfigId,
          state: input.state,
          objectVersion: input.objectVersion,
          lines: json(input.lines as unknown as readonly unknown[]),
          returnedBy: input.returnedBy,
          remark: input.remark,
        },
      });
      return rowToPurchaseReturn(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ListingConflictError(`退货单 '${input.id}' 已存在`);
      }
      throw error;
    }
  }

  async find(tenant: TenantId, id: string): Promise<PurchaseReturn | null> {
    const row = await this.prisma.purchaseReturnRecord.findFirst({ where: { tenantId: tenant, id } });
    return row === null ? null : rowToPurchaseReturn(row);
  }

  async listByOrder(tenant: TenantId, purchaseOrderId: string): Promise<readonly PurchaseReturn[]> {
    const rows = await this.prisma.purchaseReturnRecord.findMany({
      where: { tenantId: tenant, purchaseOrderId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(rowToPurchaseReturn);
  }

  async advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
  ): Promise<PurchaseReturn> {
    const updated = await this.prisma.purchaseReturnRecord.updateMany({
      where: { tenantId: tenant, id, objectVersion: expectedObjectVersion },
      data: { state: nextState, objectVersion: nextObjectVersion, updatedAt: new Date() },
    });
    if (updated.count === 0) {
      const current = await this.prisma.purchaseReturnRecord.findFirst({ where: { tenantId: tenant, id } });
      throw new ListingConflictError(
        `退货单 '${id}' 版本推进冲突：期望 ${expectedObjectVersion}，实际 ${current?.objectVersion ?? '不存在'}`,
      );
    }
    const row = await this.prisma.purchaseReturnRecord.findFirstOrThrow({ where: { tenantId: tenant, id } });
    return rowToPurchaseReturn(row);
  }
}

// ---- 命令幂等记账 ----

export class PgListingOperationStore implements ListingOperationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async record(entry: ListingOperationRecord): Promise<ListingOperationRecord | null> {
    try {
      await this.prisma.listingOperationRecord.create({
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

// ---- 工序×原材料关联（U4，整表替换投影） ----

export class PgProcessMaterialLinkStore implements ProcessMaterialLinkStore {
  constructor(private readonly prisma: PrismaClient) {}

  async replaceSet(input: ReplaceProcessMaterialSetInput): Promise<readonly ProcessMaterialLink[]> {
    try {
      // 交互式事务：整表替换原子落（删旧 + 按数组序插新，sortOrder 0..N-1）；
      // (tenant, process_id) 组 UNIQUE 兜底并发竞态（行序/原材料重复、跨清单行
      // 复用工序引用——冲突整批回滚）。
      return await this.prisma.$transaction(async (tx) => {
        await tx.processMaterialLinkRecord.deleteMany({
          where: { tenantId: input.tenant, listingLineId: input.listingLineId, processId: input.processId },
        });
        const rows: ProcessMaterialLink[] = [];
        for (const [sortOrder, row] of input.rows.entries()) {
          const created = await tx.processMaterialLinkRecord.create({
            data: {
              id: row.id,
              tenantId: input.tenant,
              listingLineId: input.listingLineId,
              processId: input.processId,
              sortOrder,
              rawMaterialId: row.rawMaterialId,
              quantity: row.quantity,
              unitPriceMinor: row.unitPriceMinor,
              measureType: row.measureType,
              partLength: row.partLength,
              partWidth: row.partWidth,
              partHeight: row.partHeight,
              cutSizeForm: row.cutSizeForm,
              cutSizeUnit: row.cutSizeUnit,
            },
          });
          rows.push(rowToProcessMaterialLink(created));
        }
        return rows;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ListingConflictError(
          `工序 '${input.processId}' 原材料关联插入冲突：(tenant, process) 行序/原材料唯一被违反（或同一工序引用被跨清单行复用）`,
        );
      }
      throw error;
    }
  }

  async listByProcess(
    tenant: TenantId,
    listingLineId: string,
    processId: string,
  ): Promise<readonly ProcessMaterialLink[]> {
    const rows = await this.prisma.processMaterialLinkRecord.findMany({
      where: { tenantId: tenant, listingLineId, processId },
      orderBy: [{ sortOrder: 'asc' }],
    });
    return rows.map(rowToProcessMaterialLink);
  }

  async listByLine(tenant: TenantId, listingLineId: string): Promise<readonly ProcessMaterialLink[]> {
    const rows = await this.prisma.processMaterialLinkRecord.findMany({
      where: { tenantId: tenant, listingLineId },
      orderBy: [{ processId: 'asc' }, { sortOrder: 'asc' }],
    });
    return rows.map(rowToProcessMaterialLink);
  }

  async findByProcessId(tenant: TenantId, processId: string): Promise<readonly ProcessMaterialLink[]> {
    const rows = await this.prisma.processMaterialLinkRecord.findMany({
      where: { tenantId: tenant, processId },
      orderBy: [{ listingLineId: 'asc' }, { sortOrder: 'asc' }],
    });
    return rows.map(rowToProcessMaterialLink);
  }
}

// ---- 域事件（BusinessEvent + Outbox，复用既有 event_records / outbox_records） ----

export class PgListingDomainEventStore implements ListingDomainEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: BusinessEvent): Promise<OutboxRecord> {
    const row = toBusinessEventRow(event);
    const outbox = initialOutboxRow(row.eventId, row.tenantId);
    try {
      await this.prisma.$transaction([
        this.prisma.businessEventRecord.create({
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
        }),
        this.prisma.outboxRecord.create({
          data: {
            eventId: outbox.eventId,
            tenantId: outbox.tenantId,
            createdAt: outbox.createdAt,
          },
        }),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ListingConflictError(`事件 '${row.eventId}' 已落账（eventId 幂等锚点）`);
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

// ---- 机器事件账本（engine-flow ApprovalEventStore → listing_events） ----

/**
 * 租户解析：聚合锚定 = 投影行（同 workorder 取舍）。purchase-request →
 * purchase_requests、purchase-order → purchase_orders、purchase-return →
 * purchase_returns；其余类型 / 不存在的聚合 = 孤儿账目 fail-fast 拒写。
 */
async function tenantOfListingAggregate(
  prisma: PrismaClient,
  aggregate: { readonly id: string; readonly type: string },
): Promise<string> {
  if (aggregate.type === PURCHASE_REQUEST_AGGREGATE_TYPE) {
    const row = await prisma.purchaseRequestRecord.findUnique({ where: { id: aggregate.id } });
    if (row !== null) return row.tenantId;
  } else if (aggregate.type === PURCHASE_ORDER_AGGREGATE_TYPE) {
    const row = await prisma.purchaseOrderRecord.findUnique({ where: { id: aggregate.id } });
    if (row !== null) return row.tenantId;
  } else if (aggregate.type === PURCHASE_RETURN_AGGREGATE_TYPE) {
    const row = await prisma.purchaseReturnRecord.findUnique({ where: { id: aggregate.id } });
    if (row !== null) return row.tenantId;
  }
  throw new Error(
    `listing aggregate '${aggregate.type}:${aggregate.id}' 不存在于投影行：拒绝写入孤儿账目（聚合锚定合同 = purchase_requests / purchase_orders / purchase_returns）`,
  );
}

export class PgListingMachineEventStore implements ApprovalEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: ApprovalEvent): Promise<void> {
    const tenantId = await tenantOfListingAggregate(this.prisma, event.aggregate);
    try {
      await this.prisma.listingEventRecord.create({
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
          throw new ListingConflictError(
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
    const tenantId = await tenantOfListingAggregate(this.prisma, aggregate);
    const after = options?.afterCursor ?? 0;
    const rows = await this.prisma.listingEventRecord.findMany({
      where: {
        tenantId,
        aggregateId: aggregate.id,
        aggregateType: aggregate.type,
        seq: { gt: BigInt(after) },
      },
      orderBy: { seq: 'asc' },
    });
    return {
      events: rows.map(rowToListingEvent),
      nextCursor: rows.length === 0 ? null : Number(rows[rows.length - 1]!.seq),
    };
  }
}

// ---- 组合根装配工厂（惰性连接：同 ./workorder） ----

export interface ListingStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/** 组合根装配句柄：八端口 + U4 工序×原材料关联端口实现（可直接喂 ListingModule.register）+ 优雅断连。 */
export interface ListingStoreHandle {
  readonly sheetStore: ListingSheetStore;
  readonly lineStore: ListingLineStore;
  readonly gapStore: GapCheckStore;
  readonly requestStore: PurchaseRequestStore;
  readonly orderStore: PurchaseOrderStore;
  readonly returnStore: PurchaseReturnStore;
  readonly operationStore: ListingOperationStore;
  readonly domainEventStore: ListingDomainEventStore;
  readonly machineEventStore: ApprovalEventStore;
  /** 工序×原材料关联存储（U4；喂 ListingModuleOptions.processMaterialStore）。 */
  readonly processMaterialStore: ProcessMaterialLinkStore;
  disconnect(): Promise<void>;
}

/** 构造 listing PG 存储装配（惰性连接：构造不握手，首查询才连库）。 */
export function connectListingStore(options: ListingStoreOptions = {}): ListingStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  return {
    sheetStore: new PgListingSheetStore(prisma),
    lineStore: new PgListingLineStore(prisma),
    gapStore: new PgGapCheckStore(prisma),
    requestStore: new PgPurchaseRequestStore(prisma),
    orderStore: new PgPurchaseOrderStore(prisma),
    returnStore: new PgPurchaseReturnStore(prisma),
    operationStore: new PgListingOperationStore(prisma),
    domainEventStore: new PgListingDomainEventStore(prisma),
    machineEventStore: new PgListingMachineEventStore(prisma),
    processMaterialStore: new PgProcessMaterialLinkStore(prisma),
    async disconnect(): Promise<void> {
      await prisma.$disconnect();
    },
  };
}
