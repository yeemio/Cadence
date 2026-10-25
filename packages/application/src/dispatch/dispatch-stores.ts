/**
 * dispatch 存储端口（M2-W6）。体例同 listing-stores：端口在本包定义业务形状，
 * 内存实现先行（in-memory-dispatch-stores.ts），PG adapter 由 business-store 按
 * `./dispatch` 子路径接入（表结构见 prisma/migrations/*_dispatch_module——组合根
 * 接线属总控合流）。
 *
 * 表形态取舍（对齐 workorder/listing 既定裁定，依据 evidence-columns.v1 +
 * m2-drafts README 纪律 2）：
 *  - dispatch_orders / outsourcing_lines 是**投影**（运营状态，可 UPDATE，行级
 *    乐观版本）——不套证据公共列；外协行是版本化数据（单价补录 + objectVersion，
 *    非状态机，04-dispatch.md §2）；
 *  - dispatch_events 是**状态机事件账本**（engine-flow ApprovalEventStore 形状，
 *    dispatch-order 聚合专用）；
 *  - dispatch_operations 是**幂等记账**（运营表，同 outbox 取舍豁免触发器）；
 *  - 域事件（BusinessEvent 形状）落既有通用 event_records + outbox_records
 *    （M1 已建）——本包端口按 BusinessEvent 定形，Outbox 记账随 append 原子产生。
 *  本模块无独立"不可变快照"事实表（齐套事实在 workorder 侧、缺口事实在 listing
 *  侧，本模块只读消费），故无证据公共列事实表。
 */
import type {
  BusinessEvent,
  EventId,
  OutboxRecord,
  TenantId,
  UserId,
} from '@smes/business-core';
import type { DispatchKind } from './dispatch-config.js';

// ---- 派工单（投影，四态主干 + 撤销支） ----

/** 单价来源：lookup=创建时 baseline 实时取价；manual=创建时人工给定；backfill=事后补录。 */
export type OutsourcingPriceSource = 'lookup' | 'manual' | 'backfill';

/**
 * 派工单（六类一体：零件/外协/装配/电气/售后/零工）。
 * 零件单带工艺属性快照（图号×工序×材料×尺寸随单——不回查 baseline，快照纪律）。
 */
export interface DispatchOrder {
  /** dsp-<uuidv7>（模块 id 生成器；存储面按不透明串收）。 */
  readonly id: string;
  readonly tenant: TenantId;
  /** 所属工作令（售后/零工可不挂——跨模块 opaque id）。 */
  readonly workOrderId: string | null;
  readonly kind: DispatchKind;
  readonly flowConfigId: string;
  /** draft/assigned/executing/done/cancelled。 */
  readonly state: string;
  /** 状态机版本：创建 = 1（初始态无机器事件），每次迁移 +1。 */
  readonly objectVersion: number;
  /** 单据标题（缺省 = 类目中文名 + 工序/图号，展示与待办用）。 */
  readonly title: string;
  // ---- 零件单工艺属性快照（其余 kind 可空；图号×工序是上卷键） ----
  readonly drawingNo: string | null;
  /** 工序业务码（baseline 工序库 opaque code；装配/电气/零件的工序上卷键）。 */
  readonly operationCode: string | null;
  /** 材料随单（零件单工艺属性快照；可空）。 */
  readonly material: string | null;
  /** 尺寸随单（零件单工艺属性快照；可空）。 */
  readonly sizeSpec: string | null;
  /** 派工数量（正数）。 */
  readonly quantity: number;
  /** 完工数量（complete 回填；初版口径整单完工 = quantity）。 */
  readonly doneQty: number;
  /** 执行人（assign 回填；供应商不在此——外协供应商挂接在明细行）。 */
  readonly assignee: UserId | null;
  /** 要求完成时刻（ISO 8601，可空）。 */
  readonly dueAt: string | null;
  readonly remark: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateDispatchOrderInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly workOrderId: string | null;
  readonly kind: DispatchKind;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly title: string;
  readonly drawingNo: string | null;
  readonly operationCode: string | null;
  readonly material: string | null;
  readonly sizeSpec: string | null;
  readonly quantity: number;
  readonly assignee: UserId | null;
  readonly dueAt: string | null;
  readonly remark: string | null;
}

export interface ListDispatchOrdersFilter {
  readonly kind?: string | undefined;
  readonly state?: string | undefined;
  readonly workOrderId?: string | undefined;
  readonly assignee?: string | undefined;
}

/** 派工单存储端口（租户收口 + 乐观 advance；advance 可回填 doneQty/assignee）。 */
export interface DispatchOrderStore {
  create(input: CreateDispatchOrderInput): Promise<DispatchOrder>;
  find(tenant: TenantId, id: string): Promise<DispatchOrder | null>;
  list(tenant: TenantId, filter?: ListDispatchOrdersFilter): Promise<readonly DispatchOrder[]>;
  advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
    extra?: { readonly doneQty?: number; readonly assignee?: UserId | null },
  ): Promise<DispatchOrder>;
}

// ---- 外协明细（投影，版本化数据——单价可事后补录） ----

