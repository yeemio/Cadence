/**
 * 目标写入层单测：InMemoryTarget / DryRunTarget / MasterdataTarget（鸭子形状）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTarget, DryRunTarget, canonicalKey } from '../src/memory-target.mjs';
import { MasterdataTarget } from '../src/masterdata-target.mjs';

test('InMemoryTarget：upsert 按业务键判重；代理键插入生成、更新保留；快照隔离', async () => {
  const target = new InMemoryTarget({ idField: 'id' });
  const first = await target.upsert('items', { code: 'A' }, { tenant: 't', code: 'A', name: '一' });
  assert.equal(first.action, 'inserted');
  const second = await target.upsert('items', { code: 'A' }, { tenant: 't', code: 'A', name: '二' });
  assert.equal(second.action, 'updated');
  const rows = await target.snapshot('items');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, '二');
  assert.match(rows[0].id, /^[0-9a-f-]{36}$/);
  // 更新保留原 id
  const third = await target.upsert('items', { code: 'A' }, { tenant: 't', code: 'A', name: '三' });
  assert.equal(third.action, 'updated');
  assert.equal((await target.snapshot('items'))[0].id, rows[0].id);
  // 快照是副本：改副本不影响存储
  rows[0].name = '篡改';
  assert.equal((await target.snapshot('items'))[0].name, '三');
  // 复合键：键序无关
  const t2 = new InMemoryTarget();
  await t2.upsert('d', { a: 1, b: 2 }, { a: 1, b: 2 });
  assert.equal((await t2.upsert('d', { b: 2, a: 1 }, { a: 1, b: 2 })).action, 'updated');
  // 未声明 dataset 快照 = 空
  assert.deepEqual(await target.snapshot('ghost'), []);
  assert.equal(canonicalKey({ b: 1, a: 2 }), canonicalKey({ a: 2, b: 1 }));
});

test('InMemoryTarget：无 idField 纯透传', async () => {
  const target = new InMemoryTarget();
  await target.upsert('d', { code: 'A' }, { code: 'A', x: 1 });
  const rows = await target.snapshot('d');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['code', 'x']);
});

test('DryRunTarget：只记计数不存行', async () => {
  const target = new DryRunTarget();
  assert.equal((await target.upsert('d', { code: 'A' }, { code: 'A' })).action, 'inserted');
  assert.equal((await target.upsert('d', { code: 'A' }, { code: 'A' })).action, 'updated');
  assert.equal((await target.upsert('d', { code: 'B' }, { code: 'B' })).action, 'inserted');
  assert.deepEqual(await target.snapshot('d'), []);
});

/** 主数据存储桩：鸭子对齐 ItemStore 子集（create/list/update），记录调用。 */
function stubMasterdataStore({ existing = [], failOn } = {}) {
  const calls = { create: [], update: [] };
  const rows = existing.map((row, i) => ({ id: `id-${i + 1}`, ...row }));
  return {
    calls,
    async create(input) {
      calls.create.push(input);
      if (failOn === 'create') throw new Error('存储不可用（模拟）');
      const row = { id: `id-new`, spec: null, unit: null, category: null, active: true, ...input };
      rows.push(row);
      return row;
    },
    async list(tenant) {
      return rows.filter((row) => row.tenant === tenant || row.tenant === undefined);
    },
    async update(tenant, id, input) {
      calls.update.push({ tenant, id, input });
      const row = rows.find((candidate) => candidate.id === id);
      if (row === undefined) return null;
      Object.assign(row, input);
      return row;
    },
  };
}

test('MasterdataTarget：插入路径（按 code 判重 + 字段投影 + toTenantId 钩子）', async () => {
  const store = stubMasterdataStore();
  const seenTenants = [];
  const target = new MasterdataTarget({
    stores: { items: store },
    toTenantId: (tenant) => {
      seenTenants.push(tenant);
      return { tenant };
    },
  });
  const result = await target.upsert(
    'items',
    { code: 'P-1' },
    { tenant: 't-alpha', code: 'P-1', name: '名称', unit: '件', active: false, 未映射字段: 'x' },
  );
  assert.equal(result.action, 'inserted');
  assert.equal(store.calls.create.length, 1);
  const created = store.calls.create[0];
  assert.equal(created.tenant.tenant, 't-alpha'); // toTenantId 生效
  assert.equal(created.code, 'P-1');
  assert.equal(created.name, '名称');
  assert.equal(created.unit, '件');
  assert.equal(created.active, false);
  assert.ok(!('未映射字段' in created), '映射外字段不透传目标');
  assert.deepEqual(seenTenants, ['t-alpha']);
});

test('MasterdataTarget：更新路径（list 按 code 找到既有行 → update by id）', async () => {
  const store = stubMasterdataStore({ existing: [{ code: 'P-1', name: '旧名' }] });
  const target = new MasterdataTarget({ stores: { items: store } });
  const result = await target.upsert(
    'items',
    { code: 'P-1' },
    { tenant: 't', code: 'P-1', name: '新名', spec: null },
  );
  assert.equal(result.action, 'updated');
  assert.equal(store.calls.create.length, 0);
  assert.equal(store.calls.update[0].id, 'id-1');
  assert.deepEqual(store.calls.update[0].input, { name: '新名', spec: null });
  // 行内未出现的字段不下发（期望态语义：未出现 = 不动）
  assert.ok(!('unit' in store.calls.update[0].input));
});

test('MasterdataTarget：resources 字段集 / 错误面（缺 tenant、非 code 键、未声明 dataset、存储抛错）', async () => {
  const store = stubMasterdataStore();
  const target = new MasterdataTarget({ stores: { items: store, resources: stubMasterdataStore() } });
  await assert.rejects(
    target.upsert('items', { code: 'P' }, { code: 'P', name: 'x' }),
    /缺 tenant 字段/,
  );
  await assert.rejects(
    target.upsert('items', { id: 'P' }, { tenant: 't', id: 'P' }),
    /业务键必须是 code/,
  );
  await assert.rejects(target.upsert('workorders', { code: 'W' }, { tenant: 't' }), /未声明 dataset/);
  const failing = new MasterdataTarget({ stores: { items: stubMasterdataStore({ failOn: 'create' }) } });
  await assert.rejects(
    failing.upsert('items', { code: 'P' }, { tenant: 't', code: 'P', name: 'x' }),
    /存储不可用/,
  );
  // resources 投影：name/type/active
  const rs = stubMasterdataStore();
  const rt = new MasterdataTarget({ stores: { resources: rs } });
  await rt.upsert('resources', { code: 'R-1' }, { tenant: 't', code: 'R-1', name: '站', type: 'line', active: true });
  assert.deepEqual(
    { ...rs.calls.create[0], tenant: undefined },
    { tenant: undefined, code: 'R-1', name: '站', type: 'line', active: true },
  );
});

test('MasterdataTarget：构造期端口形状校验 + 快照需租户', async () => {
  assert.throws(() => new MasterdataTarget({ stores: {} }), /stores/);
  assert.throws(
    () => new MasterdataTarget({ stores: { items: { create() {}, list() {} } } }),
    /缺 update\(\)/,
  );
  assert.throws(() => new MasterdataTarget({ stores: { workorders: {} } }), /未知主数据 dataset/);
  const store = stubMasterdataStore({ existing: [{ code: 'P-1', name: 'x' }] });
  const target = new MasterdataTarget({ stores: { items: store } });
  await assert.rejects(target.snapshot('items'), /filter\.tenant/);
  const rows = await target.snapshot('items', { tenant: 't' });
  assert.equal(rows.length, 1);
});
