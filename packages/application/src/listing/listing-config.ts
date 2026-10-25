/**
 * listing 状态机配置与类目词汇（M2-W3，ADR-0010 条 2：状态集是配置，不是内核）。
 *
 * 三份配置均为 engine-flow ApprovalFlowConfig 形态（配置驱动、可整体替换）：
 *  - PURCHASE_ORDER_FLOW_CONFIG   采购订单五态 draft→submitted→approved→issued→
 *                                 received（+退货回退 received→issued）；审核走
 *                                 engine-flow 决策迁移（体例照抄 workorder 配件机
 *                                 decision 用法）；
 *  - PURCHASE_REQUEST_FLOW_CONFIG 采购申请三态 draft→approved→converted；
 *  - PURCHASE_RETURN_FLOW_CONFIG  退货单两态 open→revoked。
 *
 * 审核链层级配置化：初版默认 = 单级审核（submitted --APPROVE(decision)--> approved）；
 * 客户配置多级审核链 = 整体替换一份配置（中间加审阅态），编排代码按"目标态 +
 * 配置规则"寻径零改动（03-listing.md §8 Open question：审批层级数按客户配置）。
 *
 * 迁移语义初版口径（编排侧驱动点，换配置即换合法集）：
 *  - 订单：submit=建单+SUBMIT；approve=APPROVE 决策；issue=ISSUE；receive=RECEIVE
 *    （先经 inventory 入库指令端口，拒绝则整单 rejected 不落账）；return.create=
 *    建退货单 + 订单 RETURN 回退（received→issued，可重新收货）。
 *  - 申请：request.create 落 draft（初始态，无机器事件）；随订单推进——订单
 *    approve 时其来源申请 draft→approved、订单 issue 时 approved→converted
 *    （转单完成）。合同命令面无独立申请审批命令，该推进口径为初版裁定，
 *    对账阶段按活系统行为校正。
 *  - 退货单：return.create 落 open；return.revoke=REVOKE 撤销（作废退货单，
 *    订单停在 issued 可重新收货）。
 */
import { defineApprovalFlowConfig, type ApprovalFlowConfig } from '@smes/engine-flow';

// ---- 四类清单 kind（03-listing.md §2；与 workorder-config 的镜像词汇同形） ----

/** 四类清单 kind。 */
export const LISTING_KINDS = ['part', 'standard', 'electrical', 'equipment'] as const;

export type ListingKind = (typeof LISTING_KINDS)[number];

/** kind → 清单中文名（展示/待办标题用，引擎与存储只认 kind）。 */
const LISTING_KIND_LABELS: Readonly<Record<ListingKind, string>> = {
  part: '零件清单',
  standard: '标准件清单',
  electrical: '电气件清单',
  equipment: '设备采购清单',
};

export function listingKindLabel(kind: string): string {
  return (LISTING_KIND_LABELS as Readonly<Record<string, string>>)[kind] ?? kind;
}

// ---- 三类采购申请 kind ----

/** 采购申请 kind：非标件/标准配件/设备（03-listing.md §2）。 */
export const PURCHASE_REQUEST_KINDS = ['nonstandard', 'standard', 'equipment'] as const;

export type PurchaseRequestKind = (typeof PURCHASE_REQUEST_KINDS)[number];

/** 缺口行 → 申请 kind 的初版推导（对账阶段按活系统行为校正）。 */
export function requestKindOfListingKind(kind: string): PurchaseRequestKind {
  if (kind === 'part') return 'nonstandard'; // 零件（机加工图号件）→ 非标件
  if (kind === 'equipment') return 'equipment'; // 设备采购 → 设备
  return 'standard'; // 标准件/电气件 → 标准配件
}

// ---- 缺口核查范围 ----

/**
 * 缺口核查默认覆盖的清单类目（功能项 73~76 四类缺口核查）：四类全量。
 * 可经服务选项收窄（模块选项注入，不改代码）。
 */
export const DEFAULT_GAP_SCOPE_KINDS: readonly ListingKind[] = LISTING_KINDS;

// ---- 采购订单五态机 ----

/** 采购订单配置标识。 */
export const PURCHASE_ORDER_FLOW_ID = 'purchase-order';

/** 五态 id（配置内声明顺序 = 主干推进序）。 */
export const PURCHASE_ORDER_STATE_IDS = [
  'draft',
  'submitted',
  'approved',
  'issued',
  'received',
] as const;

export type PurchaseOrderStateId = (typeof PURCHASE_ORDER_STATE_IDS)[number];

/** 五态目录（id ↔ 中文名；未知 id 原样返回）。 */
export const PURCHASE_ORDER_STATES: ReadonlyArray<{ readonly id: PurchaseOrderStateId; readonly label: string }> =
  PURCHASE_ORDER_STATE_IDS.map((id, index) => ({
    id,
    label: ['草稿', '已提交待审', '已审核', '已下发', '已收货'][index] as string,
  }));

