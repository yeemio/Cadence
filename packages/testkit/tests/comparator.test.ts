/** Comparator 全 diff 语义覆盖（缺失/多出/容差边界/忽略/无序数组/嵌套/时间戳/形状）。 */
import { describe, expect, it } from 'vitest';
import { compareJson } from '../src/comparator/comparator.js';
import { reconcileOutcome } from '../src/harness.js';
import {
  canonicalStringify,
  omitPaths,
  pathMatches,
  renderPath,
} from '../src/paths.js';

describe('compareJson 基础语义', () => {
  it('完全相等（含嵌套）→ 无 diff', () => {
    const value = { a: 1, b: 'x', c: [1, { d: true }, null] };
    expect(compareJson(value, { c: [1, { d: true }, null], b: 'x', a: 1 })).toEqual([]);
    // 键序不参与相等
  });

  it('缺失字段：期望有、实际缺', () => {
    const diffs = compareJson({ a: 1, b: 2 }, { a: 1 });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ kind: 'missing', path: 'b', expected: '2' });
  });

  it('多出字段：实际有、期望无', () => {
    const diffs = compareJson({ a: 1 }, { a: 1, extra: 'x' });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ kind: 'unexpected', path: 'extra', actual: '"x"' });
  });

  it('类型不同 → type diff（含 null）', () => {
    expect(compareJson({ v: 1 }, { v: '1' })[0]).toMatchObject({ kind: 'type', path: 'v' });
    expect(compareJson({ v: null }, { v: 1 })[0]).toMatchObject({ kind: 'type', path: 'v' });
    expect(compareJson([1], { 0: 1 })[0]).toMatchObject({ kind: 'type', path: '' });
  });

  it('值不同 → diff 精确到路径（a.b[2].c: 期望 5 实际 6）', () => {
    const expected = { a: { b: [1, 2, { c: 5 }] } };
    const actual = { a: { b: [1, 2, { c: 6 }] } };
    const diffs = compareJson(expected, actual);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ kind: 'value', path: 'a.b[2].c', expected: '5', actual: '6' });
  });

  it('布尔不同 → value diff', () => {
    expect(compareJson({ admin: true }, { admin: false })[0]).toMatchObject({
      kind: 'value',
      path: 'admin',
      expected: 'true',
      actual: 'false',
    });
  });
});

describe('数值容差', () => {
  it('相对容差：界内通过', () => {
    expect(
      compareJson({ n: 100 }, { n: 100.4 }, { tolerance: { numeric: { relative: 0.005 } } }),
    ).toEqual([]);
  });

  it('相对容差：界外失败并报 |Δ|', () => {
    const diffs = compareJson({ n: 100 }, { n: 100.6 }, { tolerance: { numeric: { relative: 0.005 } } });
    expect(diffs[0]).toMatchObject({ kind: 'tolerance', path: 'n', expected: '100', actual: '100.6' });
    expect(diffs[0]?.note).toContain('|Δ|=0.6');
  });

  it('绝对容差边界：|Δ| == absolute 恰好通过；略超失败', () => {
    expect(compareJson({ n: 10 }, { n: 10.25 }, { tolerance: { numeric: { absolute: 0.25 } } })).toEqual([]);
    expect(
      compareJson({ n: 10 }, { n: 10.26 }, { tolerance: { numeric: { absolute: 0.25 } } })[0],
    ).toMatchObject({ kind: 'tolerance' });
  });

  it('相对容差锚定期望值：期望 0 时相对容差退化为 0（等效无容差），需 absolute 兜底', () => {
    expect(compareJson({ n: 0 }, { n: 0.001 }, { tolerance: { numeric: { relative: 0.1 } } })[0]).toMatchObject({
      kind: 'value',
    });
    expect(compareJson({ n: 0 }, { n: 0.001 }, { tolerance: { numeric: { absolute: 0.01 } } })).toEqual([]);
  });
});

