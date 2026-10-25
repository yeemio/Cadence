/**
 * 映射引擎单测（node:test——取舍：deploy 无 package.json/vitest，node 内置
 * 测试器零依赖即用；`node --test deploy/migration/tests/`）。
 *
 * 覆盖（Done-when #2）：全类型转换、缺列 fail-fast、必填空值拒、tenant
 * 常量注入、默认值、空转 null、错误行收集（一行多字段错全报）、业务键
 * 隐含必填、from/constant 二选一等配置校验。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileDatasetMapping, transformRow, loadMappingFile } from '../src/mapping-engine.mjs';
import { ConfigError } from '../src/source-port.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const COLUMNS = ['code', 'label', 'qty', 'price', 'enabled', 'listed', 'note'].map((name) => ({
  name,
}));

function compile(fields, businessKey = ['code']) {
  return compileDatasetMapping({ businessKey, fields }, { name: 't', columns: COLUMNS }, 't');
}

function rowOf(cells) {
  return { dataset: 't', rowNumber: 1, cells };
}

test('全类型转换：string trim / number / boolean 词表 / date 规范化', () => {
  const compiled = compile([
    { to: 'code', from: 'code' },
    { to: 'name', from: 'label', type: 'string' },
    { to: 'qty', from: 'qty', type: 'number' },
    { to: 'price', from: 'price', type: 'number' },
    { to: 'active', from: 'enabled', type: 'boolean' },
    { to: 'listedAt', from: 'listed', type: 'date' },
  ]);
  const result = transformRow(
    compiled,
    rowOf({
      code: ' P-1 ',
      label: '  名称  ',
      qty: 3,
      price: '12.5',
      enabled: 'YES',
      listed: '2026-01-02',
    }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    code: 'P-1',
    name: '名称',
    qty: 3,
    price: 12.5,
    active: true,
    listedAt: '2026-01-02T00:00:00.000Z',
  });
  assert.deepEqual(result.key, { code: 'P-1' });
});

test('boolean 全词表与拒绝面', () => {
  const compiled = compile([{ to: 'code', from: 'code' }, { to: 'a', from: 'enabled', type: 'boolean' }]);
  const truthy = ['true', '1', 'yes', 'y', 'on', 'TRUE', 'On'];
  for (const value of truthy) {
    assert.equal(transformRow(compiled, rowOf({ code: 'P', enabled: value })).value.a, true, value);
  }
  const falsy = ['false', '0', 'no', 'n', 'off', 'FALSE', 'Off'];
  for (const value of falsy) {
    assert.equal(transformRow(compiled, rowOf({ code: 'P', enabled: value })).value.a, false, value);
  }
  assert.equal(transformRow(compiled, rowOf({ code: 'P', enabled: true })).value.a, true);
  assert.equal(transformRow(compiled, rowOf({ code: 'P', enabled: 0 })).value.a, false);
  for (const bad of ['2', 'maybe', '否']) {
    const bad1 = transformRow(compiled, rowOf({ code: 'P', enabled: bad }));
    assert.equal(bad1.ok, false, bad);
    assert.match(bad1.errors[0].message, /无法转换为 boolean/);
  }
  // 空串走"空值路径"（非必填无默认 → null），不是转换错误——空值语义见文件头
  const empty = transformRow(compiled, rowOf({ code: 'P', enabled: '' }));
  assert.deepEqual({ ok: empty.ok, a: empty.value?.a ?? null }, { ok: true, a: null });
});

test('number 拒绝面：NaN 串 / 非有限 / boolean / 空串', () => {
  const compiled = compile([{ to: 'code', from: 'code' }, { to: 'n', from: 'price', type: 'number' }]);
  for (const bad of ['abc', '12px']) {
    const r = transformRow(compiled, rowOf({ code: 'P', price: bad }));
    assert.equal(r.ok, false, bad);
  }
  // 空串走空值路径 → null（同上）
  assert.equal(transformRow(compiled, rowOf({ code: 'P', price: '' })).value.n, null);
  assert.equal(transformRow(compiled, rowOf({ code: 'P', price: true })).ok, false);
  assert.equal(transformRow(compiled, rowOf({ code: 'P', price: Number.NaN })).ok, false);
  assert.equal(transformRow(compiled, rowOf({ code: 'P', price: -3.5 })).value.n, -3.5);
});

test('date 拒绝 number/boolean 与不可解析串；输出统一 ISO UTC', () => {
  const compiled = compile([{ to: 'code', from: 'code' }, { to: 'd', from: 'listed', type: 'date' }]);
  assert.equal(transformRow(compiled, rowOf({ code: 'P', listed: 1767000000000 })).ok, false);
  assert.equal(transformRow(compiled, rowOf({ code: 'P', listed: true })).ok, false);
  assert.equal(transformRow(compiled, rowOf({ code: 'P', listed: 'not-a-date' })).ok, false);
  assert.equal(
    transformRow(compiled, rowOf({ code: 'P', listed: '2026-03-04T05:06:07+08:00' })).value.d,
    '2026-03-03T21:06:07.000Z',
  );
});

test('tenant 常量注入 + 默认值 + 空转 null + 统计', () => {
  const compiled = compile([
    { to: 'tenant', constant: 'tenant-alpha' },
    { to: 'code', from: 'code' },
    { to: 'unit', from: 'note', type: 'string', default: '件' },
    { to: 'remark', from: 'label', type: 'string' },
  ]);
  const result = transformRow(compiled, rowOf({ code: 'P-1', label: '', note: '' }));
  assert.deepEqual(result.value, { tenant: 'tenant-alpha', code: 'P-1', unit: '件', remark: null });
  assert.deepEqual(result.stats, {
    tenant: { converted: 0, constant: 1, default: 0, emptyToNull: 0 },
    code: { converted: 1, constant: 0, default: 0, emptyToNull: 0 },
    unit: { converted: 0, constant: 0, default: 1, emptyToNull: 0 },
    remark: { converted: 0, constant: 0, default: 0, emptyToNull: 1 },
  });
});

test('必填空值拒（含 0/false 非空语义）', () => {
  const compiled = compile([
    { to: 'code', from: 'code' },
    { to: 'name', from: 'label', required: true },
  ]);
  for (const empty of ['', '   ', null]) {
    const r = transformRow(compiled, rowOf({ code: 'P', label: empty }));
    assert.equal(r.ok, false, String(empty));
    assert.equal(r.errors[0].field, 'name');
    assert.match(r.errors[0].message, /必填字段为空/);
  }
  // 0 / false 是值不是空
  const zero = transformRow(
    compile([{ to: 'code', from: 'code' }, { to: 'n', from: 'price', type: 'number', required: true }]),
    rowOf({ code: 'P', price: 0 }),
  );
  assert.equal(zero.ok, true);
  assert.equal(zero.value.n, 0);
});

test('错误行收集：一行多字段错全报，互不截断', () => {
  const compiled = compile([
    { to: 'code', from: 'code', required: true },
    { to: 'name', from: 'label', required: true },
    { to: 'n', from: 'price', type: 'number' },
  ]);
  const r = transformRow(compiled, rowOf({ code: '', label: '', price: 'abc' }));
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.errors.map((e) => e.field),
    ['code', 'name', 'n'],
  );
});

test('缺列 fail-fast：编译期报全，不读任何行', () => {
  assert.throws(
    () => compile([{ to: 'x', from: 'ghost' }, { to: 'y', from: 'phantom' }]),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /ghost/);
      assert.match(error.message, /phantom/);
      return true;
    },
  );
});

test('业务键隐含必填；键字段必须出现在 to 集', () => {
  const compiled = compile([
    { to: 'code', from: 'code' },
    { to: 'name', from: 'label' },
  ]);
  // code 因业务键隐含 required：空值拒绝
  const r = transformRow(compiled, rowOf({ code: '', label: 'x' }));
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /必填字段为空/);
  assert.throws(
    () => compile([{ to: 'name', from: 'label' }], ['code']),
    (error) => error instanceof ConfigError && /businessKey 字段/.test(error.message),
  );
});

test('配置校验：from/constant 二选一、to 唯一、type 合法、constant 标量', () => {
  assert.throws(() => compile([{ to: 'a', from: 'code', constant: 'x' }]), ConfigError);
  assert.throws(() => compile([{ to: 'a' }]), ConfigError);
  assert.throws(
    () => compile([{ to: 'a', from: 'code' }, { to: 'a', from: 'label' }]),
    ConfigError,
  );
  assert.throws(() => compile([{ to: 'a', from: 'code', type: 'decimal' }]), ConfigError);
  assert.throws(() => compile([{ to: 'a', constant: { deep: true } }]), ConfigError);
  assert.throws(() => compile([{ to: 'a', constant: [1] }]), ConfigError);
  // 合法：constant 标量四种
  for (const constant of ['t', 1, true, null]) {
    const c = compile([{ to: 'code', from: 'code' }, { to: 'k', constant }]);
    const r = transformRow(c, rowOf({ code: 'P' }));
    assert.equal(r.value.k, constant);
  }
});

test('复合业务键：key 含多字段且键序无关', () => {
  const compiled = compile(
    [
      { to: 'tenant', constant: 't1' },
      { to: 'code', from: 'code' },
      { to: 'region', from: 'note' },
    ],
    ['tenant', 'code'],
  );
  const r = transformRow(compiled, rowOf({ code: 'P', note: 'north' }));
  assert.deepEqual(r.key, { tenant: 't1', code: 'P' });
});

test('loadMappingFile：坏 JSON / 坏 format / 空 datasets 均报路径', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cadence-mapping-test-'));
  const badJson = join(dir, 'bad.json');
  writeFileSync(badJson, '{oops', 'utf8');
  assert.throws(() => loadMappingFile(badJson), (e) => e instanceof ConfigError && /JSON 解析失败/.test(e.message));
  const badFormat = join(dir, 'format.json');
  writeFileSync(badFormat, JSON.stringify({ format: 'x', datasets: { a: {} } }), 'utf8');
  assert.throws(() => loadMappingFile(badFormat), (e) => /format 必须/.test(e.message));
  const empty = join(dir, 'empty.json');
  writeFileSync(empty, JSON.stringify({ format: 'smes.migration-mapping@1', datasets: {} }), 'utf8');
  assert.throws(() => loadMappingFile(empty), (e) => /datasets 必须是非空对象/.test(e.message));
});
