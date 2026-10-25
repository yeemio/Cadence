/**
 * pipeline 单测：双模式（report 收集 / strict 首错即停）、目标写入错误归并、
 * 计数与统计、dataset 选择与配置对账。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runMigration } from '../src/pipeline.mjs';
import { InMemoryTarget } from '../src/memory-target.mjs';
import { ConfigError, RowReadError, StrictModeAbort } from '../src/source-port.mjs';
import { renderTextReport, exitCodeOf } from '../src/report.mjs';

/** 内存源（AsyncGenerator——同端口形状，测 pipeline 编排不测解析）。 */
class ArraySource {
  constructor(datasets) {
    this.datasets = datasets; // [{ name, columns: [..], rows: [cells | RowReadError] }]
    this.name = 'array';
  }

  descriptor() {
    return {
      datasets: this.datasets.map((d) => ({
        name: d.name,
        file: `<memory:${d.name}>`,
        format: 'csv',
        columns: d.columns.map((name) => ({ name })),
      })),
    };
  }

  async *readRows(datasetName) {
    const def = this.datasets.find((d) => d.name === datasetName);
    if (def === undefined) throw new ConfigError(`未知 dataset '${datasetName}'`);
    let rowNumber = 0;
    for (const row of def.rows) {
      rowNumber += 1;
      if (row instanceof RowReadError) {
        yield row;
      } else {
        yield { dataset: datasetName, rowNumber, cells: row };
      }
    }
  }
}

const COLUMNS = ['code', 'name', 'qty'];

function mappingOf(fields, businessKey = ['code']) {
  return {
    file: '<test>',
    datasets: { t: { businessKey, fields } },
  };
}

const FIELDS = [
  { to: 'tenant', constant: 't-1' },
  { to: 'code', from: 'code' },
  { to: 'name', from: 'name', required: true },
  { to: 'qty', from: 'qty', type: 'number' },
];

function sourceOf(rows) {
  return new ArraySource([{ name: 't', columns: COLUMNS, rows }]);
}

test('report 模式：坏行收集不中断，好行照常写入，报告含明细与统计', async () => {
  const target = new InMemoryTarget();
  const report = await runMigration({
    source: sourceOf([
      { code: 'A', name: '甲', qty: '1' },
      { code: 'B', name: '', qty: '2' }, // 必填空 → 失败
      { code: 'C', name: '丙', qty: 'abc' }, // 类型转换失败 → 失败
      { code: 'A', name: '甲二', qty: '1' }, // 重复键 → updated
    ]),
    mapping: mappingOf(FIELDS),
    target,
  });
  assert.equal(report.mode, 'report');
  assert.equal(report.totals.rowsRead, 4);
  assert.equal(report.totals.rowsOk, 2);
  assert.equal(report.totals.rowsFailed, 2);
  assert.equal(report.totals.inserted, 1);
  assert.equal(report.totals.updated, 1);
  const dataset = report.datasets[0];
  assert.equal(dataset.failures.length, 2);
  assert.equal(dataset.failures[0].rowNumber, 2);
  assert.equal(dataset.failures[0].errors[0].field, 'name');
  assert.match(dataset.failures[1].errors[0].message, /无法转换为 number/);
  assert.equal(dataset.stats.tenant.constant, 2); // 字段统计只计成功行（失败行走失败明细）
  assert.equal((await target.snapshot('t')).length, 1);
  const text = renderTextReport(report);
  assert.match(text, /失败 2/);
  assert.match(text, /行 2 \[name\]：必填字段为空/);
  assert.equal(exitCodeOf(report), 1);
});

test('strict 模式：首错即抛 StrictModeAbort（携带 dataset/行号/字段）', async () => {
  await assert.rejects(
    runMigration({
      source: sourceOf([
        { code: 'A', name: '甲', qty: '1' },
        { code: 'B', name: '', qty: '2' },
        { code: 'C', name: '丙', qty: '3' },
      ]),
      mapping: mappingOf(FIELDS),
      target: new InMemoryTarget(),
      mode: 'strict',
    }),
    (error) => {
      assert.ok(error instanceof StrictModeAbort);
      assert.equal(error.failure.dataset, 't');
      assert.equal(error.failure.rowNumber, 2);
      assert.equal(error.failure.errors[0].field, 'name');
      return true;
    },
  );
});

test('行级读取错误（RowReadError）进失败；目标写入抛错同样进失败（report 模式）', async () => {
  const report = await runMigration({
    source: sourceOf([
      new RowReadError('t', 1, '坏行（模拟）'),
      { code: 'A', name: '甲', qty: '1' },
    ]),
    mapping: mappingOf(FIELDS),
    target: new InMemoryTarget(),
  });
  assert.equal(report.totals.rowsFailed, 1);
  assert.match(report.datasets[0].failures[0].errors[0].message, /坏行（模拟）/);

  const failing = {
    name: 'failing',
    async upsert() {
      throw new Error('连接拒绝（模拟）');
    },
  };
  const report2 = await runMigration({
    source: sourceOf([{ code: 'A', name: '甲', qty: '1' }]),
    mapping: mappingOf(FIELDS),
    target: failing,
  });
  assert.equal(report2.totals.rowsFailed, 1);
  assert.match(report2.datasets[0].failures[0].errors[0].message, /目标写入失败：连接拒绝/);
  // strict 下目标错误同样首错即停
  await assert.rejects(
    runMigration({
      source: sourceOf([{ code: 'A', name: '甲', qty: '1' }]),
      mapping: mappingOf(FIELDS),
      target: failing,
      mode: 'strict',
    }),
    StrictModeAbort,
  );
});

test('配置对账：dataset 无映射 / 选中集外名 / 坏 mode → ConfigError；子集选择', async () => {
  const source = new ArraySource([
    { name: 't', columns: COLUMNS, rows: [{ code: 'A', name: '甲', qty: '1' }] },
    { name: 'u', columns: ['x'], rows: [] },
  ]);
  await assert.rejects(
    runMigration({ source, mapping: mappingOf(FIELDS), target: new InMemoryTarget() }),
    (e) => e instanceof ConfigError && /'u' 无映射配置/.test(e.message),
  );
  await assert.rejects(
    runMigration({
      source,
      mapping: mappingOf(FIELDS),
      target: new InMemoryTarget(),
      datasets: ['t', 'ghost'],
    }),
    (e) => e instanceof ConfigError && /ghost.*不在源描述符/.test(e.message),
  );
  await assert.rejects(
    runMigration({
      source,
      mapping: mappingOf(FIELDS),
      target: new InMemoryTarget(),
      mode: 'loose',
    }),
    (e) => e instanceof ConfigError && /mode 必须/.test(e.message),
  );
  // 子集选择：只迁 t，u 不动
  const target = new InMemoryTarget();
  const report = await runMigration({
    source,
    mapping: mappingOf(FIELDS),
    target,
    datasets: ['t'],
  });
  assert.deepEqual(report.datasets.map((d) => d.dataset), ['t']);
  assert.equal(report.totals.rowsOk, 1);
});

test('报告渲染：全成 exit 0、字段统计行、总计行', async () => {
  const report = await runMigration({
    source: sourceOf([{ code: 'A', name: '甲', qty: '7' }]),
    mapping: mappingOf(FIELDS),
    target: new InMemoryTarget(),
  });
  const text = renderTextReport(report);
  assert.match(text, /target=memory mode=report/);
  assert.match(text, /tenant：常量×1/);
  assert.match(text, /qty：转换×1/);
  assert.match(text, /总计：读取 1 行，成功 1，失败 0/);
  assert.equal(exitCodeOf(report), 0);
});