describe('忽略路径', () => {
  it('精确路径忽略（值不同也不比）', () => {
    expect(compareJson({ token: 'x', n: 1 }, { token: 'y', n: 1 }, { ignore: ['token'] })).toEqual([]);
  });

  it('忽略对类型差异同样生效', () => {
    expect(compareJson({ token: 'x' }, { token: 42 }, { ignore: ['token'] })).toEqual([]);
  });

  it('[*] 任意数组索引', () => {
    const expected = { items: [{ id: 1 }, { id: 2 }] };
    const actual = { items: [{ id: 9 }, { id: 2 }] };
    expect(compareJson(expected, actual, { ignore: ['items[*].id'] })).toEqual([]);
    expect(compareJson(expected, actual, { ignore: ['items[0].id'] })).toEqual([]); // 精确索引
    expect(compareJson(expected, actual, { ignore: ['items[1].id'] })).toHaveLength(1);
  });

  it('* 段内通配 与 ** 任意段', () => {
    expect(
      compareJson({ meta: { a: 1, b: 2 } }, { meta: { a: 9, b: 9 } }, { ignore: ['meta.*'] }),
    ).toEqual([]);
    expect(
      compareJson({ deep: { x: { y: { z: 1 } } } }, { deep: { x: { y: { z: 2 } } } }, {
        ignore: ['deep.**'],
      }),
    ).toEqual([]);
    expect(compareJson({ meta: { a: 1 } }, { meta: { a: 2 } }, { ignore: ['other.*'] })).toHaveLength(1);
  });
});

describe('形状断言（shape：只比形状不比值）', () => {
  it('参考已脱敏（缺字段）+ 实际有正确类型 → 通过', () => {
    expect(
      compareJson({ n: 1 }, { n: 1, token: 'random-value' }, { shape: { token: 'string' } }),
    ).toEqual([]);
  });

  it('类型不符 → shape diff', () => {
    const diffs = compareJson({ n: 1 }, { n: 1, token: 12345 }, { shape: { token: 'string' } });
    expect(diffs[0]).toMatchObject({ kind: 'shape', path: 'token', actual: '12345' });
    expect(diffs[0]?.note).toContain('string');
  });

  it('实际缺字段 → shape diff（缺字段）', () => {
    const diffs = compareJson({ n: 1 }, { n: 1 }, { shape: { expiresAt: 'string' } });
    expect(diffs[0]).toMatchObject({ kind: 'shape', path: 'expiresAt' });
    expect(diffs[0]?.note).toContain('缺字段');
  });

  it('number 声明兼容整数；integer 声明拒绝非整数', () => {
    expect(compareJson({}, { n: 5 }, { shape: { n: 'number' } })).toEqual([]);
    expect(compareJson({}, { n: 5 }, { shape: { n: 'integer' } })).toEqual([]);
    expect(compareJson({}, { n: 5.5 }, { shape: { n: 'integer' } })[0]).toMatchObject({
      kind: 'shape',
      path: 'n',
    });
  });

  it('数组元素形状模式 items[*].id（录制脱敏后参考元素保留、id 字段删除）', () => {
    expect(
      compareJson({ items: [{}, {}] }, { items: [{ id: 'a' }, { id: 'b' }] }, {
        shape: { 'items[*].id': 'string' },
      }),
    ).toEqual([]);
    const diffs = compareJson(
      { items: [{}, {}] },
      { items: [{ id: 'a' }, { id: 7 }] },
      { shape: { 'items[*].id': 'string' } },
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ kind: 'shape', path: 'items[1].id' });
  });

  it('两侧都缺 shape 声明的具体字段 → shape diff（存在性断言）', () => {
    const diffs = compareJson({ n: 1 }, { n: 1 }, { shape: { token: 'string', 'user.sid': 'string' } });
    expect(diffs.map((d) => d.path).sort()).toEqual(['token', 'user.sid']);
    expect(diffs.every((d) => d.kind === 'shape' && d.note?.includes('缺字段'))).toBe(true);
  });
});

