/**
 * 单据打印场景构造器（M1 增量 4-K，Done-when 6）
 *
 * 通用单据形状：标题 + 表格（表头行 + 数据行，矩形）+ 可选脚注，
 * 产出 PdfDefinition（纯数据，可直接喂给渲染端口）。列宽默认均分（'*'），
 * 特殊布局由调用方基于 createPdfDefinition 自行组装。
 */
import {
  createPdfDefinition,
  type PdfDefinition,
  type PdfPageSize,
} from './pdf-document.js';

export interface TableDocumentSpec {
  /** 单据标题（同时进 info.title） */
  readonly title: string;
  /** 表头行（非空；列数由此确定） */
  readonly headerRow: readonly string[];
  /** 数据行：每行列数须与表头一致；单元格允许空串 */
  readonly rows: readonly (readonly string[])[];
  /** 可选脚注（如打印时间、备注） */
  readonly footerNote?: string;
  readonly pageSize?: PdfPageSize;
  /** 文档作者（进 info.author，可空） */
  readonly author?: string;
}

/** 含表格的 doc-definition 构造器（标题 → 表格 → 可选脚注） */
export function buildTablePdfDocument(spec: TableDocumentSpec): PdfDefinition {
  if (typeof spec.title !== 'string' || spec.title.length === 0) {
    throw new Error('invalid table document: title must be a non-empty string');
  }
  if (!Array.isArray(spec.headerRow) || spec.headerRow.length === 0) {
    throw new Error('invalid table document: headerRow must be a non-empty array');
  }
  const columns = spec.headerRow.length;
  for (const row of spec.rows) {
    if (!Array.isArray(row) || row.length !== columns) {
      throw new Error(
        `invalid table document: every row must have ${columns} cells to match the header row`,
      );
    }
    for (const cell of row) {
      if (typeof cell !== 'string') {
        throw new Error('invalid table document: cells must be strings');
      }
    }
  }
  if (spec.footerNote !== undefined && (typeof spec.footerNote !== 'string' || spec.footerNote.length === 0)) {
    throw new Error('invalid table document: footerNote must be a non-empty string when present');
  }

  const body: { text: string; style?: string }[][] = [
    spec.headerRow.map((text) => ({ text, style: 'tableHeader' })),
    ...spec.rows.map((row) => row.map((text) => ({ text }))),
  ];

  return createPdfDefinition({
    content: [
      { text: spec.title, style: 'heading', margin: [0, 0, 0, 8] as const },
      {
        table: {
          headerRows: 1,
          widths: spec.headerRow.map(() => '*'),
          body,
        },
      },
      ...(spec.footerNote === undefined
        ? []
        : [{ text: spec.footerNote, style: 'footnote', margin: [0, 8, 0, 0] as const }]),
    ],
    styles: {
      heading: { bold: true, fontSize: 14 },
      tableHeader: { bold: true },
      footnote: { fontSize: 9 },
    },
    info: {
      title: spec.title,
      ...(spec.author === undefined ? {} : { author: spec.author }),
    },
    ...(spec.pageSize === undefined ? {} : { pageSize: spec.pageSize }),
  });
}
