/**
 * ai-query 时间语义（freeze，CONTRACT v1 §硬性要求 6）。
 *
 *  - 今日 = 当地（Asia/Shanghai）00:00 至今；
 *  - 本周 = 当地本周一 00:00 至今（本地周一起点）；
 *  - 最近N天 = 滚动 N×24h 窗口；
 *  - now 经可注入时钟（默认系统时钟，service options.now）。
 *
 * Asia/Shanghai 现行无夏令时（1991 年后固定 UTC+8），按固定偏移实现；窗口
 * 左闭右开 [from, to)，to = 查询时刻。
 */
import type { AiQueryTimeRange, AiQueryTimeWindow } from './ai-query-ports.js';

/** Asia/Shanghai 固定偏移（毫秒）。 */
export const SHANGHAI_UTC_OFFSET_MS = 8 * 3_600_000;

/** 最近N天的 N 上限（滚动窗口防御值，与报表趋势窗口上限同量级）。 */
export const MAX_LAST_N_DAYS = 366;

/** 求值时间窗（纯函数：由范围意图 + 查询时刻求 from/to/label）。 */
export function resolveTimeWindow(range: AiQueryTimeRange, nowIso: string): AiQueryTimeWindow {
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(nowMs)) {
    throw new Error(`查询时刻非法：${nowIso}`);
  }
  switch (range.kind) {
    case 'today': {
      // 当地 00:00 = 移位到当地日历日后取 UTC 零点，再移回真实时刻。
      const shifted = new Date(nowMs + SHANGHAI_UTC_OFFSET_MS);
      const localMidnightUtcMs = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
      return { from: new Date(localMidnightUtcMs - SHANGHAI_UTC_OFFSET_MS).toISOString(), to: nowIso, label: '今日' };
    }
    case 'this-week': {
      const shifted = new Date(nowMs + SHANGHAI_UTC_OFFSET_MS);
      // 周一起点：getUTCDay 周日=0 → 回退 6 天；其余回退 day-1 天。
      const daysSinceMonday = (shifted.getUTCDay() + 6) % 7;
      const mondayMidnightUtcMs =
        Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) -
        daysSinceMonday * 86_400_000;
      return {
        from: new Date(mondayMidnightUtcMs - SHANGHAI_UTC_OFFSET_MS).toISOString(),
        to: nowIso,
        label: '本周',
      };
    }
    case 'last-n-days': {
      return {
        from: new Date(nowMs - range.days * 86_400_000).toISOString(),
        to: nowIso,
        label: `最近${range.days}天`,
      };
    }
  }
}
