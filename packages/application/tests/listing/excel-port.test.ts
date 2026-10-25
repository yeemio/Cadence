/**
 * Excel 端口语义测试（M2-W3）：表头别名等价识别、文件级问题（整单拒绝）、
 * 错误行提示（逐行跳过）、内建 JsonTablesExcelPort 行为与源形状校验。
 * "复刻表头别名校验行为"（D13 导入复刻口径）的行为锚点在此——对账阶段以
 * 活系统行为比对本组断言。
 */
import { describe, expect, it } from 'vitest';
import {
  JsonTablesExcelPort,
  LISTING_IMPORT_ALIAS_MAP,
  fileLevelIssues,
  parseListingTable,
  requireExcelSource,
} from '../../src/listing/excel-port.js';
import { ListingInputError } from '../../src/listing/listing-errors.js';

const CN_HEADER = ['图号', '物料编码', '物料名称', '规格型号', '数量', '需求日期'];
const EN_HEADER = ['drawing', 'code', 'name', 'spec', 'quantity', 'neededBy'];
const ALIAS_HEADER = ['图纸编号', '编码', '名称', '规格', '需求数量', '交货日期'];

function sheet(header: readonly string[], rows: readonly (readonly string[])[]) {
  return { name: '清单', header, rows };
}

describe('表头别名定位', () => {
  it('三套别名表头等价识别同一逻辑列', () => {
    const row = ['DWG-1', 'M-001', '螺栓', 'M8x40', '10', '2026-11-01'];
    for (const header of [CN_HEADER, EN_HEADER, ALIAS_HEADER]) {
      const parsed = parseListingTable(sheet(header, [row]));
      expect(parsed.issues).toEqual([]);
      expect(parsed.rows).toEqual([
        {
          lineNo: 1,
          drawingNo: 'DWG-1',
          code: 'M-001',
          name: '螺栓',
          spec: 'M8x40',
          quantity: 10,
          neededBy: '2026-11-01',
        },
      ]);
    }
  });

  it('别名映射含三组中文别名 + 英文键（初版口径快照）', () => {
    expect(LISTING_IMPORT_ALIAS_MAP['图号']).toBe('drawingNo');
    expect(LISTING_IMPORT_ALIAS_MAP['图纸编号']).toBe('drawingNo');
    expect(LISTING_IMPORT_ALIAS_MAP['物料编码']).toBe('code');
    expect(LISTING_IMPORT_ALIAS_MAP['需求数量']).toBe('quantity');
    expect(LISTING_IMPORT_ALIAS_MAP['交货日期']).toBe('neededBy');
  });

  it('缺 quantity 列 → 文件级问题（整单拒绝口径）', () => {
    const parsed = parseListingTable(sheet(['图号', '物料编码', '数量x'], [['DWG-1', 'M-001', '10']]));
    expect(fileLevelIssues(parsed.issues).length).toBe(1);
    expect(fileLevelIssues(parsed.issues)[0]?.message).toContain('数量列');
  });

  it('缺全部物料定位列 → 文件级问题', () => {
    const parsed = parseListingTable(sheet(['图号', '数量'], [['DWG-1', '10']]));
    expect(fileLevelIssues(parsed.issues).length).toBe(1);
    expect(fileLevelIssues(parsed.issues)[0]?.message).toContain('物料定位列');
  });

  it('重复逻辑列取首列；列序可乱；表头归一化（全角/空白容忍）', () => {
    const parsed = parseListingTable(sheet(['数量', '物料编码', '数量', '编码'], [['5', 'M-1', '9', 'M-2']]));
    expect(parsed.rows[0]?.quantity).toBe(5); // 首列数量生效
    expect(parsed.rows[0]?.code).toBe('M-1');
    const normalized = parseListingTable(sheet([' 物 料 编 码 ', '数量'], [['M-1', '5']]));
    expect(normalized.rows[0]?.code).toBe('M-1');
  });
});

