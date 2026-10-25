/**
 * maintenance 默认配置层（M3，m3-drafts/02-maintenance.md v1.0 §2 分层标注）。
 *
 * 三层落位（ADR-0010）：
 *  - 内核概念（engine-flow 承载）：任务状态集与迁移语义 = MAINTENANCE_TASK_FLOW_CONFIG
 *    （ApprovalFlowConfig 形态，配置驱动可整体替换——scheduled → executing → done
 *    + cancelled 回退支，仅 scheduled 可撤）；三态记录 append-only 纪律在存储端口
 *    合同（maintenance-stores.ts）；
 *  - 模块 schema：实体/命令/事件（本包版本化，见 stores/events/input）；
 *  - 默认配置（本文件，实施时按客户保养制度调整，不属内核）：周期枚举初版
 *    （daily/interval-days）、任务来源/类别枚举、到期扫描回填上界、
 *    plan-due 任务类别推导规则。
 */
import { defineApprovalFlowConfig, type ApprovalFlowConfig } from '@smes/engine-flow';
import { MaintenanceInputError } from './maintenance-errors.js';

// ---- 任务状态机（合同 §2；状态集是配置，不是内核） ----

/** 维保任务状态机配置标识。 */
export const MAINTENANCE_TASK_FLOW_ID = 'maintenance-task';

/** 任务状态 id（配置内声明顺序 = 合同 §2 表达序）。 */
export const MAINTENANCE_TASK_STATE_IDS = ['scheduled', 'executing', 'done', 'cancelled'] as const;

export type MaintenanceTaskState = (typeof MAINTENANCE_TASK_STATE_IDS)[number];

/** 四态目录（id ↔ 合同中文名；展示/待办标题用，引擎只认 id）。 */
export const MAINTENANCE_TASK_STATES: ReadonlyArray<{
  readonly id: MaintenanceTaskState;
  readonly label: string;
}> = MAINTENANCE_TASK_STATE_IDS.map((id, index) => ({
  id,
  label: ['已安排', '执行中', '已完成', '已取消'][index] as string,
}));

/** 状态 id → 中文名（未知 id 原样返回，配置换代不炸展示层）。 */
export function maintenanceTaskStateLabel(state: string): string {
  return MAINTENANCE_TASK_STATES.find((entry) => entry.id === state)?.label ?? state;
}

/** 命令动词 ↔ 迁移动词（SCREAMING_SNAKE_CASE，engine-flow 规则口径）。 */
export const TASK_TRANSITION_EVENTS = {
  start: 'START',
  complete: 'COMPLETE',
  cancel: 'CANCEL',
} as const;

/**
 * 任务默认状态机（初版合法集）：
 *   scheduled --START--> executing      开始执行（点检/保养/维修作业开式）
 *   executing --COMPLETE--> done        完成（终态；三态记录另行 append 留痕）
 *   scheduled --CANCEL--> cancelled     撤销（终态；仅 scheduled 可撤，合同 §2）
 * done/cancelled 为终态；executing 不可撤（需撤单走处置纪律，v1 不提供）。
 */
export const DEFAULT_MAINTENANCE_TASK_FLOW_CONFIG: ApprovalFlowConfig = defineApprovalFlowConfig({
  schemaVersion: 1,
  flowId: MAINTENANCE_TASK_FLOW_ID,
  initial: 'scheduled',
  states: [
    { id: 'scheduled' },
    { id: 'executing' },
    { id: 'done', final: true },
    { id: 'cancelled', final: true },
  ],
  transitions: [
    { from: 'scheduled', event: 'START', to: 'executing', eventAction: 'started' },
    { from: 'executing', event: 'COMPLETE', to: 'done', eventAction: 'completed' },
    { from: 'scheduled', event: 'CANCEL', to: 'cancelled', eventAction: 'cancelled' },
  ],
});

/**
 * 迁移解析（纯函数：读配置规则表——状态集与迁移语义的唯一裁判）。
 * 返回 null = 该状态对该动词无规则（如 executing 撤单）；配置整体替换即改行为。
 */
export function resolveTaskTransition(
  config: ApprovalFlowConfig,
  from: string,
  verb: string,
): { readonly to: string } | null {
  const rule = config.transitions.find((candidate) => candidate.from === from && candidate.event === verb);
  return rule === undefined ? null : { to: rule.to };
}

