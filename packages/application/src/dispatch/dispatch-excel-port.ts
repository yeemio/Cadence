/**
 * dispatch Excel 导出端口（fix-wave-6 6a-1，RREQ-DP-026：派工单 Excel 导出——
 * 模式照抄 listing ExcelPort / costing CostingExcelPort 先例）。
 *
 * 端口化取舍同 listing/excel-port.ts：application 不引 ExcelJS（零新增第三方
 * 依赖）。结构化表形状（ExcelSheet/ExcelExport）复用 listing 侧既有类型
 * （类型面共享、运行时零耦合——各端适配器可互操作）；组合根 ExcelJS 适配器
 * （exceljs-excel-port.ts，单实例注入 listing/costing/payroll/metric-pack）实现
 * 同一接口产 xlsx-base64 字节，语义层（导出表组装）只定义一次。
 * json-tables 内建实现 = 回声，供测试与零接线 boot。
 */
import type { ExcelExport, ExcelSheet } from '../listing/excel-port.js';

/**
 * dispatch 导出端口：派工单投影 → 结构化表集 → 导出输出（仅导出不写库）。
 * 实现方：JsonTablesDispatchExcelPort（本文件）；组合根 ExcelJS 适配器（同形）。
 */
export interface DispatchExcelPort {
  /** 导出序列化（表集 → 输出；json-tables 实现为回声，适配器产 xlsx 字节）。 */
  exportWorkbook(sheets: readonly ExcelSheet[]): Promise<ExcelExport>;
}

/** json-tables 内建实现（测试与零接线 boot；不触文件系统/字节）。 */
export class JsonTablesDispatchExcelPort implements DispatchExcelPort {
  async exportWorkbook(sheets: readonly ExcelSheet[]): Promise<ExcelExport> {
    return { kind: 'json-tables', sheets };
  }
}
