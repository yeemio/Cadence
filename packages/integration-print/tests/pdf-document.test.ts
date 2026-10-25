import { describe, expect, it } from 'vitest';
import {
  buildTablePdfDocument,
  createPdfDefinition,
  isPdfDefinition,
  type PdfTableContent,
} from '../src/index.js';

const tableBlock: PdfTableContent = {
  table: {
    headerRows: 1,
    widths: ['auto', '*', 'auto'],
    body: [
      [{ text: 'No' }, { text: 'Item' }, { text: 'Qty' }],
      [{ text: '1' }, { text: 'Flange' }, { text: '4' }],
    ],
  },
};

describe('createPdfDefinition（纯数据 + 深冻结快照）', () => {
  it('校验通过并深冻结（含嵌套表格体）', () => {
    const definition = createPdfDefinition({
      content: [{ text: 'Ticket', bold: true }, tableBlock],
      styles: { heading: { bold: true, fontSize: 14 } },
      info: { title: 'Ticket' },
    });
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.content)).toBe(true);
    expect(Object.isFrozen(definition.content[1])).toBe(true);
    const clonedTable = (definition.content[1] as typeof tableBlock).table;
    expect(Object.isFrozen(clonedTable.body[0])).toBe(true);
    // 冻结的是克隆：输入对象不被冻结
    expect(Object.isFrozen(tableBlock)).toBe(false);
    expect(definition.info?.title).toBe('Ticket');
    expect(isPdfDefinition(definition)).toBe(true);
  });

  it('冻结的是入参克隆：调用方对象不被冻结、事后改动不影响定义', () => {
    const input = {
      content: [{ text: 'before' }],
      info: { title: 't' },
    };
    const definition = createPdfDefinition(input);
    expect(Object.isFrozen(input)).toBe(false);
    (input.content[0] as { text: string }).text = 'after';
    expect((definition.content[0] as { text: string }).text).toBe('before');
  });

  it('结构校验：坏内容/坏样式/坏表格/坏元数据逐项拒绝', () => {
    expect(() => createPdfDefinition({ content: [] })).toThrow(/content/);
    expect(() => createPdfDefinition({ content: [''] })).toThrow(/non-empty/);
    expect(() =>
      createPdfDefinition({ content: [{ text: 'x', fontSize: 0 }] }),
    ).toThrow(/fontSize/);
    expect(() =>
      createPdfDefinition({ content: [{ text: 'x', alignment: 'justify' as never }] }),
    ).toThrow(/alignment/);
    expect(() =>
      createPdfDefinition({ content: [{ text: 'x', margin: [-1] as never }] }),
    ).toThrow(/margin/);
    expect(() =>
      createPdfDefinition({
        // 行宽不齐（第 2 行 2 格，第 1 行 3 格）→ 拒绝
        content: [
          {
            table: {
              body: [
                [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
                [{ text: 'd' }, { text: 'e' }],
              ],
            },
          },
        ],
      }),
    ).toThrow(/rectangular/);
    expect(() =>
      createPdfDefinition({
        content: [{ table: { headerRows: 3, body: [[{ text: 'a' }]] } }],
      }),
    ).toThrow(/headerRows/);
    expect(() =>
      createPdfDefinition({
        content: [{ table: { widths: ['*'], body: [[{ text: 'a' }, { text: 'b' }]] } }],
      }),
    ).toThrow(/widths/);
    expect(() => createPdfDefinition({ content: [{ text: 'x' }], info: { title: '' } })).toThrow(
      /info/,
    );
    expect(() =>
      createPdfDefinition({ content: [{ text: 'x' }], pageSize: 'B5' as never }),
    ).toThrow(/pageSize/);
  });

  it('isPdfDefinition 守卫：坏形状返回 false 不抛', () => {
    expect(isPdfDefinition(null)).toBe(false);
    expect(isPdfDefinition({ content: [] })).toBe(false);
    expect(isPdfDefinition({ content: ['ok'] })).toBe(true);
    expect(isPdfDefinition({ content: [{ text: '' }] })).toBe(false);
  });
});

describe('buildTablePdfDocument（含表格的单据构造器，Done-when 6）', () => {
  it('标题 + 表头行 + 数据行 + 脚注，结构逐项断言', () => {
    const definition = buildTablePdfDocument({
      title: 'Work Ticket WO-2026-0001',
      headerRow: ['No', 'Item', 'Qty'],
      rows: [
        ['1', 'Flange DN50', '4'],
        ['2', '', '2'],
      ],
      footerNote: 'Printed at station A',
    });
    expect(definition.content).toHaveLength(3);
    const [title, table, footer] = definition.content as [
      { text: string; style: string },
      { table: { headerRows: number; widths: string[]; body: { text: string; style?: string }[][] } },
      { text: string; style: string },
    ];
    expect(title).toMatchObject({ text: 'Work Ticket WO-2026-0001', style: 'heading' });
    expect(table.table.headerRows).toBe(1);
    expect(table.table.widths).toEqual(['*', '*', '*']);
    expect(table.table.body).toHaveLength(3);
    expect(table.table.body[0]).toEqual([
      { text: 'No', style: 'tableHeader' },
      { text: 'Item', style: 'tableHeader' },
      { text: 'Qty', style: 'tableHeader' },
    ]);
    expect(table.table.body[1]).toEqual([{ text: '1' }, { text: 'Flange DN50' }, { text: '4' }]);
    expect(footer).toMatchObject({ text: 'Printed at station A', style: 'footnote' });
    expect(definition.info).toMatchObject({ title: 'Work Ticket WO-2026-0001' });
    expect(Object.keys(definition.styles ?? {})).toEqual(
      expect.arrayContaining(['heading', 'tableHeader', 'footnote']),
    );
    expect(Object.isFrozen(definition.content)).toBe(true);
  });

  it('脚注/作者/页大小可省略；行宽不齐拒绝；空单元格合法', () => {
    const minimal = buildTablePdfDocument({ title: 'T', headerRow: ['A'], rows: [['']] });
    expect(minimal.content).toHaveLength(2);
    expect(minimal.info?.author).toBeUndefined();
    expect(() =>
      buildTablePdfDocument({ title: 'T', headerRow: ['A', 'B'], rows: [['only-a']] }),
    ).toThrow(/2 cells/);
    expect(() => buildTablePdfDocument({ title: '', headerRow: ['A'], rows: [] })).toThrow(/title/);
  });
});
