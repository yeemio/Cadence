/**
 * 运营总览视图模型（T 波 #1，覆盖矩阵 §3.4 #1）：四源聚合——工作台待办、
 * 交付态势、质检汇总、机加工时统计 → 总览卡片 + 下钻分组。与
 * hours.ts/inspection-views.ts/progress-views.ts 同一取舍：纯函数视图模型
 * （测试钉死），fetch 与 URL 在 apps/web 装配层（data/overviewApi.ts）。
 *
 * 后端合同（控制器实态，直返对象/信封形状一一对应）：
 * - GET /workbench/summary（workbench:read）→ WorkbenchSummary
 *   { user, openTotal, bySource:[{source,open}] }（workbench.service.ts:41）；
 * - GET /workorder/delivery-situation（workorder:read）→ WorkOrderDeliverySituation
 *   { orders:[{workOrderId,projectName,state,plannedDeliveryAt,daysToDelivery,
 *   riskLevel}], distribution:九态零填充计数, generatedAt }
 *   （workorder.service.ts:1082；rows 已按倒计时升序，终态不计入）；
 * - GET /inspection/summary（inspection:read）→ InspectionSummary
 *   { pendingCount,passedCount,failedCount,closedCount,judgedCount,passRate,
 *   nonconformOpenCount,nonconformClosedCount,overdueCount,byKind,generatedAt }
 *   （inspection-summary.ts:60；passRate 0~1 四位小数，无判定 null）；
 * - GET /hours/machining/stats（hours:read）→ { stats:MachiningStatRow[] }
 *   { workOrderId,drawingNo,totalHours,totalOutput }（hours.service.ts:739，
 *   机加工种净额按工作令分组，null = 未关联工作令）。
 *
 * 权限码与后端端点一一对应（ADR-0010 通用词，常量取自各源模块——本文件
 * 不重复声明，聚合成 OVERVIEW_REQUIRED_PERMISSIONS 供路由守卫/测试引用）。
 */
import { HOURS_READ } from './hours.js';
import { INSPECTION_READ } from './inspection-views.js';
import { WORKORDER_READ } from './progress-views.js';
import type { PermissionCode } from './permissions.js';
import { WORKBENCH_READ } from './workbench.js';
import { parseWorkbenchSummaryResponse } from './workbench.js';
import type { WorkbenchSummaryView } from './workbench.js';

/** 总览页四源读取权限码（与四个 GET 端点同码；任一缺失对应卡片即不可读）。 */
export const OVERVIEW_REQUIRED_PERMISSIONS: readonly PermissionCode[] = [
  WORKBENCH_READ,
  WORKORDER_READ,
  INSPECTION_READ,
  HOURS_READ,
];

/** workbench:read 语义同源模块（重导出便于消费方单点引用，不重复声明）。 */
export { parseWorkbenchSummaryResponse };

// ---- 交付态势源（GET /workorder/delivery-situation） ----

/** 交付风险等级（与后端 DeliveryRiskLevel 同枚举：逾期/临期/正常）。 */
export type DeliveryRiskLevelView = 'overdue' | 'at_risk' | 'on_track';

/** 非终态工作令的交付态势行（后端已按倒计时升序）。 */
export interface DeliverySituationRowView {
  readonly workOrderId: string;
  readonly projectName: string;
  readonly state: string;
  readonly plannedDeliveryAt: string | null;
  /** 交付倒计时（日历日；正数=未到期，负数=已逾期天数；无计划交付=null）。 */
  readonly daysToDelivery: number | null;
  readonly riskLevel: DeliveryRiskLevelView;
}

export interface DeliverySituationView {
  readonly orders: readonly DeliverySituationRowView[];
  /** 九态分布计数（全量口径含终态；后端零填充）。 */
  readonly distribution: Readonly<Record<string, number>>;
  readonly generatedAt: string;
}

// ---- 质检汇总源（GET /inspection/summary） ----

