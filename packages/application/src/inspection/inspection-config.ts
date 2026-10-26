/**
 * inspection 状态机配置与默认口径（M2-W4，ADR-0010 条 2：状态集是配置，不是内核）。
 *
 * 两份配置均为 engine-flow ApprovalFlowConfig 形态（配置驱动、可整体替换）：
 *  - INSPECTION_FLOW_CONFIG  质检单四态（06-inspection.md §2）：
 *      pending(待检) → passed(合格) / failed(不合格)；failed → closed(闭环)。
 *      判定迁移走 decision 类（合格=approve / 不合格=reject——判定即决策，
 *      参照 workorder 配件机的 decision 迁移用法：决策记录随迁移事件 payload
 *      留痕，即"检验记录"事实）；复检合格 RECHECK_PASS 返 passed（放行）。
 *  - NONCONFORM_FLOW_CONFIG  不合格处置三态：open → disposed(已处置) → closed(闭环)。
 *
 * 分层标注（06-inspection.md §2 / ADR-0010 三层）：
 *  内核概念 = 质检状态集与不合格闭环迁移语义（本文件两份配置承载）；
 *  模块 schema = 实体/命令/事件（events/stores 文件，版本化）；
 *  默认配置 = 闭环超时阈值（DEFAULT_CLOSE_TIMEOUT_MS）与处置枚举初版
 *  （NONCONFORM_DISPOSALS）——实施时按客户口径调整，不属内核。
 */
import { defineApprovalFlowConfig, type ApprovalFlowConfig } from '@smes/engine-flow';

/** 质检单状态机配置标识。 */
export const INSPECTION_FLOW_ID = 'inspection-order';

/** 质检单状态 id（配置内声明顺序 = 合同 §2 表达序）。 */
export const INSPECTION_STATE_IDS = ['pending', 'passed', 'failed', 'closed'] as const;

export type InspectionStateId = (typeof INSPECTION_STATE_IDS)[number];

/** 四态目录（id ↔ 合同中文名；展示/待办标题用，引擎只认 id）。 */
export const INSPECTION_STATES: ReadonlyArray<{
  readonly id: InspectionStateId;
  readonly label: string;
}> = INSPECTION_STATE_IDS.map((id, index) => ({
  id,
  label: ['待检', '合格', '不合格', '闭环'][index] as string,
}));

/** 状态 id → 中文名（未知 id 原样返回，配置换代不炸展示层）。 */
export function inspectionStateLabel(state: string): string {
  return INSPECTION_STATES.find((entry) => entry.id === state)?.label ?? state;
}

/**
 * 质检单默认配置（初版合法集 + fix-wave-6 6a-2 撤销回退）：
 *   pending --PASS(decision:approve)--> passed          判定合格（放行）
 *   pending --FAIL(decision:reject)--> failed           判定不合格（进闭环）
 *   failed  --RECHECK_PASS(decision:approve)--> passed  复检合格（放行）
 *   failed  --CLOSE--> closed                           不合格闭环完成（终态）
 *   passed  --REVOKE--> pending                         撤销质检（RQ-037 判定回退）
 *   failed  --REVOKE--> pending                         撤销质检（清结果+作废不合格明细）
 * closed 为唯一终态（闭环完成不可回退——已结案事实不破坏）。passed 自
 * fix-wave-6 起不再是终态：撤销质检需要回退出边（RQ-037"已质检单撤销回待检态"，
 * 与源三份采购质检 3.6/质检模块 三、5"撤销→回待质检"同构）；放行事实的收回
 * 经 InspectionRevoked 域事件（inventory 消费锚点），不回滚已发布的放行事件
 * （append-only 账本语义）。closed 仅由"该单全部不合格明细已闭环"推入
 * （nonconform.close 联动，本模块不发独立命令），无 REVOKE 出边。
 */
export const DEFAULT_INSPECTION_FLOW_CONFIG: ApprovalFlowConfig = defineApprovalFlowConfig({
  schemaVersion: 1,
  flowId: INSPECTION_FLOW_ID,
  initial: 'pending',
  states: [
    { id: 'pending' },
    { id: 'passed' },
    { id: 'failed' },
    { id: 'closed', final: true },
  ],
  transitions: [
    { from: 'pending', event: 'PASS', to: 'passed', decision: 'approve', eventAction: 'passed' },
    { from: 'pending', event: 'FAIL', to: 'failed', decision: 'reject', eventAction: 'failed' },
    { from: 'failed', event: 'RECHECK_PASS', to: 'passed', decision: 'approve', eventAction: 'recheck-passed' },
    { from: 'failed', event: 'CLOSE', to: 'closed', eventAction: 'closed' },
    { from: 'passed', event: 'REVOKE', to: 'pending', eventAction: 'revoked' },
    { from: 'failed', event: 'REVOKE', to: 'pending', eventAction: 'revoked' },
  ],
});

// ---- 不合格处置状态机 ----

/** 不合格处置配置标识。 */
export const NONCONFORM_FLOW_ID = 'nonconform';

/** 不合格处置状态 id。 */
export const NONCONFORM_STATE_IDS = ['open', 'disposed', 'closed', 'voided'] as const;

export type NonconformStateId = (typeof NONCONFORM_STATE_IDS)[number];

/** 处置状态目录（open=待处置 / disposed=已处置 / closed=已闭环 / voided=已作废）。 */
export const NONCONFORM_STATES: ReadonlyArray<{
  readonly id: NonconformStateId;
  readonly label: string;
}> = NONCONFORM_STATE_IDS.map((id, index) => ({
  id,
  label: ['待处置', '已处置', '已闭环', '已作废'][index] as string,
}));

export function nonconformStateLabel(state: string): string {
  return NONCONFORM_STATES.find((entry) => entry.id === state)?.label ?? state;
}

