/**
 * listing 存储端口（M2-W3）。体例同 workorder-stores：端口在本包定义业务
 * 形状，内存实现先行（in-memory-listing-stores.ts），PG adapter 由
 * business-store 按 `./listing` 子路径接入（表结构见 prisma/migrations/
 * *_listing_module——组合根接线属总控合流）。
 *
 * 表形态取舍（对齐 workorder 六表的既定裁定，依据 evidence-columns.v1 +
 * m2-drafts README 纪律 2）：
 *  - listing_sheets / listing_lines / purchase_requests / purchase_orders /
 *    purchase_returns 是**投影**（运营状态，可 UPDATE，行级乐观版本）——不套
 *    证据公共列；清单行为版本化数据（校验状态字段 + objectVersion，非状态机，
 *    03-listing.md §2）；
 *  - gap_checks 是**业务事实**（不可变快照，证据七公共列齐备：id/objectVersion/
 *    auditStatus/provenance/supersedes/businessTime/availableTime）；
 *  - listing_events 是**状态机事件账本**（engine-flow ApprovalEventStore 形状，
 *    purchase-request / purchase-order / purchase-return 三类聚合共用）；
 *  - listing_operations 是**幂等记账**（运营表，同 outbox 取舍豁免触发器）；
 *  - 域事件（BusinessEvent 形状）落既有通用 event_records + outbox_records
 *    （M1 已建）——本包端口按 BusinessEvent 定形，Outbox 记账随 append 原子产生。
 */
import type {
  BusinessEvent,
  EventId,
  OutboxRecord,
  TenantId,
  UserId,
} from '@smes/business-core';
import type { ListingKind, PurchaseRequestKind } from './listing-config.js';
import type { ExcelParseIssue } from './excel-port.js';

// ---- 清单单据头（投影） ----

/** 清单单据头：一工作令 × 一 kind 一张（(tenant, workOrderId, kind) 唯一）。 */
export interface ListingSheet {
  /** ls-<uuidv7>（模块 id 生成器；存储面按不透明串收）。 */
  readonly id: string;
  readonly tenant: TenantId;
  /** 所属工作令（跨模块 opaque id）。 */
  readonly workOrderId: string;
  readonly kind: ListingKind;
  /** 清单名（缺省 = 类目中文名 + 工作令尾号，展示用）。 */
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateListingSheetInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly workOrderId: string;
  readonly kind: ListingKind;
  readonly name: string;
}

/**
 * 清单存储端口。实现方保证：create 在 (tenant, workOrderId, kind) 重复时抛
 * ListingConflictError；listByWorkOrder 按 kind 声明序返回；读按租户收口。
 */
export interface ListingSheetStore {
  create(input: CreateListingSheetInput): Promise<ListingSheet>;
  find(tenant: TenantId, id: string): Promise<ListingSheet | null>;
  listByWorkOrder(tenant: TenantId, workOrderId: string): Promise<readonly ListingSheet[]>;
}

// ---- 清单行（投影，版本化数据 + 校验状态字段） ----

/** 清单行校验状态：pending=未校验；matched/suspected/unmatched = 物料校验三判定。 */
export type ListingLineValidationStatus = 'pending' | 'matched' | 'suspected' | 'unmatched';

/** 校验依据（镜像 baseline MaterialJudgmentBasis 词汇，跨模块不引类型）。 */
export type ListingLineJudgmentBasis = 'code-exact' | 'name-and-spec' | 'none';

/** 清单行来源：workorder=建骨架时事件携带行（预留）；excel=导入；manual=行级补录。 */
export type ListingLineSource = 'workorder' | 'excel' | 'manual';

