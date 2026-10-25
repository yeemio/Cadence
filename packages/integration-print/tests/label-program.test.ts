import { describe, expect, it } from 'vitest';
import { buildQrLabelProgram, mmToDots } from '../src/index.js';

describe('mmToDots 换算', () => {
  it('dots = mm × dpi / 25.4（四舍五入）', () => {
    expect(mmToDots(25.4, 203)).toBe(203);
    expect(mmToDots(10, 300)).toBe(118);
    expect(mmToDots(25.4, 600)).toBe(600);
  });

  it('非法 mm 拒绝', () => {
    expect(() => mmToDots(0, 203)).toThrow(/mm/);
    expect(() => mmToDots(-1, 300)).toThrow(/mm/);
  });
});

describe('buildQrLabelProgram（二维码 + 文本行，逐行断言）', () => {
  const spec = {
    size: { widthMm: 40, heightMm: 30 },
    qrcode: { content: 'WO-2026-0001', xDots: 16, yDots: 16 },
    lines: [{ text: 'WO-2026-0001' }, { text: 'CELL-A  QTY 4', font: '3' }],
  };

  it('完整命令序与默认布局（x=8，y 自 8 起每行 +30）', () => {
    const program = buildQrLabelProgram(spec);
    expect(program.split('\r\n')).toEqual([
      'SIZE 40 mm,30 mm',
      'GAP 2 mm,0 mm',
      'DIRECTION 1',
      'CLS',
      'QRCODE 16,16,M,4,A,0,"WO-2026-0001"',
      'TEXT 8,8,"2",0,1,1,"WO-2026-0001"',
      'TEXT 8,38,"3",0,1,1,"CELL-A  QTY 4"',
      'PRINT 1',
    ]);
  });

  it('显式坐标覆盖默认布局；gapMm/direction 可覆写', () => {
    const program = buildQrLabelProgram({
      ...spec,
      gapMm: 0,
      direction: 0,
      lines: [{ text: 'TOP', xDots: 100, yDots: 200 }],
    });
    expect(program.split('\r\n')).toEqual([
      'SIZE 40 mm,30 mm',
      'GAP 0 mm,0 mm',
      'DIRECTION 0',
      'CLS',
      'QRCODE 16,16,M,4,A,0,"WO-2026-0001"',
      'TEXT 100,200,"2",0,1,1,"TOP"',
      'PRINT 1',
    ]);
  });

  it('多标签复制（COPY 语义）：copies=3 → PRINT 1 + COPY 2（总计 3 张）', () => {
    const program = buildQrLabelProgram({ ...spec, copies: 3 });
    const lines = program.split('\r\n');
    expect(lines.slice(-2)).toEqual(['PRINT 1', 'COPY 2']);
  });

  it('copies=1 → 无 COPY 行', () => {
    const lines = buildQrLabelProgram(spec).split('\r\n');
    expect(lines.at(-1)).toBe('PRINT 1');
    expect(lines).toHaveLength(8);
  });

  it('非法规格拒绝：空文本行、坏份数、坏内容透传构造器校验', () => {
    expect(() => buildQrLabelProgram({ ...spec, lines: [] })).toThrow(/at least one text line/);
    expect(() => buildQrLabelProgram({ ...spec, copies: 0 })).toThrow(/copies/);
    expect(() =>
      buildQrLabelProgram({ ...spec, lines: [{ text: 'bad"quote' }] }),
    ).toThrow(/double quotes/);
  });
});
