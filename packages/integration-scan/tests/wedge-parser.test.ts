import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEDGE_PARSER_OPTIONS,
  nextWedgeParserState,
  parseWedgeSequence,
  resolveWedgeParserOptions,
  type WedgeKeyStroke,
  type WedgeParserOptions,
} from '../src/index.js';

/** 以固定步长生成高速串入（模拟扫码枪） */
function burst(text: string, startMs = 0, stepMs = 5, terminator = 'Enter'): WedgeKeyStroke[] {
  const strokes: WedgeKeyStroke[] = [];
  let at = startMs;
  for (const ch of text) {
    strokes.push({ key: ch, atMs: at });
    at += stepMs;
  }
  strokes.push({ key: terminator, atMs: at });
  return strokes;
}

describe('键盘串入解析（Done-when 4）', () => {
  it('通用格式：前缀 + 码值 + 后缀 + 回车终结 → 正确切分码值', () => {
    const options: WedgeParserOptions = { prefix: '[[', suffix: ']]' };
    const event = parseWedgeSequence(burst('[[WO-2026-0001]]'), options);
    expect(event).toMatchObject({ type: 'accepted' });
    if (event.type === 'accepted') expect(event.code).toBe('WO-2026-0001');
  });

  it('默认配置：纯码值 + 回车终结 → 原样码值', () => {
    const event = parseWedgeSequence(burst('12345678'));
    expect(event).toMatchObject({ type: 'accepted' });
    if (event.type === 'accepted') expect(event.code).toBe('12345678');
  });

  it('自定义终结键（Tab）与最小长度', () => {
    const options: WedgeParserOptions = { terminator: 'Tab', minLength: 2 };
    const event = parseWedgeSequence(burst('AB', 0, 5, 'Tab'), options);
    expect(event).toMatchObject({ type: 'accepted' });
  });

  it('中断：串入中途出现人类速度间隔 → 拒绝整段（gap-timeout）', () => {
    const strokes: WedgeKeyStroke[] = [
      { key: '1', atMs: 0 },
      { key: '2', atMs: 5 },
      // 500ms 间隔：疑似人工接手
      { key: '3', atMs: 505 },
      { key: '4', atMs: 510 },
      { key: 'Enter', atMs: 515 },
    ];
    const event = parseWedgeSequence(strokes);
    expect(event).toMatchObject({ type: 'rejected', reason: 'gap-timeout' });
  });

  it('中断后重新起段：后续合法高速串入仍可接受', () => {
    const strokes: WedgeKeyStroke[] = [
      { key: '1', atMs: 0 },
      { key: '2', atMs: 400 }, // gap 400ms > 50：前段丢弃
      ...burst('WO-9', 500), // 全新一段
    ];
    const event = parseWedgeSequence(strokes, { minLength: 3 });
    if (event.type === 'accepted') {
      expect(event.code).toBe('WO-9');
    } else {
      expect.unreachable(`expected accepted, got ${event.type}`);
    }
  });

  it('超时：整段串入超过 maxBurstMs → 拒绝（burst-timeout）', () => {
    const options: WedgeParserOptions = { maxBurstMs: 100, interKeyGapMs: 1000 };
    const strokes: WedgeKeyStroke[] = [
      { key: '1', atMs: 0 },
      { key: '2', atMs: 60 },
      { key: '3', atMs: 120 }, // 距段首 120ms > 100
      { key: 'Enter', atMs: 125 },
    ];
    const event = parseWedgeSequence(strokes, options);
    expect(event).toMatchObject({ type: 'rejected', reason: 'burst-timeout' });
  });

  it('前缀偏离：立即拒绝（prefix-mismatch），不必等终结键', () => {
    const options: WedgeParserOptions = { prefix: 'AB' };
    const strokes: WedgeKeyStroke[] = [
      { key: 'X', atMs: 0 },
      { key: 'C', atMs: 5 },
    ];
    const event = parseWedgeSequence(strokes, options);
    expect(event).toMatchObject({ type: 'rejected', reason: 'prefix-mismatch' });
  });

  it('终结时后缀缺失/不符 → 拒绝（suffix-mismatch）', () => {
    const options: WedgeParserOptions = { suffix: '\r' };
    const event = parseWedgeSequence(burst('12345678'), options);
    expect(event).toMatchObject({ type: 'rejected', reason: 'suffix-mismatch' });
  });

  it('码值过短（含光杆回车）→ 拒绝（too-short）', () => {
    expect(parseWedgeSequence(burst('123'))).toMatchObject({ type: 'rejected', reason: 'too-short' });
    expect(parseWedgeSequence([{ key: 'Enter', atMs: 0 }])).toMatchObject({
      type: 'rejected',
      reason: 'too-short',
    });
  });

  it('控制字符 / 非数据键 → 拒绝（invalid-character）', () => {
    const withControl = parseWedgeSequence([
      { key: '1', atMs: 0 },
      { key: '\x1b', atMs: 5 },
    ]);
    expect(withControl).toMatchObject({ type: 'rejected', reason: 'invalid-character' });

    const withModifier = parseWedgeSequence([
      { key: '1', atMs: 0 },
      { key: 'Shift', atMs: 5 }, // 修饰键名不是数据键
    ]);
    expect(withModifier).toMatchObject({ type: 'rejected', reason: 'invalid-character' });
  });

  it('超长 → 拒绝（too-long）', () => {
    const options: WedgeParserOptions = { maxLength: 8 };
    expect(parseWedgeSequence(burst('123456789'), options)).toMatchObject({
      type: 'rejected',
      reason: 'too-long',
    });
  });

  it('批量语义：首个 accepted 胜出，忽略其后再入噪声', () => {
    const strokes = [...burst('12345678'), { key: 'x', atMs: 999 }, { key: 'Enter', atMs: 1000 }];
    const event = parseWedgeSequence(strokes);
    if (event.type === 'accepted') expect(event.code).toBe('12345678');
    else expect.unreachable(`expected accepted, got ${event.type}`);
  });

  it('无终态事件 → pending；空序列 → pending', () => {
    expect(parseWedgeSequence([{ key: '1', atMs: 0 }])).toMatchObject({ type: 'pending' });
    expect(parseWedgeSequence([])).toMatchObject({ type: 'pending' });
  });
});