/** 清单行（一行 = 图号 + 物料三要素 + 数量 + 需求日期 + 校验状态）。 */
export interface ListingLine {
  readonly equipmentRef?: string | null;
  readonly origin?: 'production' | 'aftermarket';
  /** ll-<uuidv7>。 */
  readonly id: string;
  readonly tenant: TenantId;
  readonly sheetId: string;
  readonly workOrderId: string;
  readonly kind: ListingKind;
  /** 行号（清单内 1 起递增；同清单唯一）。 */
  readonly lineNo: number;
  readonly drawingNo: string | null;
  /** 物料三要素原文（导入/录入原样，校验不覆写）。 */
  readonly code: string | null;
  readonly name: string | null;
  readonly spec: string | null;
  /** 确认物料 id（校验 matched 自动落或人工确认；可空）。 */
  readonly itemId: string | null;
  readonly requiredQty: number;
  /** 需求日期（ISO 8601，可空）。 */
  readonly neededBy: string | null;
  readonly validationStatus: ListingLineValidationStatus;
  /** 校验候选（suspected/matched 携带；pending/unmatched 为 null）。 */
  readonly candidateItemId: string | null;
  readonly candidateItemCode: string | null;
  /** 规格相似度 0~1（判定证据，对账锚点）。 */
  readonly similarity: number;
  readonly basis: ListingLineJudgmentBasis | null;
  readonly source: ListingLineSource;
  /** 行级数据版本：创建 = 1，每次成功更新 +1（乐观锁口径）。 */
  readonly objectVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AppendListingLineInput {
  readonly equipmentRef?: string | null;
  readonly origin?: 'production' | 'aftermarket';
  readonly tenant: TenantId;
  readonly id: string;
  readonly sheetId: string;
  readonly workOrderId: string;
  readonly kind: ListingKind;
  readonly lineNo: number;
  readonly drawingNo: string | null;
  readonly code: string | null;
  readonly name: string | null;
  readonly spec: string | null;
  readonly itemId: string | null;
  readonly requiredQty: number;
  readonly neededBy: string | null;
  readonly validationStatus: ListingLineValidationStatus;
  readonly candidateItemId: string | null;
  readonly candidateItemCode: string | null;
  readonly similarity: number;
  readonly basis: ListingLineJudgmentBasis | null;
  readonly source: ListingLineSource;
}

/** 行级更新（未提供的键不变；改物料三要素 → service 附加校验重置列，见其注释）。 */
export interface UpdateListingLineFields {
  readonly equipmentRef?: string | null;
  readonly origin?: 'production' | 'aftermarket';
  readonly drawingNo?: string | null;
  readonly code?: string | null;
  readonly name?: string | null;
  readonly spec?: string | null;
  readonly itemId?: string | null;
  readonly requiredQty?: number;
  readonly neededBy?: string | null;
  /** 校验重置列（service 计算：物料三要素变更时置 pending 并清候选；通常不外部传入）。 */
  readonly validationStatus?: ListingLineValidationStatus;
  readonly candidateItemId?: string | null;
  readonly candidateItemCode?: string | null;
  readonly similarity?: number;
  readonly basis?: ListingLineJudgmentBasis | null;
}

/**
 * 清单行存储端口。实现方保证：
 *  - appendLines 原子落整批（含 lineNo 唯一性；冲突抛 ListingConflictError），
 *    返回完整行集；
 *  - nextLineNo(tenant, sheetId) 给下一行号（导入续行口径）；
 *  - update 为乐观更新：仅当 objectVersion === expectedObjectVersion 时写字段并
 *    +1 版本；未命中（不存在/版本不符）返回 null——用例层按"存在但版本不符 →
 *    rejected 乐观锁"与"不存在 → rejected 404 语义"分叉（先 find 再 update）。
 */
export interface ListingLineStore {
  appendLines(inputs: readonly AppendListingLineInput[]): Promise<readonly ListingLine[]>;
  nextLineNo(tenant: TenantId, sheetId: string): Promise<number>;
  find(tenant: TenantId, id: string): Promise<ListingLine | null>;
  listBySheet(tenant: TenantId, sheetId: string): Promise<readonly ListingLine[]>;
  listByWorkOrder(tenant: TenantId, workOrderId: string): Promise<readonly ListingLine[]>;
  /**
   * 下图统计（A9，工作令-下图统计-开发文档）：租户内**零件清单（kind='part'）**
   * 明细行按行创建时间（createdAt）计数——不去重图号、不按工作令/设备拆分；
   * create_time 为空的行不计入。range 为 yyyy-MM-dd **闭区间**（比较 createdAt
   * 日部），两端均可缺省（缺省不滤该侧；仅传一侧=半开区间）。实现方做计数
   * 而非取行（PG 侧 count 查询，勿 SELECT * 内存数）。可选成员：内存实现已
   * 备；PG 适配器（business-store）合流时补实现——未实现时 service 显式拒绝
   * （不静默回 0，体例同 LISTING_UNWIRED_MATERIAL_VALIDATION）。
   */
  countPartLinesCreatedBetween?(
    tenant: TenantId,
    range?: { readonly fromDay?: string; readonly toDay?: string },
  ): Promise<number>;
  update(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    fields: UpdateListingLineFields,
  ): Promise<ListingLine | null>;
}

// ---- 缺口核查（不可变快照，业务事实） ----

/**
 * 缺口行（需求 vs 利库供给基数的差集行；一键采购的发起锚点）。
 * availableQty = 跨仓可用 + 本令 issue 订单级锚活跃预占（利库预占接线后口径：
 * 本令已预占仍属本令可供给，重复核查不自我挤占；未接线 = 纯可用量）。
 */
export interface GapLine {
  readonly kind: ListingKind;
  readonly listingLineId: string;
  readonly itemId: string;
  readonly drawingNo: string | null;
  readonly requiredQty: number;
  readonly availableQty: number;
  readonly gapQty: number;
  readonly neededBy: string | null;
}

/** 类目汇总行。 */
export interface GapKindSummary {
  readonly kind: ListingKind;
  /** 类目内全部行数。 */
  readonly lineCount: number;
  /** 进入核查的行数（itemId 已解析的行；未校验行不入差集）。 */
  readonly checkedLineCount: number;
  readonly gapLineCount: number;
  /** 类目内无缺口行且确有清单行——0 行类目恒 false（空清单不判齐套，读面显示"无清单行"）。 */
  readonly complete: boolean;
}

/** 缺口核查快照（每次核查一条，不可变）。 */
export interface GapCheck {
  readonly id: string;
  readonly tenant: TenantId;
  readonly workOrderId: string;
  readonly kinds: readonly GapKindSummary[];
  readonly gapLines: readonly GapLine[];
  readonly complete: boolean;
  readonly checkedBy: UserId;
  readonly checkedAt: string;
  // ---- 证据公共列（evidence-columns.v1） ----
  readonly objectVersion: number;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly supersedes?: string;
  readonly businessTime?: string;
  readonly availableTime?: string;
}

export interface AppendGapCheckInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly workOrderId: string;
  readonly kinds: readonly GapKindSummary[];
  readonly gapLines: readonly GapLine[];
  readonly complete: boolean;
  readonly checkedBy: UserId;
  readonly provenance?: Readonly<Record<string, unknown>>;
}

