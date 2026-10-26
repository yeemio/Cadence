/**
 * dispatch 状态机配置与六类词汇（M2-W6，ADR-0010 条 2：状态集是配置，不是内核）。
 *
 * 一份 engine-flow ApprovalFlowConfig 形态配置（配置驱动、可整体替换），六类
 * 派工单共用同一四态主干 + 撤销支（04-dispatch.md §2 状态机）：
 *
 *   draft ──ASSIGN──▶ assigned ──START──▶ executing ──COMPLETE──▶ done
 *    │                    │
 *    └──────CANCEL───────┘──▶ cancelled（撤销：draft/assigned 可撤；发事件，
 *                              reporting 侧禁止再对已撤派工单报工）
 *
 * 外协单另有回厂联动节点：done 时经 InspectionIntakePort 触发 inspection 外协
 * 质检（服务编排，非状态机节点——状态集不变）。
 *
 * 分层标注（ADR-0010 三层）：
 *  - 内核概念 = 四态状态集与迁移语义（engine-flow 内核承载）；
 *  - 模块 schema = 六类 kind / 命令 / 事件（本模块版本化）；
 *  - 默认配置 = 齐套拦截规则（DEFAULT_KIT_GATED_KINDS）与六类单初版配置
 *    （实施时按客户口径整体替换，不属内核）。
 */
import { defineApprovalFlowConfig, type ApprovalFlowConfig } from '@smes/engine-flow';

// ---- 六类派工 kind（04-dispatch.md §2；功能项 38~43） ----

/** 六类派工 kind：零件/外协/装配/电气/售后/零工。 */
export const DISPATCH_KINDS = [
  'part',
  'outsourcing',
  'assembly',
  'electrical',
  'aftermarket',
  'oddjob',
] as const;

export type DispatchKind = (typeof DISPATCH_KINDS)[number];

/** kind → 派工单中文名（展示/待办标题用，引擎与存储只认 kind）。 */
const DISPATCH_KIND_LABELS: Readonly<Record<DispatchKind, string>> = {
  part: '零件派工',
  outsourcing: '外协派工',
  assembly: '装配派工',
  electrical: '电气派工',
  aftermarket: '售后派工',
  oddjob: '零工派工',
};

export function dispatchKindLabel(kind: string): string {
  return (DISPATCH_KIND_LABELS as Readonly<Record<string, string>>)[kind] ?? kind;
}

// ---- 齐套放行拦截（默认配置层） ----

/**
 * 齐套放行拦截覆盖的 kind（默认配置：装配/电气——流程拆解"齐套后才放装配派工"）。
 * 拦截规则 = workorder KitCheck 最新快照 complete 才放行创建；未齐套/无核查记录
 * 拒绝创建（硬拦截）。客户口径调整 = 经服务选项整体替换本集合，不改代码。
 */
export const DEFAULT_KIT_GATED_KINDS: readonly DispatchKind[] = ['assembly', 'electrical'];

// ---- 派工单状态机（draft → assigned → executing → done + cancelled） ----

/** 派工单配置标识。 */
export const DISPATCH_FLOW_ID = 'dispatch-order';

/** 五态 id（四态主干 + 撤销终态；配置内声明顺序 = 主干推进序）。 */
export const DISPATCH_STATE_IDS = ['draft', 'assigned', 'executing', 'done', 'cancelled'] as const;

export type DispatchStateId = (typeof DISPATCH_STATE_IDS)[number];

/** 五态目录（id ↔ 中文名；未知 id 原样返回）。 */
export const DISPATCH_STATES: ReadonlyArray<{ readonly id: DispatchStateId; readonly label: string }> =
  DISPATCH_STATE_IDS.map((id, index) => ({
    id,
    label: ['草稿', '已派工', '执行中', '完工', '已撤销'][index] as string,
  }));

export function dispatchStateLabel(state: string): string {
  return DISPATCH_STATES.find((entry) => entry.id === state)?.label ?? state;
}

/** 可撤销态集合（draft/assigned；executing 起不可撤——合同 §2 撤销口径）。 */
export const DISPATCH_CANCELLABLE_STATES: ReadonlySet<string> = new Set(['draft', 'assigned']);

