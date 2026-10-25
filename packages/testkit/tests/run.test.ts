/** reconcile CLI 核心流程：--filter 空命中 fail-fast（对称 record CLI 的防护，防假绿）。 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { main, runReconcile } from '../src/cli/run.js';
import { FixtureValidationError } from '../src/fixtures/load.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'testkit-run-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeFixture(dir: string, name: string): string {
  const file = join(dir, `${name}.reconcile.json`);
  writeFileSync(
    file,
    JSON.stringify({
      format: 'smes.reconcile-fixture@1',
      scenario: { name, input: { method: 'GET', path: `/${name}` } },
      reference: { status: 200, body: { ok: true }, recordedAt: '2026-10-25T00:00:00.000Z' },
    }),
  );
  return file;
}

describe('reconcile CLI：--filter 空命中防护', () => {
  it('空命中 → FixtureValidationError（在目标调用之前抛出，不发起网络请求）', async () => {
    const dir = tempDir();
    writeFixture(dir, 'health');
    // baseUrl 指向不可达端口：若防护失效会走 fetch（慢且不可控），防护生效则抛错
    await expect(
      runReconcile({ fixturesDir: dir, baseUrl: 'http://127.0.0.1:1', filter: 'no-such-scenario' }),
    ).rejects.toThrow(FixtureValidationError);
    await expect(
      runReconcile({ fixturesDir: dir, baseUrl: 'http://127.0.0.1:1', filter: 'no-such-scenario' }),
    ).rejects.toThrow(/未命中任何场景/);
  });

  it('main 空命中退出码非零（走夹具加载失败通道，返回 2）', async () => {
    const dir = tempDir();
    writeFixture(dir, 'health');
    const code = await main(['--fixtures-dir', dir, '--filter', 'no-such-scenario']);
    expect(code).toBe(2);
  });
});
