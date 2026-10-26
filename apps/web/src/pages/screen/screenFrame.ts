/**
 * 大屏呈现纯辅助（A8 首波，6a-3 裁决 3）：1080p 等比缩放计算与占位标记——
 * 零 React 依赖，vitest 直测（渲染块归 DigitalOperationScreenPage）。
 */
import type { ScreenPendingKind } from './screenApi';
import type { ScreenPendingFields } from './screenApi';

/** 设计画布：1920x1080（源文档大屏定稿分辨率）。 */
export const SCREEN_DESIGN_WIDTH = 1920;
export const SCREEN_DESIGN_HEIGHT = 1080;

/** 视口 → 等比缩放系数（min 边适配，画面完整可见；余量留黑边）。 */
export function computeScale(
  viewportWidth: number,
  viewportHeight: number,
  designWidth: number = SCREEN_DESIGN_WIDTH,
  designHeight: number = SCREEN_DESIGN_HEIGHT,
): number {
  if (viewportWidth <= 0 || viewportHeight <= 0) return 1;
  return Math.min(viewportWidth / designWidth, viewportHeight / designHeight);
}

/**
 * 占位标记（PRD §4.5「口径待定项须以占位形态可辨识」）：
 *  - definition（口径待定）：值按约定生成、业务口径未确认 → 值照常显示 + 「待定」角标；
 *  - source（数据源待接）：值恒 null → 显示「—」+ 「待接」角标。
 */
export function pendingMarker(
  pending: ScreenPendingFields,
  path: string,
): ScreenPendingKind | null {
  return pending[path] ?? null;
}

/** 占位种类的角标文案。 */
export function pendingBadgeText(kind: ScreenPendingKind): string {
  return kind === 'definition' ? '待定' : '待接';
}

/** 数值显示：null → '—'（读面缺失）；数字按整数呈现。 */
export function displayNumber(value: number | null): string {
  return value === null ? '—' : String(Math.trunc(value));
}

/** 比率显示（0~1 三位小数 → 百分比一位小数）；null → '—'。 */
export function displayRate(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

/** 一位小数得分（6S/综合得分）。 */
export function displayScore(value: number): string {
  return value.toFixed(1);
}

/** 已入库/总数列显示：任一侧 null → '—/总数' 或 '—/—'。 */
export function displayStoredTotal(pair: { stored: number | null; total: number | null }): string {
  return `${displayNumber(pair.stored)}/${displayNumber(pair.total)}`;
}

/** 进度列显示：null → '—'；数字加 %。 */
export function displayProgress(value: number | null): string {
  return value === null ? '—' : `${Math.trunc(value)}%`;
}

/** 剩余交期显示：null → '—'；负数 → 已逾期天数语义。 */
export function displayRemainingDays(value: number | null): string {
  if (value === null) return '—';
  return value < 0 ? `逾期${Math.abs(value)}天` : `${value}天`;
}

/** 延期风险中文（null → '—'）。 */
export function riskLabel(risk: 'low' | 'mid' | 'high' | null): string {
  if (risk === 'low') return '低';
  if (risk === 'mid') return '中';
  if (risk === 'high') return '高';
  return '—';
}
