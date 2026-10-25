/**
 * 源读取层单测：CsvFileSource（手写流式解析器）/ JsonLinesSource /
 * 源描述符加载校验。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCsvRecords, CsvFileSource } from '../src/csv-source.mjs';
import { JsonLinesSource } from '../src/jsonl-source.mjs';
import { loadSourceDescriptor, DirectoryMigrationSource } from '../src/source-descriptor.mjs';
import { ConfigError, RowReadError } from '../src/source-port.mjs';

function workdir() {
  return mkdtempSync(join(tmpdir(), 'cadence-src-test-'));
}

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function writeSource(dir, csvBody, columns = ['code', 'label']) {
  writeFileSync(join(dir, 'items.csv'), csvBody, 'utf8');
  writeFileSync(
    join(dir, 'source-descriptor.json'),
    JSON.stringify({
      format: 'smes.migration-source@1',
      datasets: [
        { name: 'items', file: 'items.csv', format: 'csv', columns: columns.map((name) => ({ name })) },
      ],
    }),
    'utf8',
  );
}

test('parseCsvRecords：引号内逗号/转义引号/换行/CRLF/BOM/无尾换行', async () => {
  const dir = workdir();
  const file = join(dir, 'a.csv');
  writeFileSync(
    file,
    '\uFEFFcode,label\r\nA,"x,y"\r\nB,"say ""hi"""\nC,"multi\nline"\rD,tail',
    'utf8',
  );
  const records = await collect(parseCsvRecords(file));
  assert.deepEqual(records[0], { kind: 'header', columns: ['code', 'label'] });
  assert.deepEqual(records[1], { kind: 'data', rowNumber: 1, fields: ['A', 'x,y'] });
  assert.deepEqual(records[2], { kind: 'data', rowNumber: 2, fields: ['B', 'say "hi"'] });
  assert.deepEqual(records[3], { kind: 'data', rowNumber: 3, fields: ['C', 'multi\nline'] });
  assert.deepEqual(records[4], { kind: 'data', rowNumber: 4, fields: ['D', 'tail'] });
  assert.equal(records.length, 5);
});

test('parseCsvRecords：空行跳过、仅表头文件、空文件', async () => {
  const dir = workdir();
  const blank = join(dir, 'blank.csv');
  writeFileSync(blank, 'a,b\n\n1,2\n\n\n3,4\n', 'utf8');
  const records = await collect(parseCsvRecords(blank));
  assert.deepEqual(
    records.map((r) => r.fields ?? r.columns),
    [['a', 'b'], ['1', '2'], ['3', '4']],
  );
  const headerOnly = join(dir, 'h.csv');
  writeFileSync(headerOnly, 'a,b', 'utf8');
  const h = await collect(parseCsvRecords(headerOnly));
  assert.equal(h.length, 1);
  assert.equal(h[0].kind, 'header');
  const empty = join(dir, 'e.csv');
  writeFileSync(empty, '', 'utf8');
  assert.equal((await collect(parseCsvRecords(empty))).length, 0);
});

test('CsvFileSource：表头与声明集合校验（顺序无关；多列/缺列 fail-fast）', async () => {
  const dir = workdir();
  writeSource(dir, 'label,code\nX,A\n');
  const source = new CsvFileSource({
    dataset: 'items',
    filePath: join(dir, 'items.csv'),
    columns: [{ name: 'code' }, { name: 'label' }],
  });
  const rows = await collect(source.readRows('items'));
  assert.deepEqual(rows, [{ dataset: 'items', rowNumber: 1, cells: { label: 'X', code: 'A' } }]);

  const extra = workdir();
  writeSource(extra, 'code,label,extra\nA,X,E\n');
  await assert.rejects(
    collect(
      new CsvFileSource({
        dataset: 'items',
        filePath: join(extra, 'items.csv'),
        columns: ['code', 'label'],
      }).readRows('items'),
    ),
    (error) => error instanceof ConfigError && /多列：extra/.test(error.message),
  );

  const missing = workdir();
  writeSource(missing, 'code\nA\n');
  await assert.rejects(
    collect(
      new CsvFileSource({
        dataset: 'items',
        filePath: join(missing, 'items.csv'),
        columns: ['code', 'label'],
      }).readRows('items'),
    ),
    (error) => error instanceof ConfigError && /缺列：label/.test(error.message),
  );
});

test('CsvFileSource：字段数不齐 → RowReadError 元素（不中断迭代）', async () => {
  const dir = workdir();
  writeSource(dir, 'code,label\nA\nB,ok\n');
  const rows = await collect(
    new CsvFileSource({
      dataset: 'items',
      filePath: join(dir, 'items.csv'),
      columns: ['code', 'label'],
    }).readRows('items'),
  );
  assert.ok(rows[0] instanceof RowReadError);
  assert.match(rows[0].message, /字段数 1 ≠ 表头列数 2/);
  assert.deepEqual(rows[1], { dataset: 'items', rowNumber: 2, cells: { code: 'B', label: 'ok' } });
});

test('CsvFileSource：未知 dataset → ConfigError；无表头 → ConfigError', async () => {
  const dir = workdir();
  writeSource(dir, 'code,label\nA,X\n');
  const source = new CsvFileSource({
    dataset: 'items',
    filePath: join(dir, 'items.csv'),
    columns: ['code', 'label'],
  });
  await assert.rejects(collect(source.readRows('other')), ConfigError);
  const noHeader = workdir();
  writeFileSync(join(noHeader, 'empty.csv'), '', 'utf8');
  await assert.rejects(
    collect(
      new CsvFileSource({
        dataset: 'items',
        filePath: join(noHeader, 'empty.csv'),
        columns: ['code'],
      }).readRows('items'),
    ),
    (error) => error instanceof ConfigError && /无表头行/.test(error.message),
  );
});

test('JsonLinesSource：原生类型透传 / 空白行跳过 / 未声明键忽略 / 行号=物理行号', async () => {
  const dir = workdir();
  const file = join(dir, 'r.jsonl');
  writeFileSync(
    file,
    '{"code":"RS-1","n":3,"b":false,"x":null}\n' +
      '\n' +
      '   \n' +
      '{"code":"RS-2","undeclared":"ignored"}\n',
    'utf8',
  );
  const source = new JsonLinesSource({
    dataset: 'resources',
    filePath: file,
    columns: ['code', 'n', 'b', 'x'],
  });
  const rows = await collect(source.readRows('resources'));
  assert.deepEqual(rows[0], {
    dataset: 'resources',
    rowNumber: 1,
    cells: { code: 'RS-1', n: 3, b: false, x: null },
  });
  assert.deepEqual(rows[1], { dataset: 'resources', rowNumber: 4, cells: { code: 'RS-2' } });
});

test('JsonLinesSource：坏 JSON / 非对象顶层 / 嵌套值 → RowReadError', async () => {
  const dir = workdir();
  const file = join(dir, 'bad.jsonl');
  writeFileSync(
    file,
    '{"code":"A"\n[1,2]\n{"nested":{"deep":1}}\n42\n',
    'utf8',
  );
  const source = new JsonLinesSource({ dataset: 'resources', filePath: file, columns: ['code'] });
  const rows = await collect(source.readRows('resources'));
  for (const row of rows) {
    assert.ok(row instanceof RowReadError, JSON.stringify(row));
  }
  assert.match(rows[0].message, /JSON 解析失败/);
  assert.match(rows[1].message, /顶层必须是 JSON 对象/);
  assert.match(rows[2].message, /顶层字段 'nested'/);
  assert.match(rows[3].message, /顶层必须是 JSON 对象/);
});

test('源描述符校验：缺文件 / 坏 format / 重复 dataset / 缺数据文件 / 重复列', () => {
  const dir = workdir();
  assert.throws(
    () => loadSourceDescriptor(dir),
    (e) => e instanceof ConfigError && /源描述符缺失/.test(e.message),
  );
  const mk = (payload) => {
    const d = workdir();
    writeFileSync(join(d, 'a.csv'), 'code\nA\n', 'utf8'); // 让"文件存在"检查通过，直抵被测分支
    writeFileSync(join(d, 'source-descriptor.json'), JSON.stringify(payload), 'utf8');
    return d;
  };
  assert.throws(() => loadSourceDescriptor(mk({ format: 'x', datasets: [] })), /format/);
  assert.throws(
    () =>
      loadSourceDescriptor(
        mk({
          format: 'smes.migration-source@1',
          datasets: [
            { name: 'a', file: 'a.csv', format: 'csv', columns: [{ name: 'c' }] },
            { name: 'a', file: 'a.csv', format: 'csv', columns: [{ name: 'c' }] },
          ],
        }),
      ),
    /重复/,
  );
  assert.throws(
    () =>
      loadSourceDescriptor(
        mk({ format: 'smes.migration-source@1', datasets: [{ name: 'a', file: 'ghost.csv', format: 'csv', columns: [{ name: 'c' }] }] }),
      ),
    /数据文件不存在/,
  );
  assert.throws(
    () =>
      loadSourceDescriptor(
        mk({ format: 'smes.migration-source@1', datasets: [{ name: 'a', file: 'a.csv', format: 'csv', columns: [{ name: 'c' }, { name: 'c' }] }] }),
      ),
    /列名 'c' 重复/,
  );
  assert.throws(
    () =>
      loadSourceDescriptor(
        mk({ format: 'smes.migration-source@1', datasets: [{ name: 'a', file: 'a.csv', format: 'xlsx', columns: [{ name: 'c' }] }] }),
      ),
    /format 必须是 csv\/jsonl/,
  );
});

test('DirectoryMigrationSource：按 format 分派读取器，描述符聚合', async () => {
  const dir = workdir();
  writeSource(dir, 'code,label\nA,X\n');
  writeFileSync(
    join(dir, 'r.jsonl'),
    '{"code":"RS-1"}\n',
    'utf8',
  );
  writeFileSync(
    join(dir, 'source-descriptor.json'),
    JSON.stringify({
      format: 'smes.migration-source@1',
      datasets: [
        { name: 'items', file: 'items.csv', format: 'csv', columns: [{ name: 'code' }, { name: 'label' }] },
        { name: 'resources', file: 'r.jsonl', format: 'jsonl', columns: [{ name: 'code' }] },
      ],
    }),
    'utf8',
  );
  const source = new DirectoryMigrationSource(dir);
  assert.deepEqual(
    source.descriptor().datasets.map((d) => `${d.name}:${d.format}`),
    ['items:csv', 'resources:jsonl'],
  );
  const rows = await collect(source.readRows('items'));
  assert.deepEqual(rows[0].cells, { code: 'A', label: 'X' });
  const rs = await collect(source.readRows('resources'));
  assert.deepEqual(rs[0].cells, { code: 'RS-1' });
  assert.throws(() => source.readRows('ghost'), ConfigError);
});
