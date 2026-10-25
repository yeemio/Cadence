/**
 * drawing 模块品牌化 ID（M3，m3-drafts/03-drawing.md v1.0 §2 品牌化 ID 清单）。
 *
 * 用 business-core 公开导出的 defineId 在本包内增补（与 payroll/costing 同一
 * 机制，business-core 零污染）。差异表 #2：草案的裸字符串升级为品牌化
 * DrawingId / DrawingRevisionId / DrawingChangeNoticeId（Brand<T,Name>，
 * m2 通用纪律 5）。
 *
 * 语义分工：
 *  - DrawingId = 图纸标识的 opaque 锚（"图号"编码规则=数据约定，不进类型——
 *    租户图号体系各异，本包只持有有界非空字符串）；
 *  - DrawingRevisionId = 修订行 id（dr-<uuidv7>；drawingId+version 唯一定位，
 *    append-only 链上一版一行）；
 *  - DrawingChangeNoticeId = 变更通知行 id（dnc-<uuidv7>；发布联动事实）。
 */
import { defineId } from '@smes/business-core';

/** 图纸标识（opaque 锚；"图号"编码规则是数据约定，不进类型）。 */
export const DrawingId = defineId('DrawingId');
export type DrawingId = ReturnType<typeof DrawingId.create>;

/** 图纸修订行 id（append-only 修订链上一版一行）。 */
export const DrawingRevisionId = defineId('DrawingRevisionId');
export type DrawingRevisionId = ReturnType<typeof DrawingRevisionId.create>;

/** 图纸变更通知行 id（新修订发布时的事实）。 */
export const DrawingChangeNoticeId = defineId('DrawingChangeNoticeId');
export type DrawingChangeNoticeId = ReturnType<typeof DrawingChangeNoticeId.create>;

// ---- 模块内 id 生成器（前缀 + uuidv7：与 payroll-ids/costing-ids 同口径） ----

/**
 * 极小 uuidv7 生成器（RFC 9562）：与 payroll-ids/hours-ids 同实现口径——
 * business-store 的 uuid 工具不可用（依赖方向），事实表 id 需时间有序
 * （evidence-columns.v1），毫秒级时间序已满足本模块排序口径。
 */
export function uuidv7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const ms = Date.now();
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 图纸修订行 id：dr-<uuidv7>。 */
export function newDrawingRevisionRowId(): DrawingRevisionId {
  return DrawingRevisionId.create(`dr-${uuidv7()}`);
}

/** 变更通知行 id：dnc-<uuidv7>。 */
export function newDrawingChangeNoticeId(): DrawingChangeNoticeId {
  return DrawingChangeNoticeId.create(`dnc-${uuidv7()}`);
}

/** 查看留痕行 id：dvt-<uuidv7>（留痕是 append-only 审计事实，行 id 用裸串同域事件行口径）。 */
export function newDrawingViewTrailRowId(): string {
  return `dvt-${uuidv7()}`;
}
