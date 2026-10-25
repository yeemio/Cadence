/** 夹具加载与格式校验（fail-fast）：坏夹具绝不进入对账运行。 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { FixtureValidationError, loadFixtureDir, loadFixtureFile } from '../src/fixtures/load.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'testkit-fixtures-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const VALID_FIXTURE = {
  format: 'smes.reconcile-fixture@1',
  scenario: {
    name: 'demo',
    description: '演示',
    input: { method: 'GET', path: '/demo', query: { k: 'v' }, headers: { 'x-a': 'b' } },
  },
  reference: { status: 200, body: { ok: true }, recordedAt: '2026-10-25T00:00:00.000Z', recordedFrom: 'http://x' },
  compare: { ignore: ['a.b[*].c'], shape: { token: 'string' }, arrays: { xs: { match: 'unordered', key: 'k' } }, timestamps: { toleranceMs: 5 }, tolerance: { numeric: { relative: 0.1, absolute: 1 } } },
};

describe('夹具校验（fail-fast）', () => {
  it('合法夹具完整加载', () => {
    const dir = tempDir();
    const file = join(dir, 'demo.reconcile.json');
    writeFileSync(file, JSON.stringify(VALID_FIXTURE));
    const fixture = loadFixtureFile(file);
    expect(fixture.scenarioName).toBe('demo');
    expect(fixture.description).toBe('演示');
    expect(fixture.input.method).toBe('GET');
    expect(fixture.input.query).toEqual({ k: 'v' });
    expect(fixture.reference).toEqual({ status: 200, body: { ok: true } });
    expect(fixture.recordedAt).toBe('2026-10-25T00:00:00.000Z');
    expect(fixture.strategy.arrays?.['xs']).toEqual({ match: 'unordered', key: 'k' });
  });

  it('reference: null = 待录制', () => {
    const dir = tempDir();
    const file = join(dir, 'pending.reconcile.json');
    writeFileSync(
      file,
      JSON.stringify({ format: 'smes.reconcile-fixture@1', scenario: { name: 'pending', input: { method: 'GET', path: '/p' } }, reference: null }),
    );
    const fixture = loadFixtureFile(file);
    expect(fixture.reference).toBeNull();
    expect(fixture.recordedAt).toBeNull();
  });

  const badCases: readonly [string, unknown][] = [
    ['非法 JSON', '{oops'],
    ['format 版本不符', { ...VALID_FIXTURE, format: 'smes.reconcile-fixture@0' }],
    ['根级未知键', { ...VALID_FIXTURE, extra: 1 }],
    ['scenario 缺 name', { ...VALID_FIXTURE, scenario: { input: VALID_FIXTURE.scenario.input } }],
    ['method 小写非法', { ...VALID_FIXTURE, scenario: { ...VALID_FIXTURE.scenario, input: { method: 'get', path: '/d' } } }],
    ['path 不以 / 开头', { ...VALID_FIXTURE, scenario: { ...VALID_FIXTURE.scenario, input: { method: 'GET', path: 'health' } } }],
    ['path 以 // 开头（协议相对转向）', { ...VALID_FIXTURE, scenario: { ...VALID_FIXTURE.scenario, input: { method: 'GET', path: '//evil.example/leak' } } }],
    ['recordedAt 垃圾串', { ...VALID_FIXTURE, reference: { ...VALID_FIXTURE.reference, recordedAt: 'yesterday-ish' } }],
    ['recordedAt 非 ISO 形状（宽松日期串）', { ...VALID_FIXTURE, reference: { ...VALID_FIXTURE.reference, recordedAt: 'October 25, 2026' } }],
    ['recordedAt 仅日期无时间', { ...VALID_FIXTURE, reference: { ...VALID_FIXTURE.reference, recordedAt: '2026-10-25' } }],
    ['recordedAt ISO 形状但日期越界', { ...VALID_FIXTURE, reference: { ...VALID_FIXTURE.reference, recordedAt: '2026-13-45T99:99:99.000Z' } }],
    ['reference.status 越界', { ...VALID_FIXTURE, reference: { status: 600, body: null } }],
    ['ignore 含非字符串', { ...VALID_FIXTURE, compare: { ignore: ['ok', 3] } }],
    ['shape 类型名非法', { ...VALID_FIXTURE, compare: { shape: { token: 'str' } } }],
    ['arrays.match 非法', { ...VALID_FIXTURE, compare: { arrays: { xs: { match: 'sorted' } } } }],
    ['容差为负', { ...VALID_FIXTURE, compare: { tolerance: { numeric: { relative: -1 } } } }],
    ['input 未知键', { ...VALID_FIXTURE, scenario: { ...VALID_FIXTURE.scenario, input: { ...VALID_FIXTURE.scenario.input, retry: true } } }],
  ];

  for (const [label, raw] of badCases) {
    it(`坏夹具 fail-fast：${label}`, () => {
      const dir = tempDir();
      const file = join(dir, 'bad.reconcile.json');
      writeFileSync(file, typeof raw === 'string' ? raw : JSON.stringify(raw));
      expect(() => loadFixtureFile(file)).toThrow(FixtureValidationError);
    });
  }

  it('错误信息含文件路径与原因', () => {
    const dir = tempDir();
    const file = join(dir, 'bad.reconcile.json');
    writeFileSync(file, JSON.stringify({ ...VALID_FIXTURE, format: 'wrong-format' }));
    try {
      loadFixtureFile(file);
      expect.unreachable('应抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(FixtureValidationError);
      const message = (error as FixtureValidationError).message;
      expect(message).toContain(file);
      expect(message).toContain('format 必须是');
    }
  });

  it('recordedAt 垃圾串：错误信息含文件路径（max-age 门禁前置防护）', () => {
    const dir = tempDir();
    const file = join(dir, 'stale-guard.reconcile.json');
    writeFileSync(file, JSON.stringify({ ...VALID_FIXTURE, reference: { ...VALID_FIXTURE.reference, recordedAt: 'garbage' } }));
    try {
      loadFixtureFile(file);
      expect.unreachable('应抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(FixtureValidationError);
      const message = (error as FixtureValidationError).message;
      expect(message).toContain(file);
      expect(message).toContain('ISO 8601');
      expect(message).toContain('garbage');
    }
  });

  it('path 以 // 开头：错误信息含文件路径与转向提示', () => {
    const dir = tempDir();
    const file = join(dir, 'proto-relative.reconcile.json');
    writeFileSync(
      file,
      JSON.stringify({ ...VALID_FIXTURE, scenario: { ...VALID_FIXTURE.scenario, input: { method: 'GET', path: '//evil.example/leak' } } }),
    );
    try {
      loadFixtureFile(file);
      expect.unreachable('应抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(FixtureValidationError);
      const message = (error as FixtureValidationError).message;
      expect(message).toContain(file);
      expect(message).toContain("不得以 '//' 开头");
      expect(message).toContain('//evil.example/leak');
    }
  });

  it('recordedAt 带时区偏移（+08:00）合法——严格但不僵化', () => {
    const dir = tempDir();
    const file = join(dir, 'offset.reconcile.json');
    writeFileSync(file, JSON.stringify({ ...VALID_FIXTURE, reference: { ...VALID_FIXTURE.reference, recordedAt: '2026-10-25T08:00:00+08:00' } }));
    const fixture = loadFixtureFile(file);
    expect(fixture.recordedAt).toBe('2026-10-25T08:00:00+08:00');
  });

  it('目录内场景重名 fail-fast', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'a.reconcile.json'),
      JSON.stringify({ format: 'smes.reconcile-fixture@1', scenario: { name: 'dup', input: { method: 'GET', path: '/a' } }, reference: null }),
    );
    writeFileSync(
      join(dir, 'b.reconcile.json'),
      JSON.stringify({ format: 'smes.reconcile-fixture@1', scenario: { name: 'dup', input: { method: 'GET', path: '/b' } }, reference: null }),
    );
    expect(() => loadFixtureDir(dir)).toThrow(/重复/);
  });

  it('空目录（无夹具文件）fail-fast', () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    expect(() => loadFixtureDir(dir)).toThrow(/无 .*夹具文件/);
  });

  it('非夹具后缀文件被忽略', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(
      join(dir, 'good.reconcile.json'),
      JSON.stringify({ format: 'smes.reconcile-fixture@1', scenario: { name: 'good', input: { method: 'GET', path: '/g' } }, reference: null }),
    );
    const fixtures = loadFixtureDir(dir);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]?.scenarioName).toBe('good');
  });
});

describe('随包示例夹具', () => {
  it('fixtures/ 三个示例夹具全部合法且场景名唯一', () => {
    const dir = fileURLToPath(new URL('../fixtures', import.meta.url));
    const fixtures = loadFixtureDir(dir);
    expect(fixtures.map((f) => f.scenarioName).sort()).toEqual(['auth-login', 'health', 'workbench-summary']);
    // 每个夹具的 input 形状完整（方法/路径）
    for (const fixture of fixtures) {
      expect(fixture.input.path.startsWith('/')).toBe(true);
    }
  });
});
