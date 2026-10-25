/** Harness 全流程（mock target）：pass 场景、fail 场景的 diff 报告断言、异常与过滤。 */
import { describe, expect, it } from 'vitest';
import { StaticFixtureSource } from '../src/adapters/static-fixture-source.js';
import { ReconcileHarness } from '../src/harness.js';
import { formatTextReport } from '../src/report.js';
import type { ReconcileFixture, TargetAdapter, TargetRequest, TargetResponse } from '../src/types.js';

function fixture(overrides: {
  name: string;
  reference: { status: number; body: unknown } | null;
  strategy?: ReconcileFixture['strategy'];
}): ReconcileFixture {
  return {
    file: `/tmp/${overrides.name}.reconcile.json`,
    scenarioName: overrides.name,
    input: { method: 'GET', path: `/${overrides.name}` },
    reference: overrides.reference,
    strategy: overrides.strategy ?? {},
    recordedAt: overrides.reference === null ? null : '2026-10-25T00:00:00.000Z',
    recordedFrom: null,
  };
}

function mockTarget(
  handler: (request: TargetRequest) => TargetResponse | Promise<TargetResponse> | Error,
): TargetAdapter {
  return {
    name: 'mock',
    async invoke(request: TargetRequest): Promise<TargetResponse> {
      const result = handler(request);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  };
}

describe('ReconcileHarness', () => {
  it('pass 场景：同输入同输出 → 通过', async () => {
    const reference = { status: 200, body: { user: 'u1', openTotal: 0, bySource: [] } };
    const harness = new ReconcileHarness({
      target: mockTarget(() => ({ status: 200, body: { user: 'u1', openTotal: 0, bySource: [] } })),
      reference: new StaticFixtureSource([fixture({ name: 'summary', reference })]),
      fixtures: [fixture({ name: 'summary', reference })],
    });
    const report = await harness.run();
    expect(report.passedCount).toBe(1);
    expect(report.failedCount).toBe(0);
    expect(report.results[0]?.passed).toBe(true);
    expect(report.results[0]?.diffs).toEqual([]);
    expect(report.results[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('fail 场景：状态码 + 字段 diff 逐条报告', async () => {
    const reference = { status: 200, body: { user: { openTotal: 1 }, items: [1, 2] } };
    const harness = new ReconcileHarness({
      target: mockTarget(() => ({ status: 500, body: { user: { openTotal: 2 }, items: [1] } })),
      reference: new StaticFixtureSource([fixture({ name: 's', reference })]),
      fixtures: [fixture({ name: 's', reference })],
    });
    const report = await harness.run();
    expect(report.failedCount).toBe(1);
    const diffs = report.results[0]?.diffs ?? [];
    expect(diffs[0]).toMatchObject({ kind: 'value', path: 'status', expected: '200', actual: '500' });
    expect(diffs.some((d) => d.kind === 'value' && d.path === 'user.openTotal' && d.expected === '1' && d.actual === '2')).toBe(true);
    expect(diffs.some((d) => d.kind === 'missing' && d.path === 'items[1]')).toBe(true);
    // 文本报告：FAIL 行 + diff 明细行 + 汇总行
    const text = formatTextReport(report);
    expect(text).toContain('FAIL s');
    expect(text).toContain('user.openTotal: 期望 1 实际 2');
    expect(text).toContain('items[1]: 期望 2');
    expect(text).toContain('对账汇总：1 场景 · 0 通过 · 1 失败');
  });

  it('容差策略经由 Harness 生效（界内通过）', async () => {
    const reference = { status: 200, body: { n: 100 } };
    const strategy = { tolerance: { numeric: { relative: 0.01 } } };
    const harness = new ReconcileHarness({
      target: mockTarget(() => ({ status: 200, body: { n: 100.5 } })),
      reference: new StaticFixtureSource([fixture({ name: 'tol', reference, strategy })]),
      fixtures: [fixture({ name: 'tol', reference, strategy })],
    });
    const report = await harness.run();
    expect(report.passedCount).toBe(1);
  });

  it('目标调用异常 → 场景失败带错误信息，不中断其余场景', async () => {
    const okReference = { status: 200, body: { ok: true } };
    const boomReference = { status: 200, body: { ok: true } };
    const harness = new ReconcileHarness({
      target: mockTarget((request) =>
        request.path === '/boom' ? new Error('connect ECONNREFUSED 127.0.0.1:3000') : { status: 200, body: { ok: true } },
      ),
      reference: new StaticFixtureSource([
        fixture({ name: 'boom', reference: boomReference }),
        fixture({ name: 'ok', reference: okReference }),
      ]),
      fixtures: [
        fixture({ name: 'boom', reference: boomReference }),
        fixture({ name: 'ok', reference: okReference }),
      ],
    });
    const report = await harness.run();
    expect(report.passedCount).toBe(1);
    expect(report.failedCount).toBe(1);
    const failed = report.results.find((r) => !r.passed);
    expect(failed?.error).toContain('目标不可达');
    expect(formatTextReport(report)).toContain('目标调用失败');
  });

  it('参考未录制（reference: null）→ fail 并提示先录制', async () => {
    const harness = new ReconcileHarness({
      target: mockTarget(() => ({ status: 200, body: {} })),
      reference: new StaticFixtureSource([fixture({ name: 'pending', reference: null })]),
      fixtures: [fixture({ name: 'pending', reference: null })],
    });
    const report = await harness.run();
    expect(report.failedCount).toBe(1);
    expect(report.results[0]?.diffs[0]?.note).toContain('参考未录制');
    expect(formatTextReport(report)).toContain('参考未录制');
  });

  it('filter 子串只跑命中场景', async () => {
    const reference = { status: 200, body: { ok: true } };
    const harness = new ReconcileHarness({
      target: mockTarget(() => ({ status: 404, body: {} })), // 未命中场景不会跑，不会失败
      reference: new StaticFixtureSource([
        fixture({ name: 'health', reference }),
        fixture({ name: 'auth-login', reference: { status: 200, body: { ok: true } } }),
      ]),
      fixtures: [fixture({ name: 'health', reference }), fixture({ name: 'auth-login', reference })],
    });
    const report = await harness.run('health');
    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.name).toBe('health');
  });
});