/** 外协明细（OutsourcingLineId：供应商×工序×单价×交期；一外协派工单多行 = 批量派发）。 */
export interface OutsourcingLine {
  /** osl-<uuidv7>。 */
  readonly id: string;
  readonly tenant: TenantId;
  readonly dispatchId: string;
  /** 行号（单内 1 起递增；同单唯一）。 */
  readonly lineNo: number;
  /** 工序业务码（baseline 工序库 / listing 零件清单外协工序来源，opaque）。 */
  readonly processCode: string;
  readonly drawingNo: string | null;
  /** 供应商引用（masterdata 供应商 opaque id；批量派发的分组键）。 */
  readonly supplierRef: string;
  readonly supplierName: string | null;
  /** 外协数量（正数）。 */
  readonly quantity: number;
  /** 单价（分，整数精确；null = 未定价——事后补录锚点）。 */
  readonly unitPriceMinor: number | null;
  /** 单价来源（null = 未定价）。 */
  readonly priceSource: OutsourcingPriceSource | null;
  /** 取价证据：计价规则的利润率（万分比；人工给定/补录为 null）。 */
  readonly marginPermyriad: number | null;
  /** 交期（ISO 8601，可空）。 */
  readonly promisedAt: string | null;
  /** 来源清单行锚点（listing 零件清单行，opaque；可空）。 */
  readonly sourceListingLineId: string | null;
  /** 行级数据版本：创建 = 1，单价补录 +1（乐观锁口径）。 */
  readonly objectVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AppendOutsourcingLineInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly dispatchId: string;
  readonly lineNo: number;
  readonly processCode: string;
  readonly drawingNo: string | null;
  readonly supplierRef: string;
  readonly supplierName: string | null;
  readonly quantity: number;
  readonly unitPriceMinor: number | null;
  readonly priceSource: OutsourcingPriceSource | null;
  readonly marginPermyriad: number | null;
  readonly promisedAt: string | null;
  readonly sourceListingLineId: string | null;
}

/** 单价补录字段（outsourcing.price.backfill；未提供的键不变）。 */
export interface BackfillOutsourcingPriceFields {
  readonly unitPriceMinor: number;
  readonly priceSource: OutsourcingPriceSource;
  readonly marginPermyriad: number | null;
  readonly promisedAt?: string | null;
}

/**
 * 外协明细存储端口。实现方保证：
 *  - appendLines 原子落整批（含行号唯一；冲突抛 DispatchConflictError）；
 *  - backfillPrice 为乐观更新：仅当 objectVersion === expectedObjectVersion 时
 *    写字段并 +1 版本；未命中（不存在/版本不符）返回 null——用例层按
 *    "存在但版本不符 → rejected 乐观锁"与"不存在 → rejected 404 语义"分叉。
 */
export interface OutsourcingLineStore {
  appendLines(inputs: readonly AppendOutsourcingLineInput[]): Promise<readonly OutsourcingLine[]>;
  find(tenant: TenantId, id: string): Promise<OutsourcingLine | null>;
  listByDispatch(tenant: TenantId, dispatchId: string): Promise<readonly OutsourcingLine[]>;
  /** 供应商维度（外协单查询：按供应商归集行集，lineNo 升序）。 */
  listBySupplier(tenant: TenantId, supplierRef: string): Promise<readonly OutsourcingLine[]>;
  backfillPrice(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    fields: BackfillOutsourcingPriceFields,
  ): Promise<OutsourcingLine | null>;
}

// ---- 命令幂等记账 ----

export interface DispatchOperationRecord {
  readonly tenant: TenantId;
  readonly operationId: string;
  /** 命令动词（dispatch.* / outsourcing.* 命名族）。 */
  readonly command: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly occurredAt: string;
}

/**
 * 命令幂等记账端口（smes.command.v1 不变量 3）。record 在**命令成功提交前**
 * 调用：已存在 → 返回 null（用例层翻 rejected）；不存在 → 记账并返回记账行。
 */
export interface DispatchOperationStore {
  record(entry: DispatchOperationRecord): Promise<DispatchOperationRecord | null>;
}

// ---- 域事件（BusinessEvent 形状 + Outbox） ----

/**
 * 域事件存储端口：append-only 落事件 + 原子产生 Outbox 行（evidence-columns
 * 纪律 2）。eventId 重复 append → DispatchConflictError（幂等去重）。PG 侧映射
 * 既有 event_records / outbox_records 两表（M1 已建）。
 */
export interface DispatchDomainEventStore {
  append(event: BusinessEvent): Promise<OutboxRecord>;
  /** 按聚合计读事件（append 顺序升序；跨事件类型混排——发布账本口径）。 */
  byAggregate(aggregate: { readonly id: string; readonly type: string }): Promise<readonly BusinessEvent[]>;
  /** 未投递 Outbox 行（createdAt 升序）。 */
  pendingOutbox(): Promise<readonly OutboxRecord[]>;
  /** 标记已投递（Outbox 例外：投递记账可 UPDATE）。 */
  markDelivered(eventId: EventId, deliveredAt: string): Promise<void>;
}
