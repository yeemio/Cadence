import { describe, expect, it } from 'vitest';
import { createInMemoryMetricSource, type MetricSourceRow } from '../src/index.js';

const rows: MetricSourceRow[] = [
  { occurredAt: '2026-10-01T08:00:00Z', businessTime: '2026-09-30T09:00:00Z', availableTime: '2026-10-02T00:00:00Z', personId: 'p1', hours: 8 },
  { occurredAt: '2026-10-05T08:00:00Z', businessTime: '2026-10-05T09:00:00Z', availableTime: '2026-10-06T00:00:00Z', personId: 'p2', hours: 6 },
  { occurredAt: '2026-11-01T08:00:00Z', personId: 'p3', hours: 7 }, // 无 businessTime/availableTime
];

describe('createInMemoryMetricSource', () => {
  it('构造即冻结全部行；外部可变输入不再影响源', async () => {
    const input: MetricSourceRow[] = [{ occurredAt: '2026-10-01T00:00:00Z', nested: { a: 1 }, hours: 1 }];
    const source = createInMemoryMetricSource('labor-entries', input);
    (input[0] as unknown as Record<string, unknown>).hours = 999;
    const out = await source.read({ sourceKind: 'labor-entries', timeBasis: 'occurred' });
    expect(out[0]?.hours).toBe(1);
    expect(Object.isFrozen(out[0])).toBe(true);
    expect(Object.isFrozen((out[0] as unknown as Record<string, unknown>).nested)).toBe(true);
  });

  it('源种类绑定：不匹配即抛', async () => {
    const source = createInMemoryMetricSource('labor-entries', rows);
    await expect(
      source.read({ sourceKind: 'work-reports', timeBasis: 'occurred' }),
    ).rejects.toThrow(/unknown sourceKind/);
  });

  it('时间口径三态 + 回落：按所选列过滤时间窗', async () => {
    const source = createInMemoryMetricSource('labor-entries', rows);
    // occurred 口径：10 月两行（p1/p2），11 月一行
    const byOccurred = await source.read({ sourceKind: 'labor-entries', timeBasis: 'occurred', from: '2026-10-01T00:00:00Z', to: '2026-10-31T23:59:59Z' });
    expect(byOccurred.map((r) => r.personId)).toEqual(['p1', 'p2']);
    // business 口径：p1 的 businessTime 落在 9 月底 → 同窗口只剩 p2（p3 无 businessTime 回落 occurredAt=11 月）
    const byBusiness = await source.read({ sourceKind: 'labor-entries', timeBasis: 'business', from: '2026-10-01T00:00:00Z', to: '2026-10-31T23:59:59Z' });
    expect(byBusiness.map((r) => r.personId)).toEqual(['p2']);
    // available 口径：p1 available=10/02、p2 available=10/06 均在窗内
    const byAvailable = await source.read({ sourceKind: 'labor-entries', timeBasis: 'available', from: '2026-10-01T00:00:00Z', to: '2026-10-31T23:59:59Z' });
    expect(byAvailable.map((r) => r.personId)).toEqual(['p1', 'p2']);
    // 无窗口：全量
    const all = await source.read({ sourceKind: 'labor-entries', timeBasis: 'occurred' });
    expect(all.length).toBe(3);
  });

  it('过滤下推：谓词在源侧生效', async () => {
    const source = createInMemoryMetricSource('labor-entries', rows);
    const out = await source.read({
      sourceKind: 'labor-entries',
      timeBasis: 'occurred',
      filter: { kind: 'compare', op: 'gte', field: 'hours', value: 7 },
    });
    expect(out.map((r) => r.personId)).toEqual(['p1', 'p3']);
  });

  it('非法请求 fail-fast：非法口径/非法 ISO/非法谓词', async () => {
    const source = createInMemoryMetricSource('labor-entries', rows);
    // 非法值经 unknown 注入：模拟不受信数据到达端口（类型层拦截在先，运行时校验兜底）
    const badBasis = { sourceKind: 'labor-entries', timeBasis: 'calendar' } as unknown as Parameters<
      typeof source.read
    >[0];
    await expect(source.read(badBasis)).rejects.toThrow(/timeBasis/);
    await expect(
      source.read({ sourceKind: 'labor-entries', timeBasis: 'occurred', from: 'not-a-date' }),
    ).rejects.toThrow(/from/);
    const badFilter = {
      sourceKind: 'labor-entries',
      timeBasis: 'occurred',
      filter: { kind: 'xor' },
    } as unknown as Parameters<typeof source.read>[0];
    await expect(source.read(badFilter)).rejects.toThrow(/filter kind/);
  });
});
