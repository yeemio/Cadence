/**
 * inventory 状态机配置与词汇（M2-W5，ADR-0010 条 2：状态集是配置，不是内核）。
 *
 * 两份配置均为 engine-flow ApprovalFlowConfig 形态（配置驱动、可整体替换）：
 *  - STOCKTAKE_FLOW_CONFIG   盘点四态 draft→counting→reconciled→adjusted；
 *  - SHIPPING_FLOW_CONFIG    发货任务三态 draft→executing→shipped。
 * 入库单/出库单本身为凭证（证据列承载，非状态机——07-inventory.md §2）。
 *
 * 分层标注（07-inventory.md §2 ADR-0010 三层）：
 *  - 内核概念 = 盘点/发货状态集与迁移语义、可用量=总量−预占恒等式；
 *  - 模块 schema = 本文件命令/事件词汇（版本化）；
 *  - 默认配置 = 负库存策略初版默认硬拒绝（合同 §8：实施配置化——服务选项
 *    negativeStockPolicy 整体注入，不属内核）。
 *
 * 迁移语义初版口径（编排侧驱动点，换配置即换合法集）：
 *  - 盘点：open=建单+START（counting）；record=实盘录入（多轮，complete=true
 *    时 RECONCILE 进 reconciled——须全部行已盘）；approve-adjust=ADJUST 调账
 *    （reconciled→adjusted 终态，差异生成盘盈/盘亏流水 + StocktakeAdjusted 留痕）。
 *  - 发货：execute=建任务+EXECUTE（executing，逐行出库核销）；confirm=CONFIRM
 *    （shipped 终态，补物流信息 + ShippingConfirmed 事件→workorder 联动）。
 */
import { defineApprovalFlowConfig, type ApprovalFlowConfig } from '@smes/engine-flow';

// ---- 三类入库来源（07-inventory.md §2 In + §3 stock.receive 校验放行事实） ----

/** 三类入库来源 kind：质检放行 / 采购收货 / 完工入库。 */
export const RECEIPT_SOURCE_KINDS = ['inspection', 'purchase', 'production'] as const;

export type ReceiptSourceKind = (typeof RECEIPT_SOURCE_KINDS)[number];

/** kind → 中文名（展示/拒绝理由用）。 */
const RECEIPT_KIND_LABELS: Readonly<Record<ReceiptSourceKind, string>> = {
  inspection: '质检放行入库',
  purchase: '采购收货入库',
  production: '完工入库',
};

export function receiptKindLabel(kind: string): string {
  return (RECEIPT_KIND_LABELS as Readonly<Record<string, string>>)[kind] ?? kind;
}

// ---- 出库目的（stock.issue / shipping 行级） ----

/** 出库目的：production=生产发料；parts=配件发料；manual=手工领用。 */
export const ISSUE_PURPOSES = ['production', 'parts', 'manual'] as const;

export type IssuePurpose = (typeof ISSUE_PURPOSES)[number];

// ---- 出入库流水 kind（append-only 事实的词汇面；方向由 kind 推导） ----

/** 流水 kind：方向 × 来源（盘点调账按盘盈/盘亏分列）。 */
export const STOCK_MOVEMENT_KINDS = [
  'purchase-in',
  'inspection-in',
  'production-in',
  'issue-out',
  'shipping-out',
  'transfer-out',
  'transfer-in',
  'stocktake-gain',
  'stocktake-loss',
] as const;

export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number];

/** 流水方向（in=入库增现存量；out=出库减现存量）。 */
export type StockMovementDirection = 'in' | 'out';

const KIND_DIRECTION: Readonly<Record<StockMovementKind, StockMovementDirection>> = {
  'purchase-in': 'in',
  'inspection-in': 'in',
  'production-in': 'in',
  'issue-out': 'out',
  'shipping-out': 'out',
  'transfer-out': 'out',
  'transfer-in': 'in',
  'stocktake-gain': 'in',
  'stocktake-loss': 'out',
};

export function movementDirection(kind: StockMovementKind): StockMovementDirection {
  return KIND_DIRECTION[kind];
}

export function movementKindLabel(kind: string): string {
  const labels: Readonly<Record<string, string>> = {
    'purchase-in': '采购入库',
    'inspection-in': '质检放行入库',
    'production-in': '完工入库',
    'issue-out': '出库',
    'shipping-out': '发货出库',
    'transfer-out': '调拨出',
    'transfer-in': '调拨入',
    'stocktake-gain': '盘盈',
    'stocktake-loss': '盘亏',
  };
  return labels[kind] ?? kind;
}

// ---- 货架/货架库位启停词汇（B3 / RREQ-IV-002；源 enable_status 字典的我方串化） ----

/** 货架与货架库位状态：active=启用；disabled=停用（停用受正结存保护）。 */
export const GOODS_SHELF_STATUSES = ['active', 'disabled'] as const;

