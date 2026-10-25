/**
 * reporting 状态机配置与五类词汇（M2-W7，ADR-0010 条 2：状态集是配置，不是内核）。
 *
 * 一份 engine-flow ApprovalFlowConfig 形态配置（配置驱动、可整体替换），五类
 * 报工单共用同一三态主干 + 撤销终态旁支（05-reporting.md §2 状态机）：
 *
 *   pending ──SUBMIT──▶ reported ──VERIFY──▶ verified（已核查：hours 归集锚点）
 *                          │ │
 *                          │ └──REVOKE──▶ revoked（撤销终态：hours 冲销信号）
 *                          └──────(verified 也经 REVOKE)──▶ revoked
 *                                 （已核查撤销需重报——合同 §2 撤销口径）
 *
 * submit = 建单先落 pending@v1 初始投影（无机器事件）再驱动 SUBMIT → reported@v2
 * （listing purchase.order.submit 同构）；audit-edit 生成修正版 = 新聚合走同一
 * pending→reported 路径（supersedes 锚定原单，原单行不动——append-only 修正链，
 * evidence-columns 纪律 1），verify/revoke 作用于链尾聚合。
 *
 * 分层标注（ADR-0010 三层）：
 *  - 内核概念 = 报工状态集与核查/撤销迁移语义（engine-flow 内核承载）；
 *  - 模块 schema = 五类 kind / 命令 / 事件（本模块版本化）；
 *  - 默认配置 = 可报派工单状态集（DEFAULT_REPORTABLE_DISPATCH_STATES）、批量
 *    上限（DEFAULT_REPORT_BATCH_LIMIT）、末道触发质检的 kind 集
 *    （DEFAULT_FINAL_INSPECTION_KINDS）——实施时按客户口径整体替换，不属内核。
 */
import { defineApprovalFlowConfig, type ApprovalFlowConfig } from '@smes/engine-flow';

// ---- 五类报工 kind（05-reporting.md §2；功能项 44~48） ----

/**
 * 五类报工 kind：零件/装配/电气/售后/零工。dispatch 六类派工中 outsourcing
 * （外协）不在报工面——外协完工由供应商回厂走 inspection 外协质检（dispatch
 * complete 联动），工时不归本厂工时账。
 */
export const REPORT_KINDS = [
  'part',
  'assembly',
  'electrical',
  'aftermarket',
  'oddjob',
] as const;

export type ReportKind = (typeof REPORT_KINDS)[number];

/** kind → 报工单中文名（展示/待办标题用，引擎与存储只认 kind）。 */
const REPORT_KIND_LABELS: Readonly<Record<ReportKind, string>> = {
  part: '零件报工',
  assembly: '装配报工',
  electrical: '电气报工',
  aftermarket: '售后报工',
  oddjob: '零工报工',
};

export function reportKindLabel(kind: string): string {
  return (REPORT_KIND_LABELS as Readonly<Record<string, string>>)[kind] ?? kind;
}

// ---- 报工单状态机（pending → reported → verified + revoked 终态旁支） ----

/** 报工单配置标识（机器事件账本聚合类型同词）。 */
export const REPORT_FLOW_ID = 'work-report';

/** 四态 id（三态主干 + 撤销终态；配置内声明顺序 = 主干推进序）。 */
export const REPORT_STATE_IDS = ['pending', 'reported', 'verified', 'revoked'] as const;

export type ReportStateId = (typeof REPORT_STATE_IDS)[number];

/** 四态目录（id ↔ 中文名；未知 id 原样返回）。 */
export const REPORT_STATES: ReadonlyArray<{ readonly id: ReportStateId; readonly label: string }> =
  REPORT_STATE_IDS.map((id, index) => ({
    id,
    label: ['待报', '已报', '已核查', '已撤销'][index] as string,
  }));

export function reportStateLabel(state: string): string {
  return REPORT_STATES.find((entry) => entry.id === state)?.label ?? state;
}

/** 产出净额态集合（趋势/进度口径：reported+verified 计产出，revoked 冲销不计）。 */
export const REPORT_OUTPUT_STATES: ReadonlySet<string> = new Set(['reported', 'verified']);

/**
 * 报工单默认配置（初版合法集，共 4 条迁移）：
 * 主干 2 条：pending→reported→verified；撤销 2 条：reported/verified→revoked
 * （已核查撤销需重报——revoked 后同派工单重新 submit 新单）。
 * revoked 是唯一终态（engine-flow final 态不得有出边——verified 有 REVOKE 出
 * 边故不标 final：业务上 verified 是主干完成态，但保留核查撤销旁支）。
 * 配置整体可替换（ADR-0010 条 2：换配置 = 换合法集）。
 */
export const DEFAULT_REPORT_FLOW_CONFIG: ApprovalFlowConfig = defineApprovalFlowConfig({
  schemaVersion: 1,
  flowId: REPORT_FLOW_ID,
  initial: 'pending',
  states: [
    { id: 'pending' },
    { id: 'reported' },
    { id: 'verified' },
    { id: 'revoked', final: true },
  ],
  transitions: [
    { from: 'pending', event: 'SUBMIT', to: 'reported', eventAction: 'submitted' },
    { from: 'reported', event: 'VERIFY', to: 'verified', eventAction: 'verified' },
    { from: 'reported', event: 'REVOKE', to: 'revoked', eventAction: 'revoked' },
    { from: 'verified', event: 'REVOKE', to: 'revoked', eventAction: 'revoked' },
  ],
});

// ---- 默认配置层（客户口径整体替换，不属内核） ----

/**
 * 可报工的派工单状态集（默认配置）。初版口径（合同 §8 open question 裁定）：
 * 派工单须处于 assigned/executing——draft（未派到人）不可报，done/cancelled
 * 不可报（done 后再报 = 超期补报，走撤销重派口径）。对账阶段按活系统行为校正。
 */
export const DEFAULT_REPORTABLE_DISPATCH_STATES: readonly string[] = ['assigned', 'executing'];

/**
 * 批量报工单次上限（默认配置；合同 §8 open question：移动端弱网分片与上限在
 * M5 性能验收时定，不影响本合同——初版给缺省值，配置化整体替换）。
 */
export const DEFAULT_REPORT_BATCH_LIMIT = 50;

/**
 * 末道报工触发质检的 kind 集（默认配置：自制零件——inspection intake 合同
 * "末道工序才触发自制质检"）。装配/电气的终检归属对账阶段再扩，经服务选项
 * 整体替换，不改代码。
 */
export const DEFAULT_FINAL_INSPECTION_KINDS: readonly ReportKind[] = ['part'];