/**
 * 派工单默认配置（初版合法集，共 5 条迁移）：
 * 主干 3 条：draft→assigned→executing→done；
 * 撤销 2 条：draft/assigned→cancelled（终态）。
 * done / cancelled 为终态。配置整体可替换（ADR-0010 条 2：换配置 = 换合法集）。
 */
export const DEFAULT_DISPATCH_FLOW_CONFIG: ApprovalFlowConfig = defineApprovalFlowConfig({
  schemaVersion: 1,
  flowId: DISPATCH_FLOW_ID,
  initial: 'draft',
  states: [
    { id: 'draft' },
    { id: 'assigned' },
    { id: 'executing' },
    { id: 'done', final: true },
    { id: 'cancelled', final: true },
  ],
  transitions: [
    { from: 'draft', event: 'ASSIGN', to: 'assigned', eventAction: 'assigned' },
    { from: 'assigned', event: 'START', to: 'executing', eventAction: 'started' },
    { from: 'executing', event: 'COMPLETE', to: 'done', eventAction: 'completed' },
    { from: 'draft', event: 'CANCEL', to: 'cancelled', eventAction: 'cancelled' },
    { from: 'assigned', event: 'CANCEL', to: 'cancelled', eventAction: 'cancelled' },
  ],
});

// ---- 占用互斥（RREQ-DP-021，fix-wave-6 6a-1） ----

/** 终态集（done/cancelled）——活跃（非终态）派工单占用同工序键。 */
export const DISPATCH_TERMINAL_STATES: ReadonlySet<string> = new Set(['done', 'cancelled']);

/** 活跃（非终态）判定：同工序占用互斥的占用口径（撤销/完工即释放）。 */
export function isDispatchOrderActive(state: string): boolean {
  return !DISPATCH_TERMINAL_STATES.has(state);
}

// ---- 外协明细行状态（RREQ-DP-031：待派工/已派工/已质检/已取消） ----

/** 外协明细行状态 id 集（源文档 7.1 字典 outsource_dispatch_item_status 的我方形态）。 */
export const OUTSOURCING_LINE_STATUS_IDS = ['pending', 'dispatched', 'inspected', 'cancelled'] as const;

export type OutsourcingLineStatus = (typeof OUTSOURCING_LINE_STATUS_IDS)[number];

const OUTSOURCING_LINE_STATUS_LABELS: Readonly<Record<OutsourcingLineStatus, string>> = {
  pending: '待派工',
  dispatched: '已派工',
  inspected: '已质检',
  cancelled: '已取消',
};

export function outsourcingLineStatusLabel(status: string): string {
  return (OUTSOURCING_LINE_STATUS_LABELS as Readonly<Record<string, string>>)[status] ?? status;
}

/**
 * 明细行状态推导（快照纪律：行级只落取消事实，其余按父派工单状态推导——与源
 * 文档 7.1「历史数据回填规则」同构的统一推导口径）：
 *  - 行已取消（cancelledAt 非空）→ cancelled；
 *  - 父单 done → inspected（回厂质检已触发）；父单 draft → pending；
 *  - 父单 cancelled → cancelled（父撤即行取消）；assigned/executing → dispatched。
 */
export function outsourcingLineStatusOf(
  line: { readonly cancelledAt: string | null },
  orderState: string,
): OutsourcingLineStatus {
  if (line.cancelledAt !== null) return 'cancelled';
  if (orderState === 'done') return 'inspected';
  if (orderState === 'draft') return 'pending';
  if (orderState === 'cancelled') return 'cancelled';
  return 'dispatched';
}

// ---- 进度上卷阶段映射（workorder ProgressFact 的 stage 词汇镜像） ----

/**
 * kind → 进度上卷阶段（workorder 三类进度的 stage 口径，只读镜像不引类型）：
 *  - part → machining（机加工：图号×工序上卷）；
 *  - assembly / electrical → assembly（装配调试：工序上卷）；
 *  - outsourcing / aftermarket / oddjob → 不进 workorder 上卷（外协回厂走
 *    inspection、售后/零工不属生产进度主线）→ null。
 */
export function progressStageOfDispatchKind(kind: string): 'machining' | 'assembly' | null {
  if (kind === 'part') return 'machining';
  if (kind === 'assembly' || kind === 'electrical') return 'assembly';
  return null;
}
