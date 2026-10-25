/**
 * Excel 导入导出端口（M2-W3，03-listing.md §3/§4：ExcelJS 导入导出——复刻
 * 表头别名校验行为）。
 *
 * 端口化取舍：application 不引 ExcelJS（零新增第三方依赖，依赖未入树——
 * 总控合流时统一接）。端口语义分两层：
 *  - **格式层**（ExcelPort 实现方负责）：字节 ↔ 结构化表的互译。本文件提供
 *    JsonTablesExcelPort（json-tables 源的内建实现，供测试与零接线 boot）；
 *    ExcelJS 适配器（integration 层）将实现同一接口，支持 xlsx-bytes 源并复用
 *    本文件的语义纯函数——表头别名校验与错误行提示只定义一次，两端不漂移。
 *  - **语义层**（本文件纯函数 parseListingTable）：表头别名定位 + 逐行解析 +
 *    错误行提示（issues 不炸整单；文件级问题如缺必需列才整单拒绝）。
 *
 * 表头别名集为**初版口径**（数据级配置形态：ALIAS_MAP 可扩展，不改代码；
 * D13 导入复刻口径的对账锚点 = 行为等价：别名等价识别 + 错误行逐行提示）。
 */
import { ListingInputError } from './listing-errors.js';

// ---- 结构化表形状（json-tables 源的载荷；ExcelJS 适配器的中间表示） ----

/** 一张表：表头 + 文本单元格行。 */
export interface ExcelSheet {
  readonly name: string;
  /** 表头单元格文本（原文，未归一化）。 */
  readonly header: readonly string[];
  /** 数据行（与 header 等长或更短——缺尾单元格按空处理）。 */
  readonly rows: readonly (readonly string[])[];
}

/** Excel 源：json-tables（内建）/ xlsx-bytes（ExcelJS 适配器）。 */
export type ExcelSource =
  | { readonly kind: 'json-tables'; readonly sheets: readonly ExcelSheet[] }
  | { readonly kind: 'xlsx-bytes'; readonly base64: string };

// ---- 导入语义（表头别名 + 行解析 + 错误行提示） ----

/** 清单导入行的逻辑列。 */
export type ListingImportColumn = 'drawingNo' | 'code' | 'name' | 'spec' | 'quantity' | 'neededBy';

/**
 * 表头别名集（初版口径；数据级可扩展）。键 = 归一化表头（NFKC + 小写 +
 * 去空白），值 = 逻辑列。同列多别名等价识别——"复刻表头别名校验行为"的
 * 端口合同：实现方必须经本映射（或等价行为）定位列，不得只认单一表头。
 */
export const LISTING_IMPORT_ALIAS_MAP: Readonly<Record<string, ListingImportColumn>> = {
  // 图号
  '图号': 'drawingNo',
  '图纸编号': 'drawingNo',
  'drawing': 'drawingNo',
  'drawingno': 'drawingNo',
  // 物料编码
  '物料编码': 'code',
  '编码': 'code',
  'code': 'code',
  // 物料名称
  '物料名称': 'name',
  '名称': 'name',
  'name': 'name',
  // 规格
  '规格型号': 'spec',
  '规格': 'spec',
  'spec': 'spec',
  // 数量（必需）
  '数量': 'quantity',
  '需求数量': 'quantity',
  'quantity': 'quantity',
  // 需求日期
  '需求日期': 'neededBy',
  '交货日期': 'neededBy',
  'neededby': 'neededBy',
};

/** 解析后的导入行（1 起行号 = 数据行序，不含表头）。 */
export interface ExcelImportRow {
  /** 数据行号（1 起，不含表头——错误行提示的定位锚点）。 */
  readonly lineNo: number;
  readonly drawingNo: string | null;
  readonly code: string | null;
  readonly name: string | null;
  readonly spec: string | null;
  readonly quantity: number;
  readonly neededBy: string | null;
}

/** 解析问题：lineNo=null 为文件级（整单拒绝）；否则为错误行提示（该行跳过）。 */
export interface ExcelParseIssue {
  readonly lineNo: number | null;
  /** 关联逻辑列（可空——行级杂项问题）。 */
  readonly column: string | null;
  readonly message: string;
}

export interface ExcelParseResult {
  readonly rows: readonly ExcelImportRow[];
  readonly issues: readonly ExcelParseIssue[];
}

