/**
 * PDF 文档定义（doc-definition）——纯数据形状 + 构造器（M1 增量 4-K）
 *
 * 类型为 pdfmake TDocumentDefinitions 的**结构子集**，但清洁室自持：
 * 不 import SDK 类型、不依赖 SDK 版本形状（ADR-0002 清洁室纪律在类型层的
 * 应用——适配器负责结构兼容，域层只认自己的类型）。适配器真实渲染测试
 * （pdf-render-node）即是对"结构子集兼容性"的持续验证。
 *
 * 词汇（ADR-0010 三问）：document / table / text / pdf 均为跨行业通用词。
 * 构造即深冻结（ADR-0003 #4）；冻结的是入参的克隆，调用方原对象不被冻结、
 * 事后改动不影响已构造的定义（快照语义）。
 */
import { deepFreeze } from './internal/deep-freeze.js';

export type PdfAlignment = 'left' | 'center' | 'right';

/** 页边距：单值 | [上下, 左右] | [上, 右, 下, 左]（pdfmake 兼容形状） */
export type PdfMargin = number | readonly [number, number] | readonly [number, number, number, number];

export type PdfPageSize = 'A4' | 'A5' | 'letter';

/** 样式属性（content 与 styles 共用的最小集） */
export interface PdfTextStyle {
  readonly bold?: boolean;
  readonly fontSize?: number;
  readonly alignment?: PdfAlignment;
  readonly margin?: PdfMargin;
}

export interface PdfTextContent extends PdfTextStyle {
  readonly text: string;
  /** 命名样式引用（styles 表中的键） */
  readonly style?: string;
}

/** 表格单元格：允许空串（空白单元格是合法数据），可带命名样式 */
export interface PdfTableCell {
  readonly text: string;
  readonly style?: string;
  readonly bold?: boolean;
  readonly alignment?: PdfAlignment;
}

/** 列宽：auto 自适应 | * 均分 | 固定宽度（pt） */
export type PdfColumnWidth = 'auto' | '*' | number;

export interface PdfTableContent {
  readonly table: {
    /** 首部行数（重复于每页表头），须 ≤ 行数 */
    readonly headerRows?: number;
    readonly widths?: readonly PdfColumnWidth[];
    readonly body: readonly (readonly PdfTableCell[])[];
  };
}

export type PdfContent = string | PdfTextContent | PdfTableContent;

export interface PdfStyles {
  readonly [style: string]: PdfTextStyle;
}

/** 文档元数据（pdfmake info 段） */
export interface PdfMetadata {
  readonly title: string;
  readonly author?: string;
  readonly subject?: string;
  readonly keywords?: string;
}

/** 一份可渲染的文档定义：纯数据（无函数 / Date / Map），可 structuredClone */
export interface PdfDefinition {
  readonly content: readonly PdfContent[];
  readonly styles?: Readonly<PdfStyles>;
  readonly defaultStyle?: Readonly<PdfTextStyle>;
  readonly info?: Readonly<PdfMetadata>;
  readonly pageSize?: PdfPageSize;
}

/**
 * PDF 渲染端口：定义 → PDF 字节。实现负责懒加载具体渲染库
 * （Node 侧见 pdf-render-node.ts 的 pdfmake 适配器；浏览器接线期另配）。
 */
export interface PdfRenderPort {
  renderToBinary(definition: PdfDefinition): Promise<Uint8Array>;
}

const PAGE_SIZES: readonly PdfPageSize[] = ['A4', 'A5', 'letter'];
const ALIGNMENTS: readonly PdfAlignment[] = ['left', 'center', 'right'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertTextStyle(name: string, style: PdfTextStyle): void {
  if (style.bold !== undefined && typeof style.bold !== 'boolean') {
    throw new Error(`invalid ${name}.bold: expected a boolean`);
  }
  if (style.fontSize !== undefined) {
    if (typeof style.fontSize !== 'number' || !Number.isFinite(style.fontSize) || style.fontSize <= 0) {
      throw new Error(`invalid ${name}.fontSize: expected a positive finite number`);
    }
  }
  if (style.alignment !== undefined && !ALIGNMENTS.includes(style.alignment)) {
    throw new Error(`invalid ${name}.alignment: expected one of ${ALIGNMENTS.join(' / ')}`);
  }
  if (style.margin !== undefined) {
    const margin = style.margin;
    const values = typeof margin === 'number' ? [margin] : margin;
    if (!Array.isArray(values) || values.length === 0 || values.length > 4) {
      throw new Error(`invalid ${name}.margin: expected a number or an array of 1~4 numbers`);
    }
    for (const v of values) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new Error(`invalid ${name}.margin: expected non-negative numbers`);
      }
    }
    if (typeof margin === 'number' && (!Number.isFinite(margin) || margin < 0)) {
      throw new Error(`invalid ${name}.margin: expected a non-negative number`);
    }
  }
}