/** 四类分桶行（队列口径：每类待检/已判/合格率/未闭环）。 */
export interface InspectionKindRowView {
  readonly kind: string;
  readonly pending: number;
  readonly passed: number;
  readonly failed: number;
  readonly closed: number;
  readonly judgedCount: number;
  readonly passRate: number | null;
  readonly nonconformOpen: number;
}

export interface InspectionSummaryView {
  readonly pendingCount: number;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly closedCount: number;
  readonly judgedCount: number;
  /** 合格率（0~1，四位小数；无判定 null）。 */
  readonly passRate: number | null;
  readonly nonconformOpenCount: number;
  readonly nonconformClosedCount: number;
  readonly overdueCount: number;
  readonly byKind: readonly InspectionKindRowView[];
  readonly generatedAt: string;
}

// ---- 机加工时源（GET /hours/machining/stats） ----

/** 机加工时统计行（净额按工作令分组；null = 未关联工作令）。 */
export interface MachiningStatRowView {
  readonly workOrderId: string | null;
  readonly drawingNo: string | null;
  readonly totalHours: number;
  readonly totalOutput: number;
}

// ---- 解析器 ----

export class OverviewViewsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverviewViewsError';
  }
}

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new OverviewViewsError(`${what} 形状非法：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OverviewViewsError(`字段 '${field}' 须为非空字符串`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new OverviewViewsError(`字段 '${field}' 须为字符串或 null`);
  }
  return value;
}

/** 计数（非负整数——后端计数口径）。 */
function requireCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new OverviewViewsError(`字段 '${field}' 须为非负整数`);
  }
  return value;
}

/** 净额量（有限数；净额口径允许小数与撤销后负值）。 */
function requireAmount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new OverviewViewsError(`字段 '${field}' 须为有限数值`);
  }
  return value;
}

/** 合格率（null 或 0~1）。 */
function optionalRate(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new OverviewViewsError(`字段 '${field}' 须为 null 或 0~1 数值`);
  }
  return value;
}

function optionalDays(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new OverviewViewsError(`字段 '${field}' 须为整数或 null`);
  }
  return value;
}

const RISK_LEVELS: readonly DeliveryRiskLevelView[] = ['overdue', 'at_risk', 'on_track'];
const RISK_LEVEL_SET: ReadonlySet<string> = new Set(RISK_LEVELS);

function requireRiskLevel(value: unknown, field: string): DeliveryRiskLevelView {
  if (typeof value !== 'string' || !RISK_LEVEL_SET.has(value)) {
    throw new OverviewViewsError(`字段 '${field}' 须为 'overdue'|'at_risk'|'on_track'`);
  }
  return value as DeliveryRiskLevelView;
}

/** 计数记录（键任意非空字符串——九态分布等；值为非负整数）。 */
function requireCountRecord(value: unknown, field: string): Readonly<Record<string, number>> {
  const record = requireObject(value, `字段 '${field}'`);
  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(record)) {
    result[requireString(key, `${field} 键`)] = requireCount(count, `${field}[${key}]`);
  }
  return result;
}

/** 解析 GET /workorder/delivery-situation 响应（直返视图对象）。 */
export function parseDeliverySituationResponse(input: unknown): DeliverySituationView {
  const record = requireObject(input, '交付态势响应');
  const orders = record['orders'];
  if (!Array.isArray(orders)) {
    throw new OverviewViewsError("交付态势响应缺 'orders' 数组");
  }
  const distribution = requireCountRecord(record['distribution'], 'distribution');
  return {
    orders: orders.map((row) => {
      const item = requireObject(row, 'orders 行');
      return {
        workOrderId: requireString(item['workOrderId'], 'workOrderId'),
        projectName: requireString(item['projectName'], 'projectName'),
        state: requireString(item['state'], 'state'),
        plannedDeliveryAt: optionalString(item['plannedDeliveryAt'], 'plannedDeliveryAt'),
        daysToDelivery: optionalDays(item['daysToDelivery'], 'daysToDelivery'),
        riskLevel: requireRiskLevel(item['riskLevel'], 'riskLevel'),
      };
    }),
    distribution,
    generatedAt: requireString(record['generatedAt'], 'generatedAt'),
  };
}

/** 解析 GET /inspection/summary 响应（直返视图对象）。 */
export function parseInspectionSummaryResponse(input: unknown): InspectionSummaryView {
  const record = requireObject(input, '质检汇总响应');
  const byKind = record['byKind'];
  if (!Array.isArray(byKind)) {
    throw new OverviewViewsError("质检汇总响应缺 'byKind' 数组");
  }
  return {
    pendingCount: requireCount(record['pendingCount'], 'pendingCount'),
    passedCount: requireCount(record['passedCount'], 'passedCount'),
    failedCount: requireCount(record['failedCount'], 'failedCount'),
    closedCount: requireCount(record['closedCount'], 'closedCount'),
    judgedCount: requireCount(record['judgedCount'], 'judgedCount'),
    passRate: optionalRate(record['passRate'], 'passRate'),
    nonconformOpenCount: requireCount(record['nonconformOpenCount'], 'nonconformOpenCount'),
    nonconformClosedCount: requireCount(record['nonconformClosedCount'], 'nonconformClosedCount'),
    overdueCount: requireCount(record['overdueCount'], 'overdueCount'),
    byKind: byKind.map((row) => {
      const item = requireObject(row, 'byKind 行');
      return {
        kind: requireString(item['kind'], 'kind'),
        pending: requireCount(item['pending'], 'pending'),
        passed: requireCount(item['passed'], 'passed'),
        failed: requireCount(item['failed'], 'failed'),
        closed: requireCount(item['closed'], 'closed'),
        judgedCount: requireCount(item['judgedCount'], 'judgedCount'),
        passRate: optionalRate(item['passRate'], 'passRate'),
        nonconformOpen: requireCount(item['nonconformOpen'], 'nonconformOpen'),
      };
    }),
    generatedAt: requireString(record['generatedAt'], 'generatedAt'),
  };
}

/** 解析 GET /hours/machining/stats 响应 { stats: [...] }。 */
export function parseMachiningStatsResponse(input: unknown): readonly MachiningStatRowView[] {
  const envelope = requireObject(input, '机加工时统计响应');
  const stats = envelope['stats'];
  if (!Array.isArray(stats)) {
    throw new OverviewViewsError("机加工时统计响应缺 'stats' 数组");
  }
  return stats.map((row) => {
    const item = requireObject(row, 'stats 行');
    return {
      workOrderId: optionalString(item['workOrderId'], 'workOrderId'),
      drawingNo: optionalString(item['drawingNo'], 'drawingNo'),
      totalHours: requireAmount(item['totalHours'], 'totalHours'),
      totalOutput: requireAmount(item['totalOutput'], 'totalOutput'),
    };
  });
}

// ---- 四源聚合（总览卡片 + 下钻分组，纯函数） ----

/** 聚合输入：四源各自解析后的视图（fetch 见 apps/web data/overviewApi.ts）。 */
export interface OverviewSources {
  readonly workbench: WorkbenchSummaryView;
  readonly delivery: DeliverySituationView;
  readonly inspection: InspectionSummaryView;
  readonly machining: readonly MachiningStatRowView[];
}

/** 卡片：我的待办（本人 open 计数按来源）。 */
export interface OverviewTodoCardView {
  readonly openTotal: number;
  readonly bySource: readonly { readonly source: string; readonly open: number }[];
}

/** 卡片：交付风险（非终态工作令按风险等级计数）。 */
export interface OverviewDeliveryCardView {
  readonly activeOrders: number;
  readonly overdue: number;
  readonly atRisk: number;
  readonly onTrack: number;
}

/** 卡片：质检态势（待检/合格率/未闭环/闭环超时）。 */
export interface OverviewInspectionCardView {
  readonly pendingCount: number;
  readonly passRate: number | null;
  readonly nonconformOpenCount: number;
  readonly overdueCount: number;
}

/** 卡片：机加工时净额（按工作令分组合计）。 */
export interface OverviewMachiningCardView {
  readonly workOrderCount: number;
  readonly unassignedCount: number;
  readonly totalHours: number;
  readonly totalOutput: number;
}

/** 下钻：交付风险分组（overdue→at_risk→on_track 定序，空组略过；组内保持后端倒计时升序）。 */
export interface OverviewRiskGroupView {
  readonly riskLevel: DeliveryRiskLevelView;
  readonly orders: readonly DeliverySituationRowView[];
}

/** 总览视图（卡片 ×4 + 下钻分组 ×4：待办来源/风险分组/质检分类/机加工时）。 */
export interface OverviewView {
  readonly todo: OverviewTodoCardView;
  readonly delivery: OverviewDeliveryCardView;
  readonly inspection: OverviewInspectionCardView;
  readonly machining: OverviewMachiningCardView;
  readonly riskGroups: readonly OverviewRiskGroupView[];
  readonly stateDistribution: Readonly<Record<string, number>>;
  /** 质检下钻：四类分桶行（后端 INSPECTION_KINDS 定序）。 */
  readonly inspectionByKind: readonly InspectionKindRowView[];
  readonly machiningGroups: readonly MachiningStatRowView[];
  readonly freshness: { readonly delivery: string; readonly inspection: string };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 机加工时下钻排序：未关联工作令行恒置底；其余净工时降序，并列时工作令号升序。 */
function compareMachiningRows(a: MachiningStatRowView, b: MachiningStatRowView): number {
  if (a.workOrderId === null && b.workOrderId === null) return 0;
  if (a.workOrderId === null) return 1;
  if (b.workOrderId === null) return -1;
  if (b.totalHours !== a.totalHours) return b.totalHours - a.totalHours;
  return a.workOrderId.localeCompare(b.workOrderId);
}

/** 四源 → 总览视图（纯函数；输入为各源 parse 后的视图，无 IO）。 */
export function buildOverviewView(sources: OverviewSources): OverviewView {
  const riskCounts = new Map<DeliveryRiskLevelView, number>([
    ['overdue', 0],
    ['at_risk', 0],
    ['on_track', 0],
  ]);
  for (const order of sources.delivery.orders) {
    riskCounts.set(order.riskLevel, (riskCounts.get(order.riskLevel) ?? 0) + 1);
  }

  const riskGroups = RISK_LEVELS.map((riskLevel) => ({
    riskLevel,
    orders: sources.delivery.orders.filter((order) => order.riskLevel === riskLevel),
  })).filter((group) => group.orders.length > 0);

  const assignedRows = sources.machining.filter((row) => row.workOrderId !== null);

  return {
    todo: {
      openTotal: sources.workbench.openTotal,
      bySource: sources.workbench.bySource,
    },
    delivery: {
      activeOrders: sources.delivery.orders.length,
      overdue: riskCounts.get('overdue') ?? 0,
      atRisk: riskCounts.get('at_risk') ?? 0,
      onTrack: riskCounts.get('on_track') ?? 0,
    },
    inspection: {
      pendingCount: sources.inspection.pendingCount,
      passRate: sources.inspection.passRate,
      nonconformOpenCount: sources.inspection.nonconformOpenCount,
      overdueCount: sources.inspection.overdueCount,
    },
    machining: {
      workOrderCount: assignedRows.length,
      unassignedCount: sources.machining.length - assignedRows.length,
      totalHours: round2(sources.machining.reduce((sum, row) => sum + row.totalHours, 0)),
      totalOutput: round2(sources.machining.reduce((sum, row) => sum + row.totalOutput, 0)),
    },
    riskGroups,
    stateDistribution: sources.delivery.distribution,
    inspectionByKind: sources.inspection.byKind,
    machiningGroups: [...sources.machining].sort(compareMachiningRows),
    freshness: {
      delivery: sources.delivery.generatedAt,
      inspection: sources.inspection.generatedAt,
    },
  };
}