describe('增量 reducer 状态机', () => {
  it('pending 状态逐步累积，accepted / rejected 后回到空闲', () => {
    const options: WedgeParserOptions = { minLength: 2 };
    const s1 = nextWedgeParserState(null, { key: 'A', atMs: 0 }, options);
    expect(s1.event.type).toBe('pending');
    expect(s1.state?.buffer).toEqual(['A']);
    const s2 = nextWedgeParserState(s1.state, { key: 'B', atMs: 5 }, options);
    expect(s2.event.type).toBe('pending');
    const s3 = nextWedgeParserState(s2.state, { key: 'Enter', atMs: 10 }, options);
    expect(s3.event.type).toBe('accepted');
    expect(s3.state).toBeNull();
    if (s3.event.type === 'accepted') expect(Object.isFrozen(s3.event)).toBe(true);

    const r1 = nextWedgeParserState(null, { key: '1', atMs: 0 }, options);
    const r2 = nextWedgeParserState(r1.state, { key: '2', atMs: 500 }, options);
    expect(r2.event.type).toBe('rejected');
    expect(r2.state).toBeNull();
  });

  it('状态对象冻结', () => {
    const s1 = nextWedgeParserState(null, { key: 'A', atMs: 0 });
    expect(Object.isFrozen(s1.state)).toBe(true);
    expect(Object.isFrozen(s1.state?.buffer)).toBe(true);
  });
});

describe('解析配置', () => {
  it('默认值与解析回填', () => {
    expect(DEFAULT_WEDGE_PARSER_OPTIONS.terminator).toBe('Enter');
    expect(DEFAULT_WEDGE_PARSER_OPTIONS.interKeyGapMs).toBe(50);
    expect(resolveWedgeParserOptions({ minLength: 6 })).toMatchObject({
      minLength: 6,
      maxLength: 2048,
    });
    expect(resolveWedgeParserOptions(undefined)).toEqual({ ...DEFAULT_WEDGE_PARSER_OPTIONS });
  });

  it('非法配置拒绝', () => {
    expect(() => resolveWedgeParserOptions({ terminator: '' })).toThrow(/terminator/);
    expect(() => resolveWedgeParserOptions({ minLength: 0 })).toThrow(/minLength/);
    expect(() => resolveWedgeParserOptions({ maxLength: 2, minLength: 4 })).toThrow(/maxLength/);
    expect(() => resolveWedgeParserOptions({ interKeyGapMs: -1 })).toThrow(/interKeyGapMs/);
  });
});