export type GoodsShelfStatus = (typeof GOODS_SHELF_STATUSES)[number];

const GOODS_SHELF_STATUS_LABELS: Readonly<Record<GoodsShelfStatus, string>> = {
  active: '启用',
  disabled: '停用',
};

export function goodsShelfStatusLabel(status: string): string {
  return (GOODS_SHELF_STATUS_LABELS as Readonly<Record<string, string>>)[status] ?? status;
}

// ---- 负库存策略（合同 §8：配置化，默认硬拒绝） ----

/** 负库存策略：reject=硬拒绝（默认）；allow=允许账面负数暂存（对账阶段裁定口径）。 */
export const NEGATIVE_STOCK_POLICIES = ['reject', 'allow'] as const;

export type NegativeStockPolicy = (typeof NEGATIVE_STOCK_POLICIES)[number];

export const DEFAULT_NEGATIVE_STOCK_POLICY: NegativeStockPolicy = 'reject';

// ---- 盘点四态机 ----

/** 盘点配置标识。 */
export const STOCKTAKE_FLOW_ID = 'stocktake';

export const STOCKTAKE_STATE_IDS = ['draft', 'counting', 'reconciled', 'adjusted'] as const;

export type StocktakeStateId = (typeof STOCKTAKE_STATE_IDS)[number];

export const STOCKTAKE_STATES: ReadonlyArray<{ readonly id: StocktakeStateId; readonly label: string }> =
  STOCKTAKE_STATE_IDS.map((id, index) => ({
    id,
    label: ['草稿', '盘点中', '待审核调账', '已调账'][index] as string,
  }));

export function stocktakeStateLabel(state: string): string {
  return STOCKTAKE_STATES.find((entry) => entry.id === state)?.label ?? state;
}

/**
 * 盘点默认配置：draft --START--> counting --RECONCILE--> reconciled --
 * ADJUST--> adjusted（终态）。reconciled = 实盘完成待审核（07-inventory.md §2）。
 */
export const DEFAULT_STOCKTAKE_FLOW_CONFIG: ApprovalFlowConfig = defineApprovalFlowConfig({
  schemaVersion: 1,
  flowId: STOCKTAKE_FLOW_ID,
  initial: 'draft',
  states: [{ id: 'draft' }, { id: 'counting' }, { id: 'reconciled' }, { id: 'adjusted', final: true }],
  transitions: [
    { from: 'draft', event: 'START', to: 'counting', eventAction: 'counting-started' },
    { from: 'counting', event: 'RECONCILE', to: 'reconciled', eventAction: 'counting-reconciled' },
    { from: 'reconciled', event: 'ADJUST', to: 'adjusted', eventAction: 'stock-adjusted' },
  ],
});

// ---- 发货任务三态机 ----

/** 发货配置标识。 */
export const SHIPPING_FLOW_ID = 'shipping-order';

export const SHIPPING_STATE_IDS = ['draft', 'executing', 'shipped'] as const;

export type ShippingStateId = (typeof SHIPPING_STATE_IDS)[number];

export const SHIPPING_STATES: ReadonlyArray<{ readonly id: ShippingStateId; readonly label: string }> =
  SHIPPING_STATE_IDS.map((id, index) => ({
    id,
    label: ['草稿', '执行中', '已发货'][index] as string,
  }));

export function shippingStateLabel(state: string): string {
  return SHIPPING_STATES.find((entry) => entry.id === state)?.label ?? state;
}

/**
 * 发货任务默认配置：draft --EXECUTE--> executing --CONFIRM--> shipped（终态）。
 * 出库扣账在 EXECUTE（拣货执行即实物离位）；物流信息在 CONFIRM 补全并发
 * ShippingConfirmed（→workorder 待发货→已发货联动，07-inventory.md §6）。
 */
export const DEFAULT_SHIPPING_FLOW_CONFIG: ApprovalFlowConfig = defineApprovalFlowConfig({
  schemaVersion: 1,
  flowId: SHIPPING_FLOW_ID,
  initial: 'draft',
  states: [{ id: 'draft' }, { id: 'executing' }, { id: 'shipped', final: true }],
  transitions: [
    { from: 'draft', event: 'EXECUTE', to: 'executing', eventAction: 'executing-started' },
    { from: 'executing', event: 'CONFIRM', to: 'shipped', eventAction: 'shipping-confirmed' },
  ],
});

// ---- 预占词汇（07-inventory.md §2 预占规则：派工/发料创建即预占，完工入库/出库核销） ----

/** 预占状态：active=占用中；consumed=已核销（出库/完工转结）；released=已释放（未用退回）。 */
export const RESERVATION_STATUSES = ['active', 'consumed', 'released'] as const;

export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
