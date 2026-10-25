/**
 * 夹具导出器单测——用**真实 testkit 件**实证衔接：导出文件过 loadFixtureFile
 * 校验，compareJson 按导出的策略比对（等价零 diff / 篡改可检出）。
 *
 * testkit 子模块取舍见 examples/run-reconcile-example.mjs 头注（不引
 * dist/index.js——其再导出的 baseline-fixtures 运行时依赖 @smes/application，
 * deploy 目录无法解析）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportDatasetFixtures } from '../src/fixture-export.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const TESTKIT_DIST = join(ROOT, 'packages', 'testkit', 'dist');

if (!existsSync(join(TESTKIT_DIST, 'comparator', 'comparator.js'))) {
  throw new Error(`缺 testkit 编译产物（先 pnpm --filter @smes/testkit build）：${TESTKIT_DIST}`);
}
const { compareJson } = await import(join(TESTKIT_DIST, 'comparator', 'comparator.js'));
const { loadFixtureFile } = await import(join(TESTKIT_DIST, 'fixtures', 'load.js'));

const ROWS = [
  { tenant: 't', code: 'B-1', name: '乙', id: 'uuid-b' },
  { tenant: 't', code: 'A-1', name: '甲', id: 'uuid-a' },
];

function exportTmp(rows = ROWS, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cadence-fixture-export-test-'));
  const file = exportDatasetFixtures({
    dir,
    dataset: 'items',
    rows,
    unorderedKey: 'code',
    generatedFields: ['id'],
    recordedAt: '2026-10-25T00:00:00.000Z',
    ...options,
  });
  return { dir, file, parsed: JSON.parse(readFileSync(file, 'utf8')) };
}

test('导出形状：format/场景/读回请求/无序键策略/代理键 shape 断言/按 key 排序', () => {
  const { file, parsed } = exportTmp();
  assert.equal(parsed.format, 'smes.reconcile-fixture@1');
  assert.equal(parsed.scenario.name, 'migration-items');
  assert.deepEqual(parsed.scenario.input, { method: 'GET', path: '/masterdata/items' });
  assert.deepEqual(parsed.compare.arrays, { items: { match: 'unordered', key: 'code' } });
  assert.deepEqual(parsed.compare.shape, { 'items[*].id': 'string' });
  // 输出按无序键排序（文件内容确定性）
  assert.deepEqual(parsed.reference.body.items.map((row) => row.code), ['A-1', 'B-1']);
  assert.equal(parsed.reference.status, 200);
  assert.equal(parsed.reference.recordedFrom, 'migration-export');
  // testkit 真实加载器校验通过（非法形状会抛 FixtureValidationError）
  const fixture = loadFixtureFile(file);
  assert.equal(fixture.scenarioName, 'migration-items');
  assert.equal(fixture.reference.body.items.length, 2);
});

test('真实 compareJson：期望（省略 id）× 导出行 → 零 diff（无序 + shape 断言语义）', () => {
  const expectedRows = [
    { tenant: 't', code: 'A-1', name: '甲' },
    { tenant: 't', code: 'B-1', name: '乙' },
  ];
  const { parsed } = exportTmp();
  const strategy = parsed.compare;
  const diffs = compareJson({ items: expectedRows }, parsed.reference.body, strategy);
  assert.deepEqual(diffs, []);
});

test('真实 compareJson：篡改/缺行/多余行/类型破坏均可检出（非空转比对）', () => {
  const { parsed } = exportTmp();
  const strategy = parsed.compare;
  const body = parsed.reference.body;
  // 值篡改
  const tampered = structuredClone(body);
  tampered.items[0].name = '篡改';
  assert.ok(compareJson(body, tampered, strategy).length > 0, '值篡改被检出');
  // 缺行（无序按 key 配对 → unmatched）
  const dropped = { items: body.items.slice(0, 1) };
  assert.ok(compareJson(body, dropped, strategy).some((d) => d.kind === 'unmatched'), '缺行被检出');
  // 多余行
  const extra = { items: [...body.items, { tenant: 't', code: 'C-1', name: '丙', id: 'u' }] };
  assert.ok(
    compareJson(body, extra, strategy).some((d) => d.kind === 'unexpected'),
    '多余行被检出',
  );
  // 目标生成字段类型破坏（id 非 string → shape 断言失败）
  const badId = structuredClone(body);
  badId.items[0].id = 12345;
  assert.ok(
    compareJson(body, badId, strategy).some((d) => d.kind === 'shape'),
    '代理键 shape 破坏被检出',
  );
});

test('导出校验：非对象行 / 嵌套值行 / 缺参 → 报错；ordered 模式不出 arrays 策略', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cadence-fixture-export-test-'));
  assert.throws(() => exportDatasetFixtures({ dir, dataset: 'items', rows: ['x'] }), /行必须是对象/);
  assert.throws(
    () => exportDatasetFixtures({ dir, dataset: 'items', rows: [{ a: { nested: true } }] }),
    /非标量/,
  );
  assert.throws(() => exportDatasetFixtures({ dir }), /dataset 必填/);
  const ordered = exportDatasetFixtures({ dir, dataset: 'items', rows: [{ code: 'A' }] });
  const parsed = JSON.parse(readFileSync(ordered, 'utf8'));
  assert.equal(parsed.compare.arrays, undefined);
  assert.deepEqual(parsed.compare, {});
});
