/**
 * costing Excel 导出端口（M2-W6，09-costing.md §3：costing.export——模式照抄
 * listing ExcelPort）。
 *
 * 端口化取舍同 listing/excel-port.ts：application 不引 ExcelJS（零新增第三方
 * 依赖）。结构化表形状（ExcelSheet/ExcelExport）复用 listing 侧既有类型
 * （类型面共享、运行时零耦合——两端适配器可互操作）；ExcelJS 适配器（合流时，
 * integration 层）实现同一接口，产 xlsx-base64 字节，语义层（表组装）只定义
 * 一次。json-tables 内建实现 = 回声，供测试与零接线 boot。
 */
import type { ExcelExport, ExcelSheet } from '../listing/excel-port.js';

/**
 * costing 导出端口：成本快照 → 结构化表集 → 导出输出。
 * 实现方：JsonTablesCostingExcelPort（本文件）；ExcelJS 适配器（合流时）。
 */
export interface CostingExcelPort {
  /** 导出序列化（表集 → 输出；json-tables 实现为回声，适配器产 xlsx 字节）。 */
  exportWorkbook(sheets: readonly ExcelSheet[]): Promise<ExcelExport>;
}

/** json-tables 内建实现（测试与零接线 boot；不触文件系统/字节）。 */
export class JsonTablesCostingExcelPort implements CostingExcelPort {
  async exportWorkbook(sheets: readonly ExcelSheet[]): Promise<ExcelExport> {
    return { kind: 'json-tables', sheets };
  }
}