/**
 * 不合格处置默认配置：open --DISPOSE--> disposed --CLOSE--> closed（终态）；
 * fix-wave-6 6a-2 增 voided 旁支：open/disposed --VOID--> voided（终态）——
 * 仅由撤销质检级联触发（判定被撤销时其自动生成的不合格明细随判定作废，
 * 历史留痕在两本 append-only 账本，投影行进 voided 不进活跃闭环视图）；
 * closed 已结案不回退作废（与质检单 closed 无 REVOKE 出边同口径）。
 * 处置方式（返工/让步/报废）不进迁移动词——它是处置命令的载荷与投影列，
 * 随 NonconformDisposed 事件留痕（枚举见 NONCONFORM_DISPOSALS，默认配置层）。
 */
export const DEFAULT_NONCONFORM_FLOW_CONFIG: ApprovalFlowConfig = defineApprovalFlowConfig({
  schemaVersion: 1,
  flowId: NONCONFORM_FLOW_ID,
  initial: 'open',
  states: [{ id: 'open' }, { id: 'disposed' }, { id: 'closed', final: true }, { id: 'voided', final: true }],
  transitions: [
    { from: 'open', event: 'DISPOSE', to: 'disposed', eventAction: 'disposed' },
    { from: 'disposed', event: 'CLOSE', to: 'closed', eventAction: 'closed' },
    { from: 'open', event: 'VOID', to: 'voided', eventAction: 'voided' },
    { from: 'disposed', event: 'VOID', to: 'voided', eventAction: 'voided' },
  ],
});

// ---- 四类质检 kind 与来源（模块 schema 词汇，06-inspection.md §1/§2） ----

/** 四类质检单 kind：自制外协 / 非标件采购 / 标准配件采购 / 设备采购。 */
export const INSPECTION_KINDS = [
  'self_outsourced',
  'nonstandard_purchase',
  'standard_purchase',
  'equipment_purchase',
] as const;

export type InspectionKind = (typeof INSPECTION_KINDS)[number];

/** 四类目录（id ↔ 合同中文名）。 */
export const INSPECTION_KIND_LABELS: ReadonlyArray<{
  readonly kind: InspectionKind;
  readonly label: string;
}> = INSPECTION_KINDS.map((kind, index) => ({
  kind,
  label: ['自制外协', '非标件采购', '标准配件采购', '设备采购'][index] as string,
}));

export function inspectionKindLabel(kind: string): string {
  return INSPECTION_KIND_LABELS.find((entry) => entry.kind === kind)?.label ?? kind;
}

/** 触发来源：reporting 末道报工 / dispatch 外协回厂 / listing 收货（合同 §4）。 */
export const INSPECTION_SOURCE_TYPES = ['report', 'dispatch', 'receipt'] as const;

export type InspectionSourceType = (typeof INSPECTION_SOURCE_TYPES)[number];

/** 来源类型中文名（待办/IM 文案用）。 */
export const INSPECTION_SOURCE_TYPE_LABELS: Readonly<Record<InspectionSourceType, string>> = {
  report: '末道报工',
  dispatch: '外协回厂',
  receipt: '采购收货',
};

/** 收货触发的采购类 kind（receipt 来源须显式给三者之一）。 */
export const PURCHASE_INSPECTION_KINDS: readonly InspectionKind[] = [
  'nonstandard_purchase',
  'standard_purchase',
  'equipment_purchase',
];

/**
 * 来源事实 → 质检 kind 推导：
 *  - report / dispatch → 恒 self_outsourced（自制外协类，末道报工与外协回厂同族）；
 *  - receipt → 须显式给三类采购 kind 之一。
 * 返回 null = 来源与 kind 组合非法（用例层翻 rejected / InputError）。
 */
export function kindForSourceFact(
  sourceType: InspectionSourceType,
  explicitKind?: InspectionKind,
): InspectionKind | null {
  if (sourceType === 'report' || sourceType === 'dispatch') {
    return explicitKind === undefined || explicitKind === 'self_outsourced' ? 'self_outsourced' : null;
  }
  return explicitKind !== undefined && (PURCHASE_INSPECTION_KINDS as readonly string[]).includes(explicitKind)
    ? explicitKind
    : null;
}

// ---- 默认配置层（ADR-0010 条 3：随客户口径调整，不属内核） ----

/**
 * 不合格处置枚举初版：rework=返工 / concession=让步 / scrap=报废
 * （合同 §2；Open question"让步接收独立处置码"对账阶段确认后增补）。
 * 返工处置要求必要复检（复检合格方可闭环——service 层业务规则）。
 */
export const NONCONFORM_DISPOSALS = ['rework', 'concession', 'scrap'] as const;

export type NonconformDisposal = (typeof NONCONFORM_DISPOSALS)[number];

export function nonconformDisposalLabel(disposal: string): string {
  return (
    {
      rework: '返工',
      concession: '让步',
      scrap: '报废',
    } as Readonly<Record<string, string>>
  )[disposal] ?? disposal;
}

/**
 * 闭环超时阈值默认值（毫秒）：不合格判定后 72 小时未闭环即点名
 * （合同洞察 88 未闭环场景；超时 → InspectionOverdue → 待办 + IM）。
 * 初版口径，对账阶段按客户口径调整（service options.closeTimeoutMs 注入）。
 */
export const DEFAULT_CLOSE_TIMEOUT_MS = 72 * 60 * 60 * 1000;

/**
 * 批量质检单次上限默认值（RQ-036；对齐 reporting DEFAULT_REPORT_BATCH_LIMIT
 * 先例）：超限整批拒绝（弱网/大勾选分片口径，service options.batchLimit 注入）。
 */
export const DEFAULT_INSPECTION_BATCH_LIMIT = 50;
