/**
 * ExcelJS 适配器测试（M2 后第一增量）：xlsx-bytes 读写互译 + 语义层零漂移锚点。
 *
 * 锚的是端口合同行为（03-listing.md §3/§4 复刻口径）：表头别名等价识别、
 * 错误行逐行提示（不炸整单）、文件级问题整单拒绝、导出为真实 xlsx 字节。
 * 语义纯函数本体已有 application 侧锚定测试，此处只证适配器把 xlsx-bytes
 * 接到同一语义（同表头别名集、同错误行行为）。
 */
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { fileLevelIssues } from '@smes/application';
import { ExcelJsExcelPort } from '../src/exceljs-excel-port.js';

/** 构造一张导入用 xlsx（表头 + 数据行），返回 base64。 */
async function buildXlsxBase64(
  header: readonly string[],
  rows: readonly (readonly (string | number)[])[],
): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('导入单');
  sheet.addRow([...header]);
  for (const row of rows) sheet.addRow([...row]);
  const bytes = await workbook.xlsx.writeBuffer();
  return Buffer.from(bytes as unknown as ArrayBuffer).toString('base64');
}

describe('ExcelJsExcelPort（xlsx-bytes 适配）', () => {
  const port = new ExcelJsExcelPort();

  it('xlsx-bytes 导入：表头别名等价识别 + 错误行逐行提示（语义层零漂移）', async () => {
    // 表头全用别名（图纸编号/编码/名称/规格/需求数量/交货日期）——别名集须等价识别
    const base64 = await buildXlsxBase64(
      ['图纸编号', '编码', '名称', '规格', '需求数量', '交货日期'],
      [
        ['DWG-001', 'C-001', '轴承座', '规格A', 10, '2026-11-01'], // 有效行
        ['DWG-002', 'C-002', '压盖', '规格B', 'abc', '2026-11-02'], // 数量非法 → 错误行
        ['DWG-003', 'C-003', '端盖', '规格C', 5, 'not-a-date'], // 日期非法 → 错误行
        ['', '', '', '', '', ''], // 空行跳过
        ['DWG-004', 'C-004', '法兰', '规格D', 2, ''], // 日期空 = null 合法
      ],
    );
    const result = await port.parseListingImport({ kind: 'xlsx-bytes', base64 });

    expect(result.issues.filter((issue) => issue.lineNo === null)).toEqual([]); // 无文件级问题
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ lineNo: 1, drawingNo: 'DWG-001', quantity: 10, neededBy: '2026-11-01' });
    expect(result.rows[1]).toMatchObject({ lineNo: 5, drawingNo: 'DWG-004', quantity: 2, neededBy: null });
    const errorLines = result.issues.filter((issue) => issue.lineNo !== null).map((issue) => issue.lineNo);
    expect(errorLines).toEqual([2, 3]); // 错误行提示定位（1 起行号，不含表头）
  });

  it('xlsx-bytes 导入：缺数量列 → 文件级问题（整单拒绝口径）', async () => {
    const base64 = await buildXlsxBase64(['图号', '编码'], [['DWG-001', 'C-001']]);
    const result = await port.parseListingImport({ kind: 'xlsx-bytes', base64 });
    expect(result.rows).toEqual([]);
    expect(fileLevelIssues(result.issues).length).toBeGreaterThan(0);
  });

  it('xlsx-bytes 导入：坏字节 → 文件级问题（不抛出）', async () => {
    const result = await port.parseListingImport({ kind: 'xlsx-bytes', base64: Buffer.from('not-an-xlsx').toString('base64') });
    expect(result.rows).toEqual([]);
    expect(fileLevelIssues(result.issues)).toHaveLength(1);
  });

  it('json-tables 源委托内建语义（不回归）', async () => {
    const result = await port.parseListingImport({
      kind: 'json-tables',
      sheets: [{ name: 's', header: ['图号', '数量'], rows: [['DWG-1', '3']] }],
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.quantity).toBe(3);
  });

  it('导出为真实 xlsx 字节：ExcelJS 可读回（名称/表头/行保真）', async () => {
    const output = await port.exportWorkbook([
      { name: '成本快照', header: ['工作令', '金额（分）'], rows: [['WO-1', '12500'], ['WO-2', '0']] },
    ]);
    expect(output.kind).toBe('xlsx-base64');
    if (output.kind !== 'xlsx-base64') return;

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(output.base64, 'base64') as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    expect(workbook.worksheets).toHaveLength(1);
    expect(workbook.worksheets[0]?.name).toBe('成本快照');
    const sheet = workbook.worksheets[0];
    const rowText = (row: number): string[] =>
      ((sheet?.getRow(row).values as readonly ExcelJS.CellValue[]).slice(1) ?? []).map((cell) =>
        cell === null || cell === undefined ? '' : String(cell),
      );
    expect(rowText(1)).toEqual(['工作令', '金额（分）']);
    expect(rowText(2)).toEqual(['WO-1', '12500']);
    expect(rowText(3)).toEqual(['WO-2', '0']);
  });

  it('导出读回互译闭环：导出 → 再导入解析（同语义）', async () => {
    const base64 = await buildXlsxBase64(['图号', '编码', '数量'], [['DWG-9', 'C-9', 7]]);
    const output = await port.exportWorkbook([{ name: '再导出', header: ['图号', '编码', '数量'], rows: [['DWG-9', 'C-9', '7']] }]);
    expect(output.kind).toBe('xlsx-base64');
    if (output.kind !== 'xlsx-base64') return;
    const parsed = await port.parseListingImport({ kind: 'xlsx-bytes', base64: output.base64 });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({ drawingNo: 'DWG-9', code: 'C-9', quantity: 7 });
  });
});
