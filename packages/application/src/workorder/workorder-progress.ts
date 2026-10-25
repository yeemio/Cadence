/**
 * workorder 只读聚合视图（M2-W1，纯函数——查询路径无副作用）。
 *
 * 三类进度与交付态势的口径：
 *  - 项目进度 = 计划（计划交付/包材到货）vs 实际（九态迁移史 + 当前态 + 倒计时）；
 *  - 机加工进度 = 进度事实按 图号×工序 上卷（reporting/dispatch 只读订阅）；
 *  - 装配调试进度 = 进度事实按工序上卷（stage=assembly）；
 *  - 交付态势 = 风险等级（初版口径：逾期/临期/正常，窗口可注入）+ 交付倒计时
 *    + 九态分布计数（工作台 KPI 卡数据源）。
 * 风险等级与倒计时为**初版口径**（对账阶段以活系统行为校正——02-workorder
 * §7 对账要点），窗口天数经模块选项注入，不写死。
 */
import type { ApprovalEvent } from '@smes/engine-flow';
import { WORK_ORDER_STATE_IDS, type WorkOrderStateId } from './workorder-config.js';
import type { ProgressFact } from './workorder-ports.js';
import type { WorkOrder } from './workorder-stores.js';

// ---- 机加工进度（图号 × 工序上卷） ----

export interface MachiningProgressRow {
  readonly drawingNo: string;
  readonly operationId: string;
  readonly doneQty: number;
  readonly totalQty: number;
  readonly status: 'pending' | 'in_progress' | 'done';
}

/** 机加工上卷：stage=machining 事实按 (图号, 工序) 聚合（数量求和，状态按行集推导）。 */
export function rollupMachiningProgress(facts: readonly ProgressFact[]): readonly MachiningProgressRow[] {
  return rollupBy(
    facts.filter((fact) => fact.stage === 'machining'),
    (fact) => (fact.drawingNo === null ? null : `${fact.drawingNo}\u0000${fact.operationId}`),
  ).map(({ key, doneQty, totalQty, status }) => ({
    drawingNo: key.split('\u0000')[0] as string,
    operationId: key.split('\u0000')[1] as string,
    doneQty,
    totalQty,
    status,
  }));
}

// ---- 装配调试进度（工序上卷） ----

export interface AssemblyProgressRow {
  readonly operationId: string;
  readonly doneQty: number;
  readonly totalQty: number;
  readonly status: 'pending' | 'in_progress' | 'done';
}

/** 装配调试上卷：stage=assembly 事实按工序聚合。 */
export function rollupAssemblyProgress(facts: readonly ProgressFact[]): readonly AssemblyProgressRow[] {
  return rollupBy(facts.filter((fact) => fact.stage === 'assembly'), (fact) => fact.operationId).map(
    ({ key, doneQty, totalQty, status }) => ({ operationId: key, doneQty, totalQty, status }),
  );
}

interface RolledRow {
  readonly key: string;
  readonly doneQty: number;
  readonly totalQty: number;
  readonly status: 'pending' | 'in_progress' | 'done';
}

function rollupBy(
  facts: readonly ProgressFact[],
  keyOf: (fact: ProgressFact) => string | null,
): readonly RolledRow[] {
  const byKey = new Map<string, { doneQty: number; totalQty: number }>();
  for (const fact of facts) {
    const key = keyOf(fact);
    if (key === null) continue; // 机加工行缺图号：不可上卷（跳过，不静默归组）
    const current = byKey.get(key) ?? { doneQty: 0, totalQty: 0 };
    current.doneQty += fact.doneQty;
    current.totalQty += fact.totalQty;
    byKey.set(key, current);
  }
  return [...byKey.entries()]
    .map(([key, aggregated]) => ({
      key,
      doneQty: aggregated.doneQty,
      totalQty: aggregated.totalQty,
      status: deriveStatus(aggregated.doneQty, aggregated.totalQty),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function deriveStatus(doneQty: number, totalQty: number): 'pending' | 'in_progress' | 'done' {
  if (totalQty > 0 && doneQty >= totalQty) return 'done';
  if (doneQty > 0) return 'in_progress';
  return 'pending';
}

// ---- 项目进度（计划 vs 实际） ----

/** 迁移里程碑（机器账本 transitioned 事件的时序读法）。 */
export interface WorkOrderMilestone {
  readonly from: string;
  readonly to: string;
  /** 配置迁移命令动词（对账锚点）。 */
  readonly event: string;
  readonly at: string;
  readonly actor: string;
  readonly objectVersion: number;
}

/** 迁移史：机器事件账本按发生序映射为里程碑列表（含回退——历史即事实）。 */
export function milestoneHistory(machineEvents: readonly ApprovalEvent[]): readonly WorkOrderMilestone[] {
  return machineEvents.map((event) => ({
    from: event.payload.from,
    to: event.payload.to,
    event: event.payload.event,
    at: event.occurredAt,
    actor: event.payload.actor,
    objectVersion: event.payload.objectVersion,
  }));
}

/** 交付倒计时（日历日；正数 = 未到期，负数 = 已逾期天数；无计划交付 = null）。 */
export function daysToDelivery(plannedDeliveryAt: string | null, now: string): number | null {
  if (plannedDeliveryAt === null) return null;
  const planned = Date.parse(plannedDeliveryAt);
  const current = Date.parse(now);
  if (Number.isNaN(planned) || Number.isNaN(current)) return null;
  // 截断取整：未到期向下取整（余数不足一日不算），已逾期取已整天数（-5.4 天 = -5）
  return Math.trunc((planned - current) / 86_400_000);
}

// ---- 交付态势（风险等级 + 倒计时 + 九态分布） ----

export type DeliveryRiskLevel = 'overdue' | 'at_risk' | 'on_track';

/** 初版风险口径：逾期（已超计划交付）/ 临期（窗口内未到期）/ 正常；无计划 = on_track。 */
export function deliveryRiskLevel(
  plannedDeliveryAt: string | null,
  now: string,
  riskWindowDays: number,
): DeliveryRiskLevel {
  const days = daysToDelivery(plannedDeliveryAt, now);
  if (days === null) return 'on_track';
  if (days < 0) return 'overdue';
  if (days <= riskWindowDays) return 'at_risk';
  return 'on_track';
}

export interface DeliverySituationRow {
  readonly workOrderId: string;
  readonly projectName: string;
  readonly state: string;
  readonly plannedDeliveryAt: string | null;
  readonly daysToDelivery: number | null;
  readonly riskLevel: DeliveryRiskLevel;
}

/** 九态分布计数（全部九态零填充——工作台 KPI 卡口径）。 */
export function stateDistribution(orders: readonly WorkOrder[]): Readonly<Record<WorkOrderStateId, number>> {
  const counts = Object.fromEntries(WORK_ORDER_STATE_IDS.map((id) => [id, 0])) as Record<WorkOrderStateId, number>;
  for (const order of orders) {
    if (Object.hasOwn(counts, order.state)) counts[order.state as WorkOrderStateId] += 1;
  }
  return counts;
}