function normalizeHeaderCell(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

function cellAt(row: readonly string[], index: number | undefined): string {
  if (index === undefined) return '';
  return (row[index] ?? '').trim();
}

/**
 * 语义纯函数：一张结构化表 → 导入行 + 问题清单。
 *
 * 行为口径（端口语义、对账锚点）：
 *  - 表头定位：全表扫第一行非空单元格，按别名映射取逻辑列；重复列名取首列；
 *  - 文件级问题（issues 内 lineNo=null 项，调用方整单拒绝）：缺 quantity 列、
 *    缺全部物料定位列（code/name/spec 一列都没有）；
 *  - 行级问题（该行跳过、计入 issues 供错误行提示）：物料三要素 + 图号全空、
 *    数量非数值/非正/超界（(0, 1e9]）、需求日期非法（非 ISO 8601）；
 *  - 空行跳过（不计问题）。
 */
export function parseListingTable(sheet: ExcelSheet): ExcelParseResult {
  const columnIndexes = new Map<ListingImportColumn, number>();
  sheet.header.forEach((cell, index) => {
    const column = LISTING_IMPORT_ALIAS_MAP[normalizeHeaderCell(cell)];
    if (column !== undefined && !columnIndexes.has(column)) {
      columnIndexes.set(column, index); // 重复列名取首列
    }
  });

  const issues: ExcelParseIssue[] = [];
  if (!columnIndexes.has('quantity')) {
    issues.push({
      lineNo: null,
      column: 'quantity',
      message: `表头缺少数量列（可识别表头：数量/需求数量/quantity），文件被拒绝`,
    });
  }
  const hasMaterialColumn =
    columnIndexes.has('code') || columnIndexes.has('name') || columnIndexes.has('spec');
  if (!hasMaterialColumn) {
    issues.push({
      lineNo: null,
      column: null,
      message: '表头缺少物料定位列（物料编码/编码/code、物料名称/名称/name、规格型号/规格/spec 至少一列），文件被拒绝',
    });
  }

  const rows: ExcelImportRow[] = [];
  sheet.rows.forEach((raw, rowIndex) => {
    const lineNo = rowIndex + 1;
    const drawingNo = cellAt(raw, columnIndexes.get('drawingNo'));
    const code = cellAt(raw, columnIndexes.get('code'));
    const name = cellAt(raw, columnIndexes.get('name'));
    const spec = cellAt(raw, columnIndexes.get('spec'));
    const quantityText = cellAt(raw, columnIndexes.get('quantity'));
    const neededByText = cellAt(raw, columnIndexes.get('neededBy'));

    if (
      drawingNo.length === 0 &&
      code.length === 0 &&
      name.length === 0 &&
      spec.length === 0 &&
      quantityText.length === 0 &&
      neededByText.length === 0
    ) {
      return; // 空行跳过
    }

    const quantity = Number(quantityText);
    if (quantityText.length === 0 || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000_000) {
      issues.push({
        lineNo,
        column: 'quantity',
        message: `第 ${lineNo} 行数量非法：'${quantityText}'（须为 (0, 1e9] 内的数），该行已跳过`,
      });
      return;
    }
    if (drawingNo.length === 0 && code.length === 0 && name.length === 0 && spec.length === 0) {
      issues.push({
        lineNo,
        column: null,
        message: `第 ${lineNo} 行物料信息为空（图号/编码/名称/规格至少一项），该行已跳过`,
      });
      return;
    }
    let neededBy: string | null = null;
    if (neededByText.length > 0) {
      if (Number.isNaN(Date.parse(neededByText))) {
        issues.push({
          lineNo,
          column: 'neededBy',
          message: `第 ${lineNo} 行需求日期非法：'${neededByText}'（须为 ISO 8601 日期），该行已跳过`,
        });
        return;
      }
      neededBy = neededByText;
    }

    rows.push({
      lineNo,
      drawingNo: drawingNo.length === 0 ? null : drawingNo,
      code: code.length === 0 ? null : code,
      name: name.length === 0 ? null : name,
      spec: spec.length === 0 ? null : spec,
      quantity,
      neededBy,
    });
  });

  return { rows, issues };
}

/** 文件级问题（整单拒绝口径）。 */
export function fileLevelIssues(issues: readonly ExcelParseIssue[]): readonly ExcelParseIssue[] {
  return issues.filter((issue) => issue.lineNo === null);
}

// ---- 导出序列化（结构化表方向） ----

/** 导出输出：json-tables（内建回声）/ xlsx-base64（ExcelJS 适配器产物）。 */
export type ExcelExport =
  | { readonly kind: 'json-tables'; readonly sheets: readonly ExcelSheet[] }
  | { readonly kind: 'xlsx-base64'; readonly base64: string };

// ---- 端口 ----

/**
 * Excel 端口：清单导入解析（表 → 行 + 错误行提示）与导出序列化（表 → 字节）。
 * 实现方：JsonTablesExcelPort（本文件，json-tables 源）；ExcelJS 适配器
 * （合流时，xlsx-bytes 源 + 复用 parseListingTable 语义层）。
 */
export interface ExcelPort {
  /** 解析清单导入源：取第一张表（无表 → 文件级 issue）；文件级问题由调用方整单拒绝。 */
  parseListingImport(source: ExcelSource): Promise<ExcelParseResult>;
  /** 导出序列化（表集 → 输出；json-tables 实现为回声，适配器产 xlsx 字节）。 */
  exportWorkbook(sheets: readonly ExcelSheet[]): Promise<ExcelExport>;
}

/** json-tables 源的内建实现（测试与零接线 boot；不触文件系统/字节）。 */
export class JsonTablesExcelPort implements ExcelPort {
  async parseListingImport(source: ExcelSource): Promise<ExcelParseResult> {
    if (source.kind === 'xlsx-bytes') {
      return {
        rows: [],
        issues: [
          {
            lineNo: null,
            column: null,
            message: 'xlsx-bytes 源需要 ExcelJS 适配器（依赖未入树，总控合流时统一接）；当前内建实现只支持 json-tables 源',
          },
        ],
      };
    }
    const sheet = source.sheets[0];
    if (sheet === undefined) {
      return { rows: [], issues: [{ lineNo: null, column: null, message: '源不含任何工作表，文件被拒绝' }] };
    }
    return parseListingTable(sheet);
  }

  async exportWorkbook(sheets: readonly ExcelSheet[]): Promise<ExcelExport> {
    return { kind: 'json-tables', sheets };
  }
}

/** 源形状预检（listing-input 侧浅校验；深校验在 parseListingTable）。 */
export function requireExcelSource(value: unknown, what: string): ExcelSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ListingInputError(`${what}必须是 ExcelSource 对象：${JSON.stringify(value)}`);
  }
  const record = value as Record<string, unknown>;
  if (record['kind'] === 'xlsx-bytes') {
    if (typeof record['base64'] !== 'string' || record['base64'].length === 0) {
      throw new ListingInputError(`${what}.base64 须为非空字符串`);
    }
    return { kind: 'xlsx-bytes', base64: record['base64'] };
  }
  if (record['kind'] !== 'json-tables') {
    throw new ListingInputError(`${what}.kind 非法：须为 'json-tables' 或 'xlsx-bytes'`);
  }
  const sheets = record['sheets'];
  if (!Array.isArray(sheets)) {
    throw new ListingInputError(`${what}.sheets 必须是数组`);
  }
  const parsed: ExcelSheet[] = [];
  sheets.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ListingInputError(`${what}.sheets[${index}] 必须是对象`);
    }
    const sheet = raw as Record<string, unknown>;
    const name = sheet['name'];
    const header = sheet['header'];
    const rows = sheet['rows'];
    if (typeof name !== 'string' || name.length > 128) {
      throw new ListingInputError(`${what}.sheets[${index}].name 须为 1~128 字符`);
    }
    if (!Array.isArray(header) || header.some((cell) => typeof cell !== 'string')) {
      throw new ListingInputError(`${what}.sheets[${index}].header 须为字符串数组`);
    }
    if (!Array.isArray(rows) || rows.some((row) => !Array.isArray(row) || row.some((cell) => typeof cell !== 'string'))) {
      throw new ListingInputError(`${what}.sheets[${index}].rows 须为字符串数组的数组`);
    }
    parsed.push({ name, header, rows });
  });
  return { kind: 'json-tables', sheets: parsed };
}