// ---- 任务来源与类别（合同 §2；模块 schema 词汇） ----

/** 任务来源三词：plan-due 计划到期 / fault 故障联动 / manual 手工。 */
export const MAINTENANCE_TASK_SOURCES = ['plan-due', 'fault', 'manual'] as const;
export type MaintenanceTaskSource = (typeof MAINTENANCE_TASK_SOURCES)[number];

export const MAINTENANCE_TASK_SOURCE_LABELS: Readonly<Record<MaintenanceTaskSource, string>> = {
  'plan-due': '计划到期',
  fault: '故障联动',
  manual: '手工',
};

/** 任务类别三词（与三态记录 kind 同词族）：repair 维修 / upkeep 保养 / checkpoint 点检。 */
export const MAINTENANCE_TASK_KINDS = ['repair', 'upkeep', 'checkpoint'] as const;
export type MaintenanceTaskKind = (typeof MAINTENANCE_TASK_KINDS)[number];

export const MAINTENANCE_TASK_KIND_LABELS: Readonly<Record<MaintenanceTaskKind, string>> = {
  repair: '维修',
  upkeep: '保养',
  checkpoint: '点检',
};

/** 三态记录 kind 判别词（与任务类别同词族，合同 §6 kind 判别三态）。 */
export type MaintenanceActivityKind = MaintenanceTaskKind;

/** 来源/类别合法性判定（词汇表门禁；未知词显式拒绝，不静默）。 */
export function isTaskSource(value: string): value is MaintenanceTaskSource {
  return (MAINTENANCE_TASK_SOURCES as readonly string[]).includes(value);
}

export function isTaskKind(value: string): value is MaintenanceTaskKind {
  return (MAINTENANCE_TASK_KINDS as readonly string[]).includes(value);
}

/**
 * plan-due 任务类别推导（默认配置层规则，合同 §10：按客户保养制度调整）：
 * 计划含点检项 → checkpoint（保养动作可在同任务内随记录补录）；
 * 纯保养计划（无点检项）→ upkeep；repair 不由计划推导（维修任务来自 fault/manual）。
 */
export function planDueTaskKind(plan: { readonly checkpoints: readonly unknown[] }): MaintenanceTaskKind {
  return plan.checkpoints.length > 0 ? 'checkpoint' : 'upkeep';
}

// ---- 维保周期（合同 §2 版本化数据；默认配置=周期枚举初版） ----

/** 维保周期：每日 或 按间隔天数（§10：按工时/按产量触发出现需求时扩形状，不进内核）。 */
export type MaintenanceCycle =
  | { readonly kind: 'daily' }
  | { readonly kind: 'interval'; readonly days: number };

/** 间隔天数上界：[1, 3650]（十年防误输上界）。 */
export const MAX_INTERVAL_DAYS = 3650;

/** 单计划点检项数上界：[0, 200]。 */
export const MAX_CHECKPOINTS = 200;

/** 单计划保养动作数上界：[0, 200]。 */
export const MAX_UPKEEP_ACTIONS = 200;

/**
 * 到期扫描单计划回填上界（默认配置层）：到期集合 = 锚点（计划首发时刻）至 asOf
 * 的全部到期 occurrence；为防陈年计划一次扫描爆量，单计划单次扫描最多生成最近
 * N 个到期（对账口径：同计划集合同 asOf 的生成集合仍确定——上界截尾是配置常数）。
 */
export const MAX_DUE_OCCURRENCES_PER_SCAN = 366;

/** 一天的毫秒数（UTC 整数日历口径）。 */
const DAY_MS = 86_400_000;

/**
 * 到期 occurrence（纯函数，对账锚：同计划（锚点+周期）同 asOf → 同生成集合）。
 *  - daily：按 UTC 日历日逐日一个 occurrence（key = d:YYYY-MM-DD，dueAt = 当日零点）；
 *  - interval：自锚点起第 k 个间隔窗口（key = i:k，dueAt = 锚点 + k×days）。
 * 返回按到期升序；asOf 早于锚点日/锚点 → 空集。
 */
