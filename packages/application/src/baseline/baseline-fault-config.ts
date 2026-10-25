/**
 * baseline 故障单状态机配置与默认口径（M2-W7 P2，合同 01-baseline.md §2：
 * FaultReport `open → assigned → resolved`（+reject 回退）；ADR-0010 条 2：
 * 状态集是配置，不是内核——配置整体可替换，编排代码零改动）。
 *
 * 分层标注（合同 §2 / ADR-0010 三层）：
 *  - 内核概念 = 故障单流转语义（上报→派修→闭环 + 拒单回退），由 engine-flow
 *    内核承载迁移求值；
 *  - 模块 schema = 实体/命令/事件（stores/events 文件，版本化）；
 *  - 默认配置 = 本文件初版状态机与推送节点（IM 推送挂在 assigned 进入事件，
 *    由 service 在 ASSIGN 迁移落账后触发——推送节点属默认配置层，随客户口径
 *    调整，不属内核）。
 *
 * 迁移集（v1 初版合法集）：
 *   open     --ASSIGN-->  assigned   上报即派修（fault.report 命令内完成：
 *                          建单落 open 投影 → 驱动 ASSIGN；进入 assigned 触发
 *                          IM 推送 + 待办——Done-when：维修人员收到 IM 待办）
 *   assigned --RESOLVE--> resolved   fault.resolve 闭环（消待办；终态）
 *   assigned --REJECT-->  open       拒单回退（维修人员无法处理退回待派修池；
 *                          v1 命令面（合同 §3 最小集）无独立 reject 命令，
 *                          本迁移随配置供给，后续命令动词接入即生效）
 */
import { defineApprovalFlowConfig, type ApprovalFlowConfig } from '@smes/engine-flow';

/** 故障单状态机配置标识。 */
export const FAULT_REPORT_FLOW_ID = 'baseline-fault-report';

/** 故障单状态 id（合同 §2 表达序）。 */
export const FAULT_REPORT_STATE_IDS = ['open', 'assigned', 'resolved'] as const;

export type FaultReportStateId = (typeof FAULT_REPORT_STATE_IDS)[number];

/** 三态目录（id ↔ 合同中文名；展示/待办标题用，引擎只认 id）。 */
export const FAULT_REPORT_STATES: ReadonlyArray<{
  readonly id: FaultReportStateId;
  readonly label: string;
}> = FAULT_REPORT_STATE_IDS.map((id, index) => ({
  id,
  label: ['已上报', '已派修', '已闭环'][index] as string,
}));

/** 状态 id → 中文名（未知 id 原样返回，配置换代不炸展示层）。 */
export function faultReportStateLabel(state: string): string {
  return FAULT_REPORT_STATES.find((entry) => entry.id === state)?.label ?? state;
}

/** 故障单默认配置（初版合法集；open 非终态、resolved 终态）。 */
export const DEFAULT_FAULT_REPORT_FLOW_CONFIG: ApprovalFlowConfig = defineApprovalFlowConfig({
  schemaVersion: 1,
  flowId: FAULT_REPORT_FLOW_ID,
  initial: 'open',
  states: [{ id: 'open' }, { id: 'assigned' }, { id: 'resolved', final: true }],
  transitions: [
    { from: 'open', event: 'ASSIGN', to: 'assigned', eventAction: 'assigned' },
    { from: 'assigned', event: 'RESOLVE', to: 'resolved', eventAction: 'resolved' },
    { from: 'assigned', event: 'REJECT', to: 'open', eventAction: 'rejected' },
  ],
});