describe('数组策略', () => {
  it('默认有序：顺序不同即 diff', () => {
    const diffs = compareJson([1, 2], [2, 1]);
    expect(diffs).toHaveLength(2);
    expect(diffs[0]).toMatchObject({ kind: 'value', path: '[0]' });
  });

  it('有序：长度差报 missing/unexpected', () => {
    expect(compareJson([1, 2], [1])[0]).toMatchObject({ kind: 'missing', path: '[1]' });
    expect(compareJson([1], [1, 2])[0]).toMatchObject({ kind: 'unexpected', path: '[1]' });
  });

  it('无序（无 key）：值多集合匹配', () => {
    const strategy = { arrays: { arr: { match: 'unordered' as const } } };
    expect(compareJson({ arr: [1, 2, 3] }, { arr: [3, 1, 2] }, strategy)).toEqual([]);
    const diffs = compareJson({ arr: [1, 2] }, { arr: [1, 2, 3] }, strategy);
    expect(diffs[0]).toMatchObject({ kind: 'unexpected', path: 'arr[?]' });
  });

  it('无序（无 key）：元素对象键序不同视为等值', () => {
    const strategy = { arrays: { arr: { match: 'unordered' as const } } };
    expect(
      compareJson({ arr: [{ a: 1, b: 2 }] }, { arr: [{ b: 2, a: 1 }] }, strategy),
    ).toEqual([]);
  });

  it('无序按 key 配对：顺序无关通过', () => {
    const strategy = {
      arrays: { bySource: { match: 'unordered' as const, key: 'source' } },
    };
    const expected = { bySource: [{ source: 'a', open: 3 }, { source: 'b', open: 1 }] };
    const actual = { bySource: [{ source: 'b', open: 1 }, { source: 'a', open: 3 }] };
    expect(compareJson(expected, actual, strategy)).toEqual([]);
  });

  it('无序按 key 配对：配对后字段差异精确到双向索引', () => {
    const strategy = {
      arrays: { bySource: { match: 'unordered' as const, key: 'source' } },
    };
    const expected = { bySource: [{ source: 'a', open: 3 }] };
    const actual = { bySource: [{ source: 'a', open: 4 }] };
    const diffs = compareJson(expected, actual, strategy);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ kind: 'value', path: 'bySource[0]→[0].open', expected: '3', actual: '4' });
  });

  it('无序按 key：期望侧 key 实际侧没有 → unmatched', () => {
    const strategy = {
      arrays: { bySource: { match: 'unordered' as const, key: 'source' } },
    };
    const diffs = compareJson(
      { bySource: [{ source: 'a' }, { source: 'c' }] },
      { bySource: [{ source: 'a' }] },
      strategy,
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ kind: 'unmatched', path: 'bySource[1]' });
  });

  it('无序按 key：实际侧多出 key → unexpected', () => {
    const strategy = {
      arrays: { bySource: { match: 'unordered' as const, key: 'source' } },
    };
    const diffs = compareJson(
      { bySource: [{ source: 'a' }] },
      { bySource: [{ source: 'a' }, { source: 'z' }] },
      strategy,
    );
    expect(diffs[0]).toMatchObject({ kind: 'unexpected', path: 'bySource[1]' });
  });

  it('无序按 key：重复 key 组内按出现顺序配对', () => {
    const strategy = {
      arrays: { xs: { match: 'unordered' as const, key: 'k' } },
    };
    const diffs = compareJson({ xs: [{ k: 'a', v: 1 }, { k: 'a', v: 2 }] }, { xs: [{ k: 'a', v: 2 }, { k: 'a', v: 1 }] }, strategy);
    expect(diffs).toHaveLength(2); // 组内两对各报 value diff（递归到字段）
    expect(diffs[0]).toMatchObject({ kind: 'value', path: 'xs[0]→[0].v', expected: '1', actual: '2' });
    expect(diffs[1]).toMatchObject({ kind: 'value', path: 'xs[1]→[1].v', expected: '2', actual: '1' });
  });
});