/**
 * 缺口快照存储端口：append-only；latestByWorkOrder 取该工作令最新一条
 * （checkedAt 降序，同毫秒插入序决胜——内存/PG 同口径）。
 */
export interface GapCheckStore {
  append(input: AppendGapCheckInput): Promise<GapCheck>;
  find(tenant: TenantId, id: string): Promise<GapCheck | null>;
  latestByWorkOrder(tenant: TenantId, workOrderId: string): Promise<GapCheck | null>;
}

// ---- 采购申请（投影，三态机） ----

/** 采购申请来源：gap=清单缺口一键；manual=手工。 */
export type PurchaseRequestSource =
  | { readonly type: 'gap'; readonly gapCheckId: string; readonly listingLineId: string }
  | { readonly type: 'manual' };

/** 采购申请（三类 kind；draft→approved→converted，推进口径见 listing-config 头注）。 */
export interface PurchaseRequest {
  /** preq-<uuidv7>。 */
  readonly id: string;
  readonly tenant: TenantId;
  readonly workOrderId: string | null;
  readonly kind: PurchaseRequestKind;
  readonly flowConfigId: string;
  /** draft/approved/converted。 */
  readonly state: string;
  /** 状态机版本：创建 = 1（初始态无机器事件），每次迁移 +1。 */
  readonly objectVersion: number;
  readonly itemId: string;
  readonly quantity: number;
  readonly requester: UserId;
  readonly remark: string | null;
  readonly source: PurchaseRequestSource;
  /** 转单回填：承接订单 id（submit 时回填，不推进版本）。 */
  readonly purchaseOrderId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatePurchaseRequestInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly workOrderId: string | null;
  readonly kind: PurchaseRequestKind;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly itemId: string;
  readonly quantity: number;
  readonly requester: UserId;
  readonly remark: string | null;
  readonly source: PurchaseRequestSource;
}

