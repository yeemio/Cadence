/**
 * payroll 导出结构化表形状（本地结构同形类型，M3）。
 *
 * 与 listing/costing 侧 ExcelSheet / ExcelExport **结构等价**（字段名与类型
 * 逐一同形）——本包不 import application（pro-pack-tier-edges），组合根把
 * 本包表集直接喂 ExcelJsExcelPort（总控已有）即可互操作；类型面共享、
 * 运行时零耦合。
 */

/** 一张表：表头 + 文本单元格行（结构同形 listing ExcelSheet）。 */
export interface PayrollExportSheet {
  readonly name: string;
  /** 表头单元格文本。 */
  readonly header: readonly string[];
  /** 数据行（与 header 等长或更短——缺尾单元格按空处理）。 */
  readonly rows: readonly (readonly string[])[];
}

/** 导出输出：json-tables（内建回声）/ xlsx-base64（ExcelJS 适配器产物）。 */
export type PayrollExportOutput =
  | { readonly kind: 'json-tables'; readonly sheets: readonly PayrollExportSheet[] }
  | { readonly kind: 'xlsx-base64'; readonly base64: string };
