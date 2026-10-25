import { describe, expect, it } from 'vitest';
import {
  buildTsplProgram,
  TSPL_LINE_SEPARATOR,
  tsplBarcode,
  tsplCls,
  tsplCopy,
  tsplDirection,
  tsplGap,
  tsplPrint,
  tsplQrcode,
  tsplSize,
  tsplText,
} from '../src/index.js';

describe('基础命令构造（逐行断言）', () => {
  it('SIZE / GAP / DIRECTION / CLS 精确命令串', () => {
    expect(tsplSize(40, 30)).toBe('SIZE 40 mm,30 mm');
    expect(tsplSize(37.5, 24.05)).toBe('SIZE 37.5 mm,24.05 mm');
    expect(tsplGap(2, 0)).toBe('GAP 2 mm,0 mm');
    expect(tsplGap(0, 0)).toBe('GAP 0 mm,0 mm');
    expect(tsplDirection(1)).toBe('DIRECTION 1');
    expect(tsplCls()).toBe('CLS');
  });

  it('尺寸/间隙校验：非正尺寸、非负间隙之外的值拒绝', () => {
    expect(() => tsplSize(0, 30)).toThrow(/width/);
    expect(() => tsplSize(40, -1)).toThrow(/height/);
    expect(() => tsplSize(Number.NaN, 30)).toThrow(/width/);
    expect(() => tsplGap(-0.5, 0)).toThrow(/gap/);
    expect(() => tsplGap(2, Number.POSITIVE_INFINITY)).toThrow(/offset/);
    expect(() => tsplDirection(2 as never)).toThrow(/direction/);
  });
});

describe('TEXT 文本命令', () => {
  it('默认参数与全量参数的精确命令串', () => {
    expect(tsplText(10, 20, 'HELLO')).toBe('TEXT 10,20,"2",0,1,1,"HELLO"');
    expect(
      tsplText(5, 6, 'WO-2026-0001', {
        font: '3',
        rotation: 90,
        xMultiplier: 2,
        yMultiplier: 3,
      }),
    ).toBe('TEXT 5,6,"3",90,2,3,"WO-2026-0001"');
  });

  it('转义语义：换行/控制字符/双引号一律拒绝（非静默转义）', () => {
    expect(() => tsplText(0, 0, 'line1\nline2')).toThrow(/control characters/);
    expect(() => tsplText(0, 0, 'bad\x00char')).toThrow(/control characters/);
    expect(() => tsplText(0, 0, 'del\x7fete')).toThrow(/control characters/);
    expect(() => tsplText(0, 0, 'say "hi"')).toThrow(/double quotes/);
    expect(() => tsplText(0, 0, '')).toThrow(/non-empty/);
  });

  it('反斜杠无转义含义，按字面允许（协议语义写明）', () => {
    expect(tsplText(0, 0, 'a\\b')).toBe('TEXT 0,0,"2",0,1,1,"a\\b"');
  });

  it('坐标与倍率校验：负数/非整数/超界拒绝', () => {
    expect(() => tsplText(-1, 0, 'X')).toThrow(/x/);
    expect(() => tsplText(0, 1.5, 'X')).toThrow(/y/);
    expect(() => tsplText(0, 0, 'X', { xMultiplier: 0 })).toThrow(/xMultiplier/);
    expect(() => tsplText(0, 0, 'X', { yMultiplier: 11 })).toThrow(/multiplier/);
    expect(() => tsplText(0, 0, 'X', { rotation: 45 as never })).toThrow(/rotation/);
    expect(() => tsplText(0, 0, 'X', { font: 'bad,name' })).toThrow(/font/);
    expect(() => tsplText(0, 0, 'X', { font: 'q"name' })).toThrow(/font/);
  });
});

