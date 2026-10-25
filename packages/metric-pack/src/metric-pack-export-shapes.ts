/**
 * metric-pack 导出结构化表形状（本地结构同形类型，M3）。
 *
 * 与 payroll / listing / costing 侧导出表**结构等价**（字段名与类型逐一
 * 同形）——本包不引 ExcelJS（零新增第三方依赖；合同 §3"ExcelJS"经组合根
 * 适配器达成，payroll.export 同先例），组合根把本包表集直接喂 ExcelJsExcelPort
 * 即可互操作；类型面共享、运行时零耦合。
 */

/** 一张表：表头 + 文本单元格行（结构同形 listing ExcelSheet / payroll PayrollExportSheet）。 */
export interface MetricPackExportSheet {
  readonly name: string;
  /** 表头单元格文本。 */
  readonly header: readonly string[];
  /** 数据行（与 header 等长或更短——缺尾单元格按空处理）。 */
  readonly rows: readonly (readonly string[])[];
}

/** 导出输出：json-tables（内建回声）/ xlsx-base64（ExcelJS 适配器产物）。 */
export type MetricPackExportOutput =
  | { readonly kind: 'json-tables'; readonly sheets: readonly MetricPackExportSheet[] }
  | { readonly kind: 'xlsx-base64'; readonly base64: string };
