#!/usr/bin/env node
/**
 * 迁移后对账衔接示例（Done-when #5 全流程，一条命令跑通）：
 *
 *   CSV/JSONL 源 → 映射引擎 → memory target（代理键模拟）→ 导出 testkit 夹具
 *   → ReconcileHarness（真实 testkit 件）与源侧期望深度比对 → PASS
 *
 * 源侧期望 = examples/expected/*.expected.json（迁移应达成的目标状态，
 * 含 upsert 期望态覆盖语义——ITM-003 重复行取末次）。
 *
 * testkit 接线取舍：import 编译产物子模块
 *   packages/testkit/dist/{harness,adapters/static-fixture-source,fixtures/load}.js
 * 而非 dist/index.js——index 再导出 baseline-fixtures（运行时依赖
 * @smes/application，deploy 目录不在 pnpm workspace、无法解析）；上述三个
 * 子模块零外部依赖。需先 `pnpm --filter @smes/testkit build`（缺产物时报错指引）。
 * 接入期把 TargetAdapter 换成 testkit 的 NodeFetchTargetAdapter 指向真实
 * server（GET /masterdata/<dataset>）即比对活系统，比对面不变。
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const TESTKIT_DIST = join(ROOT, 'packages', 'testkit', 'dist');
const REQUIRED_TESTKIT_FILES = [
  join(TESTKIT_DIST, 'harness.js'),
  join(TESTKIT_DIST, 'adapters', 'static-fixture-source.js'),
  join(TESTKIT_DIST, 'fixtures', 'load.js'),
];

for (const file of REQUIRED_TESTKIT_FILES) {
  if (!existsSync(file)) {
    console.error(`缺 testkit 编译产物：${file}\n先运行：pnpm --filter @smes/testkit build`);
    process.exit(2);
  }
}

const { ReconcileHarness } = await import(join(TESTKIT_DIST, 'harness.js'));
const { StaticFixtureSource } = await import(
  join(TESTKIT_DIST, 'adapters', 'static-fixture-source.js')
);
const { loadFixtureDir } = await import(join(TESTKIT_DIST, 'fixtures', 'load.js'));

const { DirectoryMigrationSource } = await import('../src/source-descriptor.mjs');
const { loadMappingFile } = await import('../src/mapping-engine.mjs');
const { InMemoryTarget } = await import('../src/memory-target.mjs');
const { runMigration } = await import('../src/pipeline.mjs');
const { renderTextReport } = await import('../src/report.mjs');
const { exportDatasetFixtures } = await import('../src/fixture-export.mjs');

let failures = 0;
const pass = (message) => console.log(`PASS: ${message}`);
const fail = (message) => {
  failures += 1;
  console.error(`FAIL: ${message}`);
};
const assert = (condition, message) => (condition ? pass(message) : fail(message));

/** 读回已导出夹具的目标适配器（invoke = 解析导出件的 reference.body）。 */
function exportedFixtureTargetAdapter(actualDir) {
  return {
    name: `exported-fixtures:${actualDir}`,
    async invoke(request) {
      const dataset = request.path.split('/').filter(Boolean).pop();
      const file = join(actualDir, `${dataset}.reconcile.json`);
      if (!existsSync(file)) {
        return { status: 404, body: { error: `未导出 dataset '${dataset}'` } };
      }
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return { status: 200, body: parsed.reference.body };
    },
  };
}

async function main() {
  const sourceDir = join(HERE, 'source');
  const expectedDir = join(HERE, 'expected');
  const work = mkdtempSync(join(tmpdir(), 'cadence-migration-reconcile-'));
  const expectedFixtureDir = join(work, 'expected-fixtures');
  const actualFixtureDir = join(work, 'actual-fixtures');
  console.log(`[示例] 工作目录：${work}`);

  // 1) 迁移：源 → 映射 → memory target（带代理键模拟：id = uuid，更新保留）
  const target = new InMemoryTarget({ idField: 'id' });
  const report = await runMigration({
    source: new DirectoryMigrationSource(sourceDir),
    mapping: loadMappingFile(join(sourceDir, 'mapping.json')),
    target,
    mode: 'report',
  });
  console.log(renderTextReport(report));
  assert(report.totals.rowsFailed === 0, `迁移零行失败（成功 ${report.totals.rowsOk}/${report.totals.rowsRead}）`);
  assert(
    report.totals.rowsRead === 20 && report.totals.inserted === 19 && report.totals.updated === 1,
    `upsert 语义：读取 20 行 → inserted=19 updated=1（ITM-003 重复键期望态覆盖）`,
  );
  if (failures > 0) return 1;

  // 2) 两侧导出为 testkit 夹具（同一导出器 → 格式一致）
  for (const name of ['items', 'resources']) {
    const expected = JSON.parse(readFileSync(join(expectedDir, `${name}.expected.json`), 'utf8'));
    const expectedFile = exportDatasetFixtures({
      dir: expectedFixtureDir,
      dataset: name,
      rows: expected.rows,
      unorderedKey: 'code',
      generatedFields: ['id'],
      recordedFrom: 'source-expectation',
      description: `源侧期望：${name} 迁移后目标状态`,
    });
    const rows = await target.snapshot(name);
    const actualFile = exportDatasetFixtures({
      dir: actualFixtureDir,
      dataset: name,
      rows,
      unorderedKey: 'code',
      generatedFields: ['id'],
      recordedFrom: 'memory-target',
    });
    console.log(`[示例] 夹具：期望 ${expectedFile}；实际 ${actualFile}（${rows.length} 行）`);
    const actual = rows;
    assert(
      actual.every((row) => typeof row.id === 'string' && row.id.length > 0),
      `${name}：memory target 生成代理键 id（目标侧生成字段的形状面）`,
    );
  }

  // 3) ReconcileHarness：期望夹具 × 导出目标数据 深度比对（无序按 code 配对，
  //    id 走 shape 断言——期望侧省略目标生成字段）
  const fixtures = loadFixtureDir(expectedFixtureDir);
  const harness = new ReconcileHarness({
    target: exportedFixtureTargetAdapter(actualFixtureDir),
    reference: new StaticFixtureSource(fixtures),
    fixtures,
  });
  const result = await harness.run();
  for (const scenario of result.results) {
    if (scenario.passed) {
      pass(`对账场景 ${scenario.name}：零 diff（${scenario.durationMs}ms）`);
    } else {
      fail(
        `对账场景 ${scenario.name}：${scenario.diffs.length} 处 diff` +
          (scenario.error ? `；调用错误 ${scenario.error}` : ''),
      );
      for (const diff of scenario.diffs) {
        console.error(
          `    ${diff.kind} ${diff.path}` +
            `${diff.expected === undefined ? '' : ` 期望 ${diff.expected}`}` +
            `${diff.actual === undefined ? '' : ` 实际 ${diff.actual}`}` +
            `${diff.note === undefined ? '' : `（${diff.note}）`}`,
        );
      }
    }
  }
  console.log(
    `\n[示例] 对账 ${result.passedCount}/${result.passedCount + result.failedCount} 场景通过` +
      (failures === 0 ? '——迁移结果与源侧期望行为等价' : '——存在差异，见上'),
  );
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error('示例出错:', error instanceof Error ? error.stack : String(error));
    process.exitCode = 2;
  });