export function dueOccurrences(
  cycle: MaintenanceCycle,
  anchorIso: string,
  asOfIso: string,
  cap = MAX_DUE_OCCURRENCES_PER_SCAN,
): readonly { readonly key: string; readonly dueAt: string }[] {
  const anchorMs = Date.parse(anchorIso);
  const asOfMs = Date.parse(asOfIso);
  if (Number.isNaN(anchorMs) || Number.isNaN(asOfMs) || asOfMs < anchorMs) return [];
  if (cycle.kind === 'daily') {
    const firstDay = Math.floor(anchorMs / DAY_MS);
    const lastDay = Math.floor(asOfMs / DAY_MS);
    const total = lastDay - firstDay + 1;
    const from = Math.max(0, total - cap);
    const occurrences: { key: string; dueAt: string }[] = [];
    for (let i = from; i < total; i += 1) {
      const dayMs = (firstDay + i) * DAY_MS;
      const day = new Date(dayMs).toISOString().slice(0, 10);
      occurrences.push({ key: `d:${day}`, dueAt: new Date(dayMs).toISOString() });
    }
    return occurrences;
  }
  const intervalMs = cycle.days * DAY_MS;
  const lastK = Math.floor((asOfMs - anchorMs) / intervalMs);
  const fromK = Math.max(0, lastK - cap + 1);
  const occurrences: { key: string; dueAt: string }[] = [];
  for (let k = fromK; k <= lastK; k += 1) {
    occurrences.push({ key: `i:${k}`, dueAt: new Date(anchorMs + k * intervalMs).toISOString() });
  }
  return occurrences;
}

// ---- 审核状态（版本化主数据口径） ----

/** 计划版本行审核状态：发布即 published（版本化主数据，同 payroll 规则）。 */
export const MAINTENANCE_PLAN_AUDIT_STATUS_PUBLISHED = 'published';

/** 三态记录审核状态：执行留痕即 recorded（append-only 事实）。 */
export const MAINTENANCE_ACTIVITY_AUDIT_STATUS_RECORDED = 'recorded';

// ---- 权限码（合同 §5 最小集） ----

/**
 * maintenance 权限码（登记进 casbin 策略面归组合根/总控；此处冻结词汇）。
 *   - maintenance:read         查询（数据权限：本人执行 vs 全部——"我的任务"走
 *                              本人，全部任务队列/历史/日历走全部；建议默认角色：
 *                              操作工=本人、班组长/设备员/厂长=全部）；
 *   - maintenance:plan-write   计划维护（18/19 计划定义面；建议默认角色：设备员）；
 *   - maintenance:task-arrange 任务安排（手工/故障联动建任务、due-scan 触发；
 *                              建议默认角色：班组长/设备员）；
 *   - maintenance:record       三态记录追加与任务迁移执行（125/126 移动同 API；
 *                              建议默认角色：操作工/维修工）。
 */
export const MAINTENANCE_PERMISSIONS = {
  read: 'maintenance:read',
  planWrite: 'maintenance:plan-write',
  taskArrange: 'maintenance:task-arrange',
  record: 'maintenance:record',
} as const;

export type MaintenancePermission = (typeof MAINTENANCE_PERMISSIONS)[keyof typeof MAINTENANCE_PERMISSIONS];

// ---- 工具（量纲门禁的配置侧实现） ----

/** 周期合法性判定（未知形状拒绝，不静默）。 */
export function isValidCycle(cycle: unknown): cycle is MaintenanceCycle {
  if (typeof cycle !== 'object' || cycle === null) return false;
  const record = cycle as Record<string, unknown>;
  if (record['kind'] === 'daily') return true;
  if (
    record['kind'] === 'interval' &&
    typeof record['days'] === 'number' &&
    Number.isInteger(record['days']) &&
    record['days'] >= 1 &&
    record['days'] <= MAX_INTERVAL_DAYS
  ) {
    return true;
  }
  return false;
}

/** ISO 日期时间判定。 */
export function isIsoDateTime(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/** 周期人读标签（呈现/事件注记用）。 */
export function cycleLabel(cycle: MaintenanceCycle): string {
  return cycle.kind === 'daily' ? '每日' : `每 ${cycle.days} 天`;
}

/** 正整数上界断言（配置常量门禁；违规抛 MaintenanceInputError）。 */
export function requireBoundedInt(value: number, min: number, max: number, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new MaintenanceInputError(`${what}须为 [${min}, ${max}] 内的整数：${JSON.stringify(value)}`);
  }
  return value;
}
