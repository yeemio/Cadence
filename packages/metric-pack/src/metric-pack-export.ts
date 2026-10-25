/**
 * metric-pack 导出端口（M3，m3-drafts/04-metric-pack.md §3：metric-pack.export
 * ——模式照抄 payroll.export / listing ExcelPort / costing CostingExcelPort）。
 *
 * 端口化取舍：本包不引 ExcelJS（零新增第三方依赖，pro-pack 依赖面 =
 * business-core + engine-reporting）。MetricPackExportSheet /
 * MetricPackExportOutput 为本地结构同形类型（见 metric-pack-export-shapes.ts）
 * ——组合根的 ExcelJsExcelPort（总控已有）实现同一 exportWorkbook 形状即可
 * 互操作；json-tables 内建实现 = 回声，供测试与零接线 boot。
 */
import type { MetricPackExportOutput, MetricPackExportSheet } from './metric-pack-export-shapes.js';

export type { MetricPackExportOutput, MetricPackExportSheet } from './metric-pack-export-shapes.js';

/**
 * metric-pack 导出端口：口径求值结果 → 结构化表集 → 导出输出。
 * 实现方：JsonTablesMetricPackExportPort（本文件）；ExcelJS 适配（组合根复用
 * 总控已有 ExcelJsExcelPort，结构同形注入）。
 */
export interface MetricPackExportPort {
  /** 导出序列化（表集 → 输出；json-tables 实现为回声，适配器产 xlsx 字节）。 */
  exportWorkbook(sheets: readonly MetricPackExportSheet[]): Promise<MetricPackExportOutput>;
}

/** json-tables 内建实现（测试与零接线 boot；不触文件系统/字节）。 */
export class JsonTablesMetricPackExportPort implements MetricPackExportPort {
  async exportWorkbook(sheets: readonly MetricPackExportSheet[]): Promise<MetricPackExportOutput> {
    return { kind: 'json-tables', sheets };
  }
}
