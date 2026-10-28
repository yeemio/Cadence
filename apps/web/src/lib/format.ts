/**
 * 展示格式化共享工具（P2 横切批 UX-PLAN-07/08、UX-PUR-04、UX-WH-10）：
 * 后端投影的 createdAt/promisedAt 等时刻为 UTC ISO 串（2026-10-27T02:42:01.759Z）、
 * 主键/外键为 36+ 字符 UUID/ULID（wo-014a7b3c-739a-…），表格键直读直出不可读。
 * 手法沿用 costing/timeFormat 先例（本地 Date getter + padStart，不引日期库），
 * 提升为 src/lib 共享出口；输出精度取分钟级（业务表格无毫秒/秒噪声需求）。
 *
 * 与 ModuleTable 的接线：TableColumn.format 指定格式器（列级显示转换，行数据
 * 原样保留——行选中/复制/乐观锁取值不受影响），单元格 title 悬停展示全文。
 */

/** 表格列显示格式（ModuleTable TableColumn.format 取值）。 */
export type CellFormat = 'datetime' | 'shortId';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 时刻 → 本地时区 `YYYY-MM-DD HH:mm`。null/undefined/空串 → '—'（同表格 cellText
 * 缺省口径）；纯日期串（YYYY-MM-DD，如 plannedDeliveryAt 业务日期）不做时区
 * 转换原样返回（避免 UTC 午夜被平移出新时刻）；无法解析的串原样返回。
 */
export function formatLocalDateTime(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  const text = String(value);
  if (DATE_ONLY.test(text)) return text;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const p2 = (part: number) => String(part).padStart(2, '0');
  return (
    `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}` +
    ` ${p2(date.getHours())}:${p2(date.getMinutes())}`
  );
}

/**
 * 长 id（UUID/ULID/带前缀复合 id）→ 截断显示。≤20 字符原样返回（业务短码
 * item-rp42388、用户 id user-seed-admin-a 等可读 id 不动）；超长取头 8 + 尾 4
 * （ULID 头段是时间戳，同批行头 8 位几乎相同，补尾 4 保行间可分辨）。
 */
export function shortId(value: unknown): string {
  if (value === null || value === undefined) return '—';
  const text = String(value);
  if (text.length <= 20) return text;
  return `${text.slice(0, 8)}…${text.slice(-4)}`;
}

/** CellFormat → 显示文本（ModuleTable 单元格渲染出口；行数据不经此改写）。 */
export function formatCell(value: unknown, format: CellFormat): string {
  return format === 'datetime' ? formatLocalDateTime(value) : shortId(value);
}
