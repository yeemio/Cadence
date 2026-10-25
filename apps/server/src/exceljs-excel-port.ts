/**
 * ExcelJS 适配器（M2 后第一增量，接线清单 ExcelPort 项——status.md Wave-2
 * "ExcelJS 适配器待统一装依赖接线"补口）。
 *
 * 分层纪律（与 listing/excel-port.ts 端口合同一致）：
 *  - **格式层**（本文件）：xlsx-bytes ↔ 结构化表互译（ExcelJS 读写）。语义层
 *    不复刻——json-tables 源与行解析都委托 application 的既有纯函数
 *    （parseListingTable / JsonTablesExcelPort），表头别名与错误行提示语义只
 *    定义一次，两端零漂移；
 *  - **导出**：结构化表集 → 真实 .xlsx 字节（xlsx-base64）。
 *
 * 装配形态：cross-module-wiring 构造单实例，同时注入 listing（ExcelPort）与
 * costing（CostingExcelPort——exportWorkbook 结构子集，同实例满足两接口）。
 * application 不引 ExcelJS 的依赖区约束不变（适配器只在组合根侧）。
 */
import ExcelJS from 'exceljs';
import {
  JsonTablesExcelPort,
  parseListingTable,
  type ExcelExport,
  type ExcelParseResult,
  type ExcelPort,
  type ExcelSheet,
  type ExcelSource,
} from '@smes/application';

/** ExcelJS 单元格值 → 文本（导入方向的窄化：解析语义只吃文本）。 */
function cellToText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const record = value as unknown as Record<string, unknown>;
    // 富文本块：拼接各段文本
    if (Array.isArray(record['richText'])) {
      return (record['richText'] as readonly { readonly text?: unknown }[])
        .map((part) => (typeof part['text'] === 'string' ? part['text'] : ''))
        .join('');
    }
    // 公式单元格：取计算结果（无结果回落公式文本——解析语义对文本生效）
    if ('formula' in record || 'sharedFormula' in record) {
      const result = record['result'];
      return result === undefined || result === null
        ? String(record['formula'] ?? record['sharedFormula'] ?? '')
        : cellToText(result as ExcelJS.CellValue);
    }
    // 超链接单元格：显示文本
    if (typeof record['text'] === 'string') return record['text'];
    // 错误单元格（#REF! 等）：按错误码文本处理（行级解析自行拒绝非法数值）
    if (typeof record['error'] === 'string') return record['error'];
  }
  return String(value);
}

/** 工作表 → 结构化表（首行 = 表头；数据行与表头等宽或更短——缺尾按空处理）。 */
function worksheetToSheet(worksheet: ExcelJS.Worksheet): ExcelSheet {
  const header = (worksheet.getRow(1).values as readonly ExcelJS.CellValue[]).slice(1).map(cellToText);
  const rows: string[][] = [];
  for (let rowIndex = 2; rowIndex <= worksheet.rowCount; rowIndex += 1) {
    rows.push(
      (worksheet.getRow(rowIndex).values as readonly ExcelJS.CellValue[]).slice(1).map(cellToText),
    );
  }
  return { name: worksheet.name, header, rows };
}

/** 工作表名约束（Excel 硬约束）：非法字符替换、31 字符截断、重名去重。 */
function safeWorksheetName(name: string, used: Set<string>): string {
  const base = (name.replace(/[*?:\\[\]/]/g, '-').slice(0, 31) || 'Sheet').trim() || 'Sheet';
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base.slice(0, 28)}-${index}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  const fallback = `Sheet-${used.size + 1}`;
  used.add(fallback);
  return fallback;
}

/**
 * ExcelJS 适配器：实现 listing ExcelPort（parseListingImport + exportWorkbook），
 * 结构上同时满足 costing CostingExcelPort（exportWorkbook 子集）。
 */
export class ExcelJsExcelPort implements ExcelPort {
  private readonly jsonTables = new JsonTablesExcelPort();

  async parseListingImport(source: ExcelSource): Promise<ExcelParseResult> {
    if (source.kind !== 'xlsx-bytes') {
      // json-tables 源：语义与内建实现同源（委托——零漂移）
      return this.jsonTables.parseListingImport(source);
    }
    const buffer = Buffer.from(source.base64, 'base64');
    const workbook = new ExcelJS.Workbook();
    try {
      // ExcelJS 自有 Buffer 接口（ArrayBuffer 系）与 node Buffer 运行时互容，类型面经 unknown 对齐
      await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    } catch (error) {
      // 字节不可解析 = 文件级问题（整单拒绝口径，调用方按 fileLevelIssues 拒绝）
      return {
        rows: [],
        issues: [
          {
            lineNo: null,
            column: null,
            message: `xlsx 解析失败：${error instanceof Error ? error.message : String(error)}，文件被拒绝`,
          },
        ],
      };
    }
    const worksheet = workbook.worksheets[0];
    if (worksheet === undefined) {
      return { rows: [], issues: [{ lineNo: null, column: null, message: '源不含任何工作表，文件被拒绝' }] };
    }
    return parseListingTable(worksheetToSheet(worksheet));
  }

  async exportWorkbook(sheets: readonly ExcelSheet[]): Promise<ExcelExport> {
    const workbook = new ExcelJS.Workbook();
    const usedNames = new Set<string>();
    for (const sheet of sheets) {
      const worksheet = workbook.addWorksheet(safeWorksheetName(sheet.name, usedNames));
      worksheet.addRow([...sheet.header]);
      for (const row of sheet.rows) {
        worksheet.addRow([...row]);
      }
    }
    const bytes = await workbook.xlsx.writeBuffer();
    return { kind: 'xlsx-base64', base64: Buffer.from(bytes).toString('base64') };
  }
}
