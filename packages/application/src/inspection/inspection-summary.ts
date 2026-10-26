/**
 * inspection 只读聚合纯函数（M2-W4）：质检汇总事实（工作台 KPI / 报表）与
 * 机器迁移史提取。纯数据上卷（同 workorder-progress 体例）：输入投影行与
 * 机器事件，输出视图形状——查询路径复用，PG/内存两实现共用同一口径。
 *
 * 汇总口径（06-inspection.md §7 对账要点：同待检集合的合格率/待检/未闭环
 * 三项计数——初版口径，对账阶段按活系统行为校正）：
 *  - 待检数 pendingCount = state=pending；
 *  - 已判定数 judgedCount = passed + failed + closed（终判口径）；
 *  - 合格率 passRate = passed / judgedCount（judgedCount=0 → null）；
 *  - 未闭环数 nonconformOpenCount = 不合格明细 state ∉ {closed, voided} 的条数
 *    （等价：判定不合格且处置闭环未完成的明细；voided=撤销质检作废的明细，
 *    fix-wave-6 6a-2——不进活跃闭环视图）；
 *  - 超时数 overdueCount = failed 单中 closeDueAt < now 且未点名的条数。
 */
import type { ApprovalEvent } from '@smes/engine-flow';
import type { InspectionKind } from './inspection-config.js';
import { INSPECTION_KINDS } from './inspection-config.js';
import type { InspectionOrder, Nonconform } from './inspection-stores.js';

// ---- 机器迁移史（详情/闭环追踪视图） ----

/** 一次状态迁移的里程碑（重放口径：from → to，动词 + 版本 + 时刻 + 动作人）。 */
export interface InspectionMilestone {
  readonly from: string;
  readonly to: string;
  /** 配置迁移命令动词（SCREAMING_SNAKE）。 */
  readonly event: string;
  readonly objectVersion: number;
  readonly occurredAt: string;
  readonly actor: string;
}

/** 机器事件账本 → 迁移里程碑序列（append 顺序升序）。 */
export function milestoneHistory(events: readonly ApprovalEvent[]): readonly InspectionMilestone[] {
  return events.map((event) => ({
    from: event.payload.from,
    to: event.payload.to,
    event: event.payload.event,
    objectVersion: event.payload.objectVersion,
    occurredAt: event.occurredAt,
    actor: event.payload.actor,
  }));
}

// ---- 质检汇总事实 ----

/** 四类分桶行（队列口径：每类待检/已判/合格率/未闭环明细）。 */
export interface InspectionKindSummaryRow {
  readonly kind: InspectionKind;
  readonly pending: number;
  readonly passed: number;
  readonly failed: number;
  readonly closed: number;
  readonly judgedCount: number;
  readonly passRate: number | null;
  readonly nonconformOpen: number;
}

/** 质检汇总事实（工作台 KPI 卡——待检/合格率/未闭环——与报表的只读聚合）。 */
export interface InspectionSummary {
  readonly pendingCount: number;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly closedCount: number;
  readonly judgedCount: number;
  /** 合格率（0~1，4 位小数；无判定 null）。 */
  readonly passRate: number | null;
  /** 未闭环不合格明细数（闭环追踪 KPI）。 */
  readonly nonconformOpenCount: number;
  readonly nonconformClosedCount: number;
  /** 闭环超时未点名数（点名后不再计入——88 场景口径）。 */
  readonly overdueCount: number;
  readonly byKind: readonly InspectionKindSummaryRow[];
  readonly generatedAt: string;
}

function passRateOf(passed: number, judgedCount: number): number | null {
  return judgedCount === 0 ? null : Math.round((passed / judgedCount) * 10000) / 10000;
}

/** 投影行 → 汇总事实（纯函数；now 为点名口径的时钟注入）。 */
export function rollupInspectionSummary(
  orders: readonly InspectionOrder[],
  nonconforms: readonly Nonconform[],
  now: string,
): InspectionSummary {
  const openNonconformsByKind = new Map<InspectionKind, number>();
  for (const nc of nonconforms) {
    if (nc.state === 'closed' || nc.state === 'voided') continue;
    const order = orders.find((candidate) => candidate.id === nc.inspectionId);
    if (order === undefined) continue;
    openNonconformsByKind.set(order.kind, (openNonconformsByKind.get(order.kind) ?? 0) + 1);
  }

  const rows: InspectionKindSummaryRow[] = INSPECTION_KINDS.map((kind) => {
    const kindOrders = orders.filter((order) => order.kind === kind);
    const passed = kindOrders.filter((order) => order.state === 'passed').length;
    const failed = kindOrders.filter((order) => order.state === 'failed').length;
    const closed = kindOrders.filter((order) => order.state === 'closed').length;
    const judgedCount = passed + failed + closed;
    return {
      kind,
      pending: kindOrders.filter((order) => order.state === 'pending').length,
      passed,
      failed,
      closed,
      judgedCount,
      passRate: passRateOf(passed, judgedCount),
      nonconformOpen: openNonconformsByKind.get(kind) ?? 0,
    };
  });

  const passedCount = rows.reduce((sum, row) => sum + row.passed, 0);
  const failedCount = rows.reduce((sum, row) => sum + row.failed, 0);
  const closedCount = rows.reduce((sum, row) => sum + row.closed, 0);
  const judgedCount = passedCount + failedCount + closedCount;
  const nowMs = Date.parse(now);

  return {
    pendingCount: rows.reduce((sum, row) => sum + row.pending, 0),
    passedCount,
    failedCount,
    closedCount,
    judgedCount,
    passRate: passRateOf(passedCount, judgedCount),
    nonconformOpenCount: nonconforms.filter((nc) => nc.state !== 'closed' && nc.state !== 'voided').length,
    nonconformClosedCount: nonconforms.filter((nc) => nc.state === 'closed').length,
    overdueCount: orders.filter(
      (order) =>
        order.state === 'failed' &&
        order.closeDueAt !== null &&
        order.overdueNotifiedAt === null &&
        Date.parse(order.closeDueAt) < nowMs,
    ).length,
    byKind: rows,
    generatedAt: now,
  };
}