export interface ListPurchaseRequestsFilter {
  readonly state?: string | undefined;
  readonly workOrderId?: string | undefined;
  readonly purchaseOrderId?: string | undefined;
}

/** 采购申请存储端口（租户收口 + 乐观 advance + 降序列表；linkOrder 不推版本）。 */
export interface PurchaseRequestStore {
  create(input: CreatePurchaseRequestInput): Promise<PurchaseRequest>;
  find(tenant: TenantId, id: string): Promise<PurchaseRequest | null>;
  list(tenant: TenantId, filter?: ListPurchaseRequestsFilter): Promise<readonly PurchaseRequest[]>;
  advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: { readonly purchaseOrderId?: string | null },
  ): Promise<PurchaseRequest>;
  /** 转单回填（submit 时批量；运营回填不推进状态机版本）。 */
  linkOrder(tenant: TenantId, requestIds: readonly string[], purchaseOrderId: string): Promise<void>;
}

// ---- 采购订单（投影，五态机） ----

/** 订单明细行（数量/单价/已收数量——金额汇总口径 = Σ receivedQty × unitPriceMinor）。 */
export interface PurchaseOrderLine {
  readonly lineNo: number;
  readonly itemId: string;
  readonly drawingNo: string | null;
  /** 订购数量（正数）。 */
  readonly quantity: number;
  /** 单价（分，整数精确；可空=未定价）。 */
  readonly unitPriceMinor: number | null;
  /** 已收数量（receive 回填；退货回退后按重新收货覆盖）。 */
  readonly receivedQty: number;
}

/** 采购订单（五态 draft→submitted→approved→issued→received，+退货回退）。 */
export interface PurchaseOrder {
  /** po-<uuidv7>。 */
  readonly id: string;
  readonly tenant: TenantId;
  readonly workOrderId: string | null;
  readonly flowConfigId: string;
  readonly state: string;
  /** 状态机版本：建单+SUBMIT = 2，此后每次迁移 +1（回退也 +1）。 */
  readonly objectVersion: number;
  readonly supplierRef: string | null;
  readonly supplierName: string | null;
  /** 交期（ISO 8601，必填——逾期事实口径锚点）。 */
  readonly promisedAt: string;
  readonly lines: readonly PurchaseOrderLine[];
  /** 来源申请集（订单承接的采购申请）。 */
  readonly requestIds: readonly string[];
  /** 采购负责人（逾期催货待办指派对象；可空）。 */
  readonly buyer: UserId | null;
  readonly remark: string | null;
  /** 收货单号（receive 回填；opaque）。 */
  readonly receiptRef: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatePurchaseOrderInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly workOrderId: string | null;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly supplierRef: string | null;
  readonly supplierName: string | null;
  readonly promisedAt: string;
  readonly lines: readonly PurchaseOrderLine[];
  readonly requestIds: readonly string[];
  readonly buyer: UserId | null;
  readonly remark: string | null;
}

export interface ListPurchaseOrdersFilter {
  readonly state?: string | undefined;
  readonly workOrderId?: string | undefined;
}