function assertContentBlock(block: PdfContent): void {
  if (typeof block === 'string') {
    if (block.length === 0) throw new Error('invalid pdf content: text blocks must be non-empty strings');
    return;
  }
  if (!isPlainObject(block)) {
    throw new Error('invalid pdf content: expected a string, text block, or table block');
  }
  if ('table' in block) {
    const table = (block as { table?: unknown }).table;
    if (!isPlainObject(table)) throw new Error('invalid pdf table: expected a table object');
    const body = (table as { body?: unknown }).body;
    if (!Array.isArray(body) || body.length === 0) {
      throw new Error('invalid pdf table.body: expected a non-empty array of rows');
    }
    const firstRow = body[0];
    if (!Array.isArray(firstRow)) throw new Error('invalid pdf table.body: rows must be arrays of cells');
    const width = firstRow.length;
    if (width === 0) throw new Error('invalid pdf table.body: rows must not be empty');
    for (const row of body) {
      if (!Array.isArray(row) || row.length !== width) {
        throw new Error(`invalid pdf table.body: every row must have ${width} cells (rectangular body)`);
      }
      for (const cell of row) {
        if (!isPlainObject(cell) || typeof (cell as { text?: unknown }).text !== 'string') {
          throw new Error('invalid pdf table cell: expected { text: string }');
        }
        if (cell['style'] !== undefined && typeof cell['style'] !== 'string') {
          throw new Error('invalid pdf table cell.style: expected a string');
        }
      }
    }
    const headerRows = (table as { headerRows?: unknown }).headerRows;
    if (
      headerRows !== undefined &&
      (typeof headerRows !== 'number' || !Number.isInteger(headerRows) || headerRows < 0 || headerRows > body.length)
    ) {
      throw new Error(`invalid pdf table.headerRows: expected an integer within 0~${body.length}`);
    }
    const widths = (table as { widths?: unknown }).widths;
    if (widths !== undefined) {
      if (!Array.isArray(widths) || widths.length !== width) {
        throw new Error(`invalid pdf table.widths: expected ${width} column widths`);
      }
      for (const w of widths) {
        if (w !== 'auto' && w !== '*' && (typeof w !== 'number' || !Number.isFinite(w) || w < 0)) {
          throw new Error("invalid pdf table.widths entry: expected 'auto', '*', or a non-negative number");
        }
      }
    }
    return;
  }
  const text = (block as { text?: unknown }).text;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('invalid pdf text block: expected a non-empty text');
  }
  if (block['style'] !== undefined && typeof block['style'] !== 'string') {
    throw new Error('invalid pdf text block.style: expected a string');
  }
  assertTextStyle('pdf text block', block as PdfTextContent);
}

function assertPdfDefinition(definition: PdfDefinition): void {
  if (!isPlainObject(definition)) {
    throw new Error('invalid pdf definition: expected an object');
  }
  if (!Array.isArray(definition.content) || definition.content.length === 0) {
    throw new Error('invalid pdf definition.content: expected a non-empty array');
  }
  for (const block of definition.content) assertContentBlock(block);
  if (definition.styles !== undefined) {
    if (!isPlainObject(definition.styles)) {
      throw new Error('invalid pdf definition.styles: expected an object of named styles');
    }
    for (const [name, style] of Object.entries(definition.styles)) {
      if (name.length === 0) throw new Error('invalid pdf definition.styles: style names must be non-empty');
      assertTextStyle(`pdf styles.${name}`, style as PdfTextStyle);
    }
  }
  if (definition.defaultStyle !== undefined) {
    assertTextStyle('pdf definition.defaultStyle', definition.defaultStyle);
  }
  if (definition.info !== undefined) {
    if (!isPlainObject(definition.info) || typeof definition.info['title'] !== 'string' || definition.info['title'].length === 0) {
      throw new Error('invalid pdf definition.info: expected { title: string } with a non-empty title');
    }
  }
  if (definition.pageSize !== undefined && !PAGE_SIZES.includes(definition.pageSize)) {
    throw new Error(`invalid pdf definition.pageSize: expected one of ${PAGE_SIZES.join(' / ')}`);
  }
}

/**
 * 构造文档定义：校验 + 深冻结（克隆快照，不改冻调用方对象）。
 * 事后修改入参不影响返回值；返回值任何层级不可再赋值。
 */
export function createPdfDefinition(definition: PdfDefinition): PdfDefinition {
  assertPdfDefinition(definition);
  return deepFreeze(structuredClone(definition)) as PdfDefinition;
}

/** 结构守卫（轻量：形状对即通过，用于 PrintJob 载荷校验） */
export function isPdfDefinition(value: unknown): value is PdfDefinition {
  if (!isPlainObject(value)) return false;
  if (!Array.isArray(value['content']) || value['content'].length === 0) return false;
  try {
    assertPdfDefinition(value as unknown as PdfDefinition);
    return true;
  } catch {
    return false;
  }
}
