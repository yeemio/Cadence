/**
 * costing 页时刻显示格式化（fix-wave-2 D-13）：后端 createdAt 投影为 UTC ISO
 * 串（如 2026-10-26T03:49:26.749Z），ModuleTable 键直读直出不可读。仓内
 * formatStamp 先例（notifications/system/overview 页）只裁剪 UTC 串、不做
 * 时区转换，不满足"本地时区"口径；全仓亦无共享日期工具与日期库。故按
 * HoursPage 同款手拼手法（本地 Date getter + padStart）在 costing 页内最小
 * 实现，输出形态对齐 formatStamp 先例的 YYYY-MM-DD HH:mm:ss（秒级，毫秒
 * 噪声不展示）。
 */

/** UTC ISO 串 → 本地时区 YYYY-MM-DD HH:mm:ss；无法解析时原样返回（表格 '—'/原文语义不变）。 */
export function formatLocalStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const p2 = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())} ${p2(date.getHours())}:${p2(date.getMinutes())}:${p2(date.getSeconds())}`;
}

/** ModuleTable 行集的 createdAt 列在喂表前替换为格式化值（表列按"配置键直读行字段"渲染，无列级 render）。 */
export function formatStampColumn(
  rows: readonly Record<string, unknown>[] | undefined,
): Record<string, unknown>[] {
  return (rows ?? []).map((row) => {
    if (typeof row.createdAt !== 'string') return row;
    return { ...row, createdAt: formatLocalStamp(row.createdAt) };
  });
}