describe('错误行提示（逐行跳过，不炸整单）', () => {
  it('数量非法 / 物料信息为空 / 日期非法 各自跳过并提示', () => {
    const parsed = parseListingTable(
      sheet(CN_HEADER, [
        ['DWG-1', 'M-001', '螺栓', 'M8', '10', ''], // 正常行
        ['DWG-2', 'M-002', '垫片', 'D8', 'abc', ''], // 数量非数值
        ['DWG-3', 'M-003', '垫片', 'D8', '0', ''], // 数量非正
        ['', '', '', '', '3', ''], // 物料信息为空
        ['DWG-4', 'M-004', '销轴', 'D6', '2', 'not-a-date'], // 日期非法
        ['', '', '', '', '', ''], // 空行不计问题
      ]),
    );
    expect(parsed.rows.length).toBe(1);
    expect(parsed.rows[0]?.code).toBe('M-001');
    const messages = parsed.issues.map((issue) => issue.message);
    expect(messages.length).toBe(4);
    expect(messages[0]).toContain('第 2 行数量非法');
    expect(messages[1]).toContain('第 3 行数量非法');
    expect(messages[2]).toContain('第 4 行物料信息为空');
    expect(messages[3]).toContain('第 5 行需求日期非法');
    expect(parsed.issues.every((issue) => issue.lineNo !== null)).toBe(true);
  });

  it('图号/编码/名称/规格可缺省（标准件常无图号）；数量上限 1e9', () => {
    const parsed = parseListingTable(sheet(['物料编码', '数量'], [['M-001', '7']]));
    expect(parsed.rows[0]).toEqual({
      lineNo: 1,
      drawingNo: null,
      code: 'M-001',
      name: null,
      spec: null,
      quantity: 7,
      neededBy: null,
    });
    const overflow = parseListingTable(sheet(['物料编码', '数量'], [['M-001', '1e10']]));
    expect(overflow.rows.length).toBe(0);
    expect(overflow.issues[0]?.message).toContain('数量非法');
  });
});

describe('JsonTablesExcelPort（内建实现）', () => {
  const port = new JsonTablesExcelPort();

  it('json-tables 源解析 = 语义纯函数；无工作表 → 文件级问题', async () => {
    const parsed = await port.parseListingImport({
      kind: 'json-tables',
      sheets: [sheet(CN_HEADER, [['DWG-1', 'M-001', '螺栓', 'M8', '10', '']])],
    });
    expect(parsed.rows.length).toBe(1);
    const empty = await port.parseListingImport({ kind: 'json-tables', sheets: [] });
    expect(fileLevelIssues(empty.issues).length).toBe(1);
  });

  it('xlsx-bytes 源在无 ExcelJS 适配器时给文件级提示（依赖未入树，合流替换）', async () => {
    const parsed = await port.parseListingImport({ kind: 'xlsx-bytes', base64: 'AAAA' });
    expect(parsed.rows).toEqual([]);
    expect(fileLevelIssues(parsed.issues)[0]?.message).toContain('ExcelJS');
  });

  it('exportWorkbook 回声 json-tables（适配器产 xlsx 字节，端口语义一致）', async () => {
    const exported = await port.exportWorkbook([sheet(['数量'], [])]);
    expect(exported.kind).toBe('json-tables');
    if (exported.kind === 'json-tables') {
      expect(exported.sheets[0]?.header).toEqual(['数量']);
    }
  });
});

describe('requireExcelSource（源形状预检）', () => {
  it('json-tables 深校验：header/rows 字符串化', () => {
    const source = requireExcelSource(
      { kind: 'json-tables', sheets: [{ name: 's', header: ['数量'], rows: [['1']] }] },
      'excel',
    );
    expect(source.kind).toBe('json-tables');
    expect(() => requireExcelSource({ kind: 'json-tables', sheets: [{ name: 's', header: [1], rows: [] }] }, 'excel')).toThrow(
      ListingInputError,
    );
    expect(() => requireExcelSource({ kind: 'yaml' }, 'excel')).toThrow(ListingInputError);
    expect(() => requireExcelSource({ kind: 'xlsx-bytes' }, 'excel')).toThrow(ListingInputError);
  });
});