export function purchaseOrderStateLabel(state: string): string {
  return PURCHASE_ORDER_STATES.find((entry) => entry.id === state)?.label ?? state;
}

/**
 * 采购订单默认配置（初版合法集，共 6 条迁移）：
 * 主干 5 条：draft→submitted→approved→issued→received；
 * 回退 1 条：received→issued（退货回退——return.create 驱动，可重新收货）。
 * 无 final 态：received 可经 RETURN 回退（"+退货回退"合同口径）；终态判定
 * 不用于本机。审核链初版 = 单级（APPROVE 决策迁移）；层级配置化见文件头。
 */
export const DEFAULT_PURCHASE_ORDER_FLOW_CONFIG: ApprovalFlowConfig = defineApprovalFlowConfig({
  schemaVersion: 1,
  flowId: PURCHASE_ORDER_FLOW_ID,
  initial: 'draft',
  states: [
    { id: 'draft' },
    { id: 'submitted' },
    { id: 'approved' },
    { id: 'issued' },
    { id: 'received' },
  ],
  transitions: [
    { from: 'draft', event: 'SUBMIT', to: 'submitted', eventAction: 'submitted' },
    { from: 'submitted', event: 'APPROVE', to: 'approved', decision: 'approve', eventAction: 'approved' },
    { from: 'approved', event: 'ISSUE', to: 'issued', eventAction: 'issued' },
    { from: 'issued', event: 'RECEIVE', to: 'received', eventAction: 'received' },
    { from: 'received', event: 'RETURN', to: 'issued', eventAction: 'return-rolled-back' },
  ],
});

// ---- 采购申请三态机 ----

/** 采购申请配置标识。 */
export const PURCHASE_REQUEST_FLOW_ID = 'purchase-request';

export const PURCHASE_REQUEST_STATE_IDS = ['draft', 'approved', 'converted'] as const;

export type PurchaseRequestStateId = (typeof PURCHASE_REQUEST_STATE_IDS)[number];

export const PURCHASE_REQUEST_STATES: ReadonlyArray<{ readonly id: PurchaseRequestStateId; readonly label: string }> =
  PURCHASE_REQUEST_STATE_IDS.map((id, index) => ({
    id,
    label: ['草稿', '已批准', '已转单'][index] as string,
  }));

export function purchaseRequestStateLabel(state: string): string {
  return PURCHASE_REQUEST_STATES.find((entry) => entry.id === state)?.label ?? state;
}

/**
 * 采购申请默认配置：draft --APPROVE(决策)--> approved --CONVERT--> converted。
 * 推进由订单命令联动驱动（见文件头初版口径）；converted 为终态。
 */
export const DEFAULT_PURCHASE_REQUEST_FLOW_CONFIG: ApprovalFlowConfig = defineApprovalFlowConfig({
  schemaVersion: 1,
  flowId: PURCHASE_REQUEST_FLOW_ID,
  initial: 'draft',
  states: [{ id: 'draft' }, { id: 'approved' }, { id: 'converted', final: true }],
  transitions: [
    { from: 'draft', event: 'APPROVE', to: 'approved', decision: 'approve', eventAction: 'approved' },
    { from: 'approved', event: 'CONVERT', to: 'converted', eventAction: 'converted' },
  ],
});

// ---- 退货单两态机 ----

/** 退货单配置标识。 */
export const PURCHASE_RETURN_FLOW_ID = 'purchase-return';

export const PURCHASE_RETURN_STATE_IDS = ['open', 'revoked'] as const;

export type PurchaseReturnStateId = (typeof PURCHASE_RETURN_STATE_IDS)[number];

export const PURCHASE_RETURN_STATES: ReadonlyArray<{ readonly id: PurchaseReturnStateId; readonly label: string }> =
  PURCHASE_RETURN_STATE_IDS.map((id, index) => ({
    id,
    label: ['已登记', '已撤销'][index] as string,
  }));

export function purchaseReturnStateLabel(state: string): string {
  return PURCHASE_RETURN_STATES.find((entry) => entry.id === state)?.label ?? state;
}

/** 退货单默认配置：open --REVOKE--> revoked（终态）。 */
export const DEFAULT_PURCHASE_RETURN_FLOW_CONFIG: ApprovalFlowConfig = defineApprovalFlowConfig({
  schemaVersion: 1,
  flowId: PURCHASE_RETURN_FLOW_ID,
  initial: 'open',
  states: [{ id: 'open' }, { id: 'revoked', final: true }],
  transitions: [{ from: 'open', event: 'REVOKE', to: 'revoked', eventAction: 'revoked' }],
});
