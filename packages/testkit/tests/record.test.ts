/** 录制核心：mock target 录制 → 写回夹具（脱敏 / 时间戳 / 来源 / 策略保留 / 失败收集）。 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadFixtureFile } from '../src/fixtures/load.js';
import { recordFixtures } from '../src/record.js';
import type { TargetAdapter, TargetResponse } from '../src/types.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'testkit-record-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function mockTarget(responses: Record<string, TargetResponse | Error>): TargetAdapter {
  return {
    name: 'http://mock-test',
    async invoke(request) {
      const result = responses[request.path];
      if (result === undefined) {
        return { status: 404, body: { error: 'no mock' } };
      }
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  };
}

function writePendingFixture(
  dir: string,
  name: string,
  path: string,
  compare: Record<string, unknown>,
): string {
  const file = join(dir, `${name}.reconcile.json`);
  writeFileSync(
    file,
    JSON.stringify({
      format: 'smes.reconcile-fixture@1',
      scenario: { name, description: `${name} 演示`, input: { method: 'GET', path } },
      reference: null,
      compare,
    }),
  );
  return file;
}

describe('recordFixtures', () => {
  it('录制真实响应写回 reference：状态/体/时间戳/来源，compare 保留', async () => {
    const dir = tempDir();
    const file = writePendingFixture(dir, 'demo', '/demo', { ignore: ['token'], shape: { expiresAt: 'string' } });
    const fixtures = [loadFixtureFile(file)];
    const results = await recordFixtures({
      fixtures,
      target: mockTarget({
        '/demo': { status: 200, body: { token: 'rand-abc', expiresAt: '2026-10-25T00:00:00.000Z', user: { id: 'u1' } } },
      }),
      now: () => '2026-10-25T12:00:00.000Z',
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.error).toBeUndefined();
    expect(results[0]?.status).toBe(200);

    const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
    expect(written['format']).toBe('smes.reconcile-fixture@1');
    expect(written['scenario']).toEqual({
      name: 'demo',
      description: 'demo 演示',
      input: { method: 'GET', path: '/demo' },
    });
    // 脱敏：ignore + shape 命中路径从写入体删除（随机值/敏感值不落仓）
    expect(written['reference']['body']).toEqual({ user: { id: 'u1' } });
    expect(written['reference']['status']).toBe(200);
    expect(written['reference']['recordedAt']).toBe('2026-10-25T12:00:00.000Z');
    expect(written['reference']['recordedFrom']).toBe('http://mock-test');
    // compare 策略块原样保留（录制不猜策略）
    expect(written['compare']).toEqual({ ignore: ['token'], shape: { expiresAt: 'string' } });
    // 写回后可再加载（round-trip 合法）
    const reloaded = loadFixtureFile(file);
    expect(reloaded.recordedAt).toBe('2026-10-25T12:00:00.000Z');
    expect(reloaded.reference?.body).toEqual({ user: { id: 'u1' } });
  });

  it('--keep-values：不脱敏，参考保留完整值', async () => {
    const dir = tempDir();
    const file = writePendingFixture(dir, 'keep', '/keep', { ignore: ['token'] });
    const results = await recordFixtures({
      fixtures: [loadFixtureFile(file)],
      target: mockTarget({ '/keep': { status: 200, body: { token: 'rand', n: 1 } } }),
      keepValues: true,
      now: () => '2026-10-25T12:00:00.000Z',
    });
    expect(results[0]?.error).toBeUndefined();
    const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
    expect(written['reference']['body']).toEqual({ token: 'rand', n: 1 });
  });

  it('目标失败 → 该夹具记失败（error），不影响退出语义判定', async () => {
    const dir = tempDir();
    const file = writePendingFixture(dir, 'boom', '/boom', {});
    const results = await recordFixtures({
      fixtures: [loadFixtureFile(file)],
      target: mockTarget({ '/boom': new Error('socket hang up') }),
    });
    expect(results[0]?.error).toContain('socket hang up');
    expect(results.some((r) => r.error !== undefined)).toBe(true);
  });

  it('无 compare 策略的夹具写回时省略 compare 块', async () => {
    const dir = tempDir();
    const file = writePendingFixture(dir, 'bare', '/bare', {});
    await recordFixtures({
      fixtures: [loadFixtureFile(file)],
      target: mockTarget({ '/bare': { status: 204, body: '' } }),
      now: () => '2026-10-25T12:00:00.000Z',
    });
    const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect('compare' in written).toBe(false);
    expect(written['reference']).toEqual({ status: 204, body: '', recordedAt: '2026-10-25T12:00:00.000Z', recordedFrom: 'http://mock-test' });
  });
});
