/**
 * payroll 导出端口（M3，m3-drafts/01-payroll.md §3：payroll.export——模式照抄
 * listing ExcelPort / costing CostingExcelPort）。
 *
 * 端口化取舍：本包不引 ExcelJS（零新增第三方依赖，pro-pack 依赖面=
 * business-core）。PayrollExportSheet / PayrollExportOutput 为本地结构同形
 * 类型（见 payroll-export-shapes.ts）——组合根的 ExcelJsExcelPort（总控已有）
 * 实现同一 exportWorkbook 形状即可互操作；json-tables 内建实现 = 回声，供
 * 测试与零接线 boot。
 */
import type { PayrollExportOutput, PayrollExportSheet } from './payroll-export-shapes.js';

export type { PayrollExportOutput, PayrollExportSheet } from './payroll-export-shapes.js';

/**
 * payroll 导出端口：工资核算结果 → 结构化表集 → 导出输出。
 * 实现方：JsonTablesPayrollExportPort（本文件）；ExcelJS 适配（组合根复用
 * 总控已有 ExcelJsExcelPort，结构同形注入）。
 */
export interface PayrollExportPort {
  /** 导出序列化（表集 → 输出；json-tables 实现为回声，适配器产 xlsx 字节）。 */
  exportWorkbook(sheets: readonly PayrollExportSheet[]): Promise<PayrollExportOutput>;
}

/** json-tables 内建实现（测试与零接线 boot；不触文件系统/字节）。 */
export class JsonTablesPayrollExportPort implements PayrollExportPort {
  async exportWorkbook(sheets: readonly PayrollExportSheet[]): Promise<PayrollExportOutput> {
    return { kind: 'json-tables', sheets };
  }
}