/** 采购订单存储端口（租户收口 + 乐观 advance；advance 可回填 lines/receiptRef）。 */
export interface PurchaseOrderStore {
  create(input: CreatePurchaseOrderInput): Promise<PurchaseOrder>;
  find(tenant: TenantId, id: string): Promise<PurchaseOrder | null>;
  list(tenant: TenantId, filter?: ListPurchaseOrdersFilter): Promise<readonly PurchaseOrder[]>;
  advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: {
      readonly lines?: readonly PurchaseOrderLine[];
      readonly receiptRef?: string | null;
    },
  ): Promise<PurchaseOrder>;
}

// ---- 退货单（投影，两态机） ----

/** 退货行（按订单行回退数量）。 */
export interface PurchaseReturnLine {
  readonly lineNo: number;
  readonly itemId: string;
  /** 退货数量（>0，≤ 该行已收数量）。 */
  readonly returnedQty: number;
  readonly reason: string | null;
}

/** 退货单（收货异常撤回/退货；open→revoked）。 */
export interface PurchaseReturn {
  /** prt-<uuidv7>。 */
  readonly id: string;
  readonly tenant: TenantId;
  readonly purchaseOrderId: string;
  readonly flowConfigId: string;
  /** open/revoked。 */
  readonly state: string;
  /** 状态机版本：创建 = 1（初始态无机器事件），REVOKE 后 = 2。 */
  readonly objectVersion: number;
  readonly lines: readonly PurchaseReturnLine[];
  readonly returnedBy: UserId;
  readonly remark: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatePurchaseReturnInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly purchaseOrderId: string;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly lines: readonly PurchaseReturnLine[];
  readonly returnedBy: UserId;
  readonly remark: string | null;
}

/** 退货单存储端口（租户收口 + 乐观 advance + 按订单过滤列表）。 */
export interface PurchaseReturnStore {
  create(input: CreatePurchaseReturnInput): Promise<PurchaseReturn>;
  find(tenant: TenantId, id: string): Promise<PurchaseReturn | null>;
  listByOrder(tenant: TenantId, purchaseOrderId: string): Promise<readonly PurchaseReturn[]>;
  advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
  ): Promise<PurchaseReturn>;
}

// ---- 命令幂等记账 ----

export interface ListingOperationRecord {
  readonly tenant: TenantId;
  readonly operationId: string;
  /** 命令动词（listing / gap / purchase 命名族）。 */
  readonly command: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly occurredAt: string;
}

/**
 * 命令幂等记账端口（smes.command.v1 不变量 3）。record 在**命令成功提交前**
 * 调用：已存在 → 返回 null（用例层翻 rejected）；不存在 → 记账并返回记账行。
 */
export interface ListingOperationStore {
  record(entry: ListingOperationRecord): Promise<ListingOperationRecord | null>;
}

// ---- 域事件（BusinessEvent 形状 + Outbox） ----

/**
 * 域事件存储端口：append-only 落事件 + 原子产生 Outbox 行（evidence-columns
 * 纪律 2）。eventId 重复 append → ListingConflictError（幂等去重）。PG 侧映射
 * 既有 event_records / outbox_records 两表（M1 已建）。
 */
export interface ListingDomainEventStore {
  append(event: BusinessEvent): Promise<OutboxRecord>;
  /** 按聚合计读事件（append 顺序升序；跨事件类型混排——发布账本口径）。 */
  byAggregate(aggregate: { readonly id: string; readonly type: string }): Promise<readonly BusinessEvent[]>;
  /** 未投递 Outbox 行（createdAt 升序）。 */
  pendingOutbox(): Promise<readonly OutboxRecord[]>;
  /** 标记已投递（Outbox 例外：投递记账可 UPDATE）。 */
  markDelivered(eventId: EventId, deliveredAt: string): Promise<void>;
}

/** Excel 错误行提示的存储/事件载荷形状（excel-port ExcelParseIssue 的可序列化子集）。 */
export type ListingRowIssue = Pick<ExcelParseIssue, 'lineNo' | 'column' | 'message'>;