describe('BARCODE 一维码命令（码值字符域）', () => {
  it('精确命令串（缺省与自定义参数）', () => {
    expect(tsplBarcode(10, 20, '128', 'WO2026')).toBe(
      'BARCODE 10,20,"128",80,0,0,2,2,"WO2026"',
    );
    expect(
      tsplBarcode(0, 0, '39', 'ABC-123', { height: 60, humanReadable: true, narrow: 3, wide: 6 }),
    ).toBe('BARCODE 0,0,"39",60,1,0,3,6,"ABC-123"');
  });

  it('128：可打印 ASCII 通过；控制字符/引号/非 ASCII 拒绝', () => {
    expect(tsplBarcode(0, 0, '128', 'A B-C.D_E+F~')).toContain('"A B-C.D_E+F~"');
    expect(() => tsplBarcode(0, 0, '128', 'A"B')).toThrow(/double quotes/);
    expect(() => tsplBarcode(0, 0, '128', 'A\tB')).toThrow(/control characters/);
    expect(() => tsplBarcode(0, 0, '128', '零件')).toThrow(/printable ASCII/);
  });

  it('39：大写字母/数字/符号集通过，小写与星号拒绝（起始符由打印机附加）', () => {
    expect(tsplBarcode(0, 0, '39', 'A1 -$./+%')).toContain('A1 -$./+%');
    expect(() => tsplBarcode(0, 0, '39', 'abc')).toThrow(/39/);
    expect(() => tsplBarcode(0, 0, '39', 'A*B')).toThrow(/39/);
  });

  it('EAN13：12 数据位通过；13 位校验位正确通过、错误拒绝；长度错拒绝', () => {
    expect(tsplBarcode(0, 0, 'EAN13', '400638133393')).toContain('400638133393');
    expect(tsplBarcode(0, 0, 'EAN13', '4006381333931')).toContain('4006381333931');
    expect(() => tsplBarcode(0, 0, 'EAN13', '4006381333932')).toThrow(/check digit 2 does not match expected 1/);
    expect(() => tsplBarcode(0, 0, 'EAN13', '40063813339')).toThrow(/12 data digits/);
    expect(() => tsplBarcode(0, 0, 'EAN13', '40063X1333931')).toThrow(/digits only/);
  });

  it('EAN8 / UPCA：已知有效样本通过、坏校验位拒绝', () => {
    expect(tsplBarcode(0, 0, 'EAN8', '9638507')).toContain('9638507');
    expect(tsplBarcode(0, 0, 'EAN8', '96385074')).toContain('96385074');
    expect(() => tsplBarcode(0, 0, 'EAN8', '96385075')).toThrow(/check digit 5 does not match expected 4/);
    expect(tsplBarcode(0, 0, 'UPCA', '03600029145')).toContain('03600029145');
    expect(tsplBarcode(0, 0, 'UPCA', '036000291452')).toContain('036000291452');
    expect(() => tsplBarcode(0, 0, 'UPCA', '036000291453')).toThrow(/check digit 3 does not match expected 2/);
  });

  it('未知码制与非法几何参数拒绝', () => {
    expect(() => tsplBarcode(0, 0, '93' as never, 'ABC')).toThrow(/barcode type/);
    expect(() => tsplBarcode(0, 0, '128', 'ABC', { height: 0 })).toThrow(/height/);
    expect(() => tsplBarcode(0, 0, '128', 'ABC', { narrow: 0 })).toThrow(/narrow/);
    expect(() => tsplBarcode(-1, 0, '128', 'ABC')).toThrow(/x/);
  });
});

describe('QRCODE 二维码命令', () => {
  it('精确命令串（缺省与自定义参数）', () => {
    expect(tsplQrcode(10, 10, 'WO-2026-0001')).toBe(
      'QRCODE 10,10,M,4,A,0,"WO-2026-0001"',
    );
    expect(tsplQrcode(0, 0, 'https://example.com/x', { ecc: 'Q', cellWidth: 6, rotation: 90 })).toBe(
      'QRCODE 0,0,Q,6,A,90,"https://example.com/x"',
    );
  });

  it('非法参数与坏内容拒绝', () => {
    expect(() => tsplQrcode(10, 10, 'x\ny')).toThrow(/control characters/);
    expect(() => tsplQrcode(10, 10, 'say "hi"')).toThrow(/double quotes/);
    expect(() => tsplQrcode(10, 10, '')).toThrow(/non-empty/);
    expect(() => tsplQrcode(10, 10, 'X', { cellWidth: 0 })).toThrow(/cellWidth/);
    expect(() => tsplQrcode(10, 10, 'X', { cellWidth: 11 })).toThrow(/cellWidth/);
    expect(() => tsplQrcode(10, 10, 'X', { ecc: 'X' as never })).toThrow(/ecc/);
    expect(() => tsplQrcode(-1, 10, 'X')).toThrow(/x/);
  });
});

describe('PRINT / COPY 与命令拼接', () => {
  it('PRINT m 与 COPY n 的精确命令串与校验', () => {
    expect(tsplPrint()).toBe('PRINT 1');
    expect(tsplPrint(3)).toBe('PRINT 3');
    expect(tsplCopy(2)).toBe('COPY 2');
    expect(() => tsplPrint(0)).toThrow(/print count/);
    expect(() => tsplCopy(0)).toThrow(/copy count/);
  });

  it('buildTsplProgram：CRLF 逐行拼接、无尾随分隔符', () => {
    const program = buildTsplProgram([tsplSize(40, 30), tsplCls(), tsplPrint(1)]);
    expect(program).toBe('SIZE 40 mm,30 mm\r\nCLS\r\nPRINT 1');
    expect(program.split(TSPL_LINE_SEPARATOR)).toEqual(['SIZE 40 mm,30 mm', 'CLS', 'PRINT 1']);
    expect(program.endsWith(TSPL_LINE_SEPARATOR)).toBe(false);
  });

  it('buildTsplProgram：空命令/含换行的命令拒绝（行协议保护）', () => {
    expect(() => buildTsplProgram([])).toThrow(/at least one command/);
    expect(() => buildTsplProgram([''])).toThrow(/non-empty/);
    expect(() => buildTsplProgram(['CLS\r\nPRINT 1'])).toThrow(/single-line/);
    expect(() => buildTsplProgram(['PRINT 1\x00'])).toThrow(/single-line/);
  });
});
