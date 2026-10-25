/**
 * issue 状态词汇与参与规则（U1，发料任务/发料记录——A11 增量，词汇纪律
 * ADR-0010：issue/task/line/record/express 均为离散制造通用词，与既有
 * stock.issue / PartsIssuePort 同族）。
 *
 * 与 legacy 发料文档的口径映射（行为以文档为准、词汇通用化）：
 *  - 发料任务 = IssueTask；唯一业务维度 = 工作令 + 设备 + 派工类型（装配/
 *    电气），外加整线装配外购设备归拢单（rollup，一工作令一条、设备维为空）；
 *  - 明细子行 = IssueTaskLine（类别 part/standard/electrical/equipment——
 *    与 listing 四类清单 kind 同词）；
 *  - 任务状态三态由汇总推导（not-started=无有效发料记录；issuing=有记录
 *    且参与类别仍有未完成行；done=参与类别行均 已发≥总需求），无独立
 *    状态机——不发机器事件，只落投影 + 域事件；
 *  - 派工触发生成/补全子行 = issue.sync.v1（dispatch 侧合流时经 IssueSyncPort
 *    注入钩子，本波不动 dispatch 源码）；
 *  - 生产发料排除配件申请来源的清单行（origin='aftermarket'，走配件发料域，
 *    本波只留排除语义）。
 */

// ---- 明细行类别（镜像 listing 四类清单 kind） ----

/** 发料明细行类别：part=零件（非标）/ standard=标准件 / electrical=电气件 / equipment=外购设备。 */
export const ISSUE_LINE_KINDS = ['part', 'standard', 'electrical', 'equipment'] as const;

export type IssueLineKind = (typeof ISSUE_LINE_KINDS)[number];

/** 类别 → 中文名（展示/标签用；引擎与存储只认 kind）。 */
const ISSUE_LINE_KIND_LABELS: Readonly<Record<IssueLineKind, string>> = {
  part: '非标件',
  standard: '标准件',
  electrical: '电气件',
  equipment: '外购设备',
};

export function issueLineKindLabel(kind: string): string {
  return (ISSUE_LINE_KIND_LABELS as Readonly<Record<string, string>>)[kind] ?? kind;
}

// ---- 触发派工类型（镜像 dispatch 六类中的两类；不 import dispatch 源码） ----

/** 触发发料任务的派工类型：assembly=装配 / electrical=电气。 */
export const ISSUE_DISPATCH_KINDS = ['assembly', 'electrical'] as const;

export type IssueDispatchKind = (typeof ISSUE_DISPATCH_KINDS)[number];

/** 派工类型 → 工作内容标签（快照展示用）。 */
const ISSUE_DISPATCH_KIND_LABELS: Readonly<Record<IssueDispatchKind, string>> = {
  assembly: '装配',
  electrical: '电气接线',
};

export function issueDispatchKindLabel(kind: string): string {
  return (ISSUE_DISPATCH_KIND_LABELS as Readonly<Record<string, string>>)[kind] ?? kind;
}

// ---- 任务状态（汇总推导，非状态机） ----

/** 任务状态：not-started=未开始 / issuing=发料中 / done=已完成。 */
export const ISSUE_TASK_STATES = ['not-started', 'issuing', 'done'] as const;

export type IssueTaskState = (typeof ISSUE_TASK_STATES)[number];

/** 状态 id ↔ 中文名（未知 id 原样返回）。 */
export const ISSUE_TASK_STATE_ENTRIES: ReadonlyArray<{ readonly id: IssueTaskState; readonly label: string }> =
  ISSUE_TASK_STATES.map((id, index) => ({
    id,
    label: ['未开始', '发料中', '已完成'][index] as string,
  }));

export function issueTaskStateLabel(state: string): string {
  return ISSUE_TASK_STATE_ENTRIES.find((entry) => entry.id === state)?.label ?? state;
}

/**
 * 派工类型 × 归拢 → 参与完成判定的行类别集（文档 1.5）：
 *  - 装配（自制）：part + standard（电气行不存在即不参与）；
 *  - 电气：electrical；
 *  - 装配归拢（rollup）：equipment。
 */
export function participationKinds(dispatchKind: IssueDispatchKind, rollup: boolean): readonly IssueLineKind[] {
  if (rollup) return ['equipment'];
  return dispatchKind === 'assembly' ? ['part', 'standard'] : ['electrical'];
}

/**
 * 派工类型 × 归拢 → 允许去发料（确认发料）的行类别集（文档 2.3.1）：
 *  - 装配（自制）：part + standard；
 *  - 电气：electrical；
 *  - 装配归拢：equipment。
 */
export function operableKinds(dispatchKind: IssueDispatchKind, rollup: boolean): readonly IssueLineKind[] {
  return participationKinds(dispatchKind, rollup);
}

// ---- 单号前缀（人读可辨；全串唯一由 uuidv7 尾段保证，不设计数器） ----

/** 发料任务号前缀：装配自制 ISS-ASM- / 电气 ISS-ELEC- / 装配归拢 ISS-ASM-ROLLUP-。 */
export function issueTaskNoPrefix(dispatchKind: IssueDispatchKind, rollup: boolean): string {
  if (rollup) return 'ISS-ASM-ROLLUP-';
  return dispatchKind === 'assembly' ? 'ISS-ASM-' : 'ISS-ELEC-';
}

/** 发料记录号前缀。 */
export const ISSUE_RECORD_NO_PREFIX = 'ISS-REC-';

// ---- 发料记录状态（投影态：active 有效 / revoked 已撤销；有效口径=计入已发累计） ----

/** 发料记录状态：active=有效 / revoked=已撤销（整单撤销后不再计入已发累计）。 */
export const ISSUE_RECORD_STATES = ['active', 'revoked'] as const;

export type IssueRecordState = (typeof ISSUE_RECORD_STATES)[number];

// ---- 快递单（发货头元数据；对象存储零依赖——图片只存引用串） ----

/** 发货图片引用数上限（文档口径：最多 6 张）。 */
export const ISSUE_EXPRESS_MAX_IMAGES = 6;

// ---- 输入规模上界（与 dispatch 输入口径对齐） ----

/** 单次同步设备引用数上限。 */
export const ISSUE_SYNC_MAX_EQUIPMENT_REFS = 200;

/** 单次确认发行数上限。 */
export const ISSUE_CONFIRM_MAX_LINES = 500;

/** 单行库位分配数上限。 */
export const ISSUE_MAX_ALLOCATIONS_PER_LINE = 50;

/** 数量上界：(0, 1e9]。 */
export const ISSUE_MAX_QTY = 1_000_000_000;
