/**
 * 迁移报告渲染（人读文本；结构化对象由 pipeline 产出）。
 *
 * exit 码语义（CLI 合同）：
 *   0 = 全部行成功（含 inserted/updated 计数正常）
 *   1 = 存在行失败（report 模式收集到的失败明细 ≥1；strict 中止同码）
 *   2 = 配置/环境错误（迁移零行前 fail-fast）
 */

function renderStatLine(field, stat) {
  const parts = [];
  if (stat.converted > 0) parts.push(`转换×${stat.converted}`);
  if (stat.constant > 0) parts.push(`常量×${stat.constant}`);
  if (stat.default > 0) parts.push(`默认×${stat.default}`);
  if (stat.emptyToNull > 0) parts.push(`空转null×${stat.emptyToNull}`);
  return parts.length === 0 ? null : `${field}：${parts.join('、')}`;
}

/** 渲染迁移报告为文本（失败明细逐行列出，含行号与字段定位）。 */
export function renderTextReport(report) {
  const lines = [];
  lines.push(`迁移报告：target=${report.target} mode=${report.mode} startedAt=${report.startedAt}`);
  for (const dataset of report.datasets) {
    lines.push(
      `- ${dataset.dataset}：读取 ${dataset.rowsRead} 行，成功 ${dataset.rowsOk}，` +
        `失败 ${dataset.rowsFailed}，写入 inserted=${dataset.inserted} updated=${dataset.updated}` +
        `（业务键 [${dataset.businessKey.join(', ')}]）`,
    );
    const statLines = Object.entries(dataset.stats)
      .map(([field, stat]) => renderStatLine(field, stat))
      .filter((line) => line !== null);
    if (statLines.length > 0) {
      lines.push(`    字段统计：${statLines.join('；')}`);
    }
    for (const failure of dataset.failures) {
      for (const error of failure.errors) {
        lines.push(
          `    失败 ${failure.dataset} 行 ${failure.rowNumber}` +
            `${error.field === null ? '' : ` [${error.field}]`}：${error.message}`,
        );
      }
    }
  }
  const totals = report.totals;
  lines.push(
    `总计：读取 ${totals.rowsRead} 行，成功 ${totals.rowsOk}，失败 ${totals.rowsFailed}` +
      `（inserted=${totals.inserted} updated=${totals.updated}）`,
  );
  return lines.join('\n');
}

/** 报告 → exit 码（0 全成 / 1 有失败）。 */
export function exitCodeOf(report) {
  return report.totals.rowsFailed > 0 ? 1 : 0;
}