describe('时间戳归一（ISO 串按时刻差比较）', () => {
  it('时刻差在容差内 → 通过（跨格式 Z/+08:00 归一）', () => {
    const strategy = { timestamps: { toleranceMs: 60000 } };
    expect(
      compareJson({ at: '2026-10-25T08:00:00.000Z' }, { at: '2026-10-25T08:00:30.000Z' }, strategy),
    ).toEqual([]);
    expect(
      compareJson({ at: '2026-10-25T08:00:00.000Z' }, { at: '2026-10-25T16:00:00.000+08:00' }, strategy),
    ).toEqual([]);
  });

  it('容差 0：同一时刻不同表示通过；不同时刻失败', () => {
    expect(
      compareJson({ at: '2026-10-25T08:00:00.000Z' }, { at: '2026-10-25T16:00:00.000+08:00' }),
    ).toEqual([]);
    const diffs = compareJson({ at: '2026-10-25T08:00:00.000Z' }, { at: '2026-10-25T08:00:01.000Z' });
    expect(diffs[0]).toMatchObject({ kind: 'timestamp', path: 'at' });
    expect(diffs[0]?.note).toContain('1000ms');
  });

  it('非 ISO 字符串不走时间戳路径（普通 value diff）', () => {
    const diffs = compareJson({ name: 'abc' }, { name: 'abd' }, { timestamps: { toleranceMs: 99999 } });
    expect(diffs[0]).toMatchObject({ kind: 'value', path: 'name' });
  });
});

describe('reconcileOutcome（状态码 + 体）', () => {
  it('状态码不同 → status diff + 体贴格', () => {
    const diffs = reconcileOutcome(
      { status: 200, body: { ok: true } },
      { status: 500, body: { ok: true } },
      {},
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ kind: 'value', path: 'status', expected: '200', actual: '500' });
  });

  it('状态码同、体不同 → 体 diff', () => {
    const diffs = reconcileOutcome(
      { status: 200, body: { user: { openTotal: 1 } } },
      { status: 200, body: { user: { openTotal: 2 } } },
      {},
    );
    expect(diffs[0]).toMatchObject({ kind: 'value', path: 'user.openTotal', expected: '1', actual: '2' });
  });
});

describe('路径工具', () => {
  it('renderPath', () => {
    expect(renderPath([])).toBe('');
    expect(renderPath(['a'])).toBe('a');
    expect(renderPath(['a', 'b', 2, 'c'])).toBe('a.b[2].c');
  });

  it('pathMatches 语义子集', () => {
    expect(pathMatches('a.b[2].c', 'a.b[2].c')).toBe(true);
    expect(pathMatches('a.b[2].c', 'a.b[*].c')).toBe(true);
    expect(pathMatches('a.b[2].c', 'a.*.c')).toBe(true); // '*' 段内通配（不含 '.'，可含索引）
    expect(pathMatches('a.b.c', 'a.*.c')).toBe(true);
    expect(pathMatches('a.b.c.d', 'a.**')).toBe(true);
    expect(pathMatches('a.b', 'a')).toBe(false);
    expect(pathMatches('a.b.c', 'a.*')).toBe(false); // '*' 不跨 '.' 段
  });

  it('canonicalStringify 键序无关', () => {
    expect(canonicalStringify({ a: 1, b: { x: 1, y: 2 } })).toBe(
      canonicalStringify({ b: { y: 2, x: 1 }, a: 1 }),
    );
  });

  it('omitPaths 删除命中路径（录制脱敏）', () => {
    const body = { token: 'secret', expiresAt: '2026-10-25T00:00:00Z', user: { id: 'u1', sid: 's1' } };
    const redacted = omitPaths(body, ['token', 'expiresAt', 'user.sid']);
    expect(redacted).toEqual({ user: { id: 'u1' } });
    expect(body).toEqual({ token: 'secret', expiresAt: '2026-10-25T00:00:00Z', user: { id: 'u1', sid: 's1' } });
  });
});
