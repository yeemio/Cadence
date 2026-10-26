/**
 * 列显隐偏好（fix-wave-6 6b-3，A14 / RREQ-INT-032）测试：端口内存实现
 * （三元组收口/空数组语义/upsert 幂等/租户与用户双隔离）、输入解析与归一、
 * service 两用例（按页拉取缺位语义/保存忽略请求体 userId）、控制器元数据
 * （@RequireLogin 档——无权限码）、模块装配。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TenantId, UserId } from '@smes/business-core';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import { PERMISSION_METADATA_KEY } from '../../src/core/auth/require-permission.decorator.js';
import { REQUIRE_LOGIN_METADATA_KEY } from '../../src/core/auth/require-login.decorator.js';
import { InMemoryColumnPreferenceStore } from '../../src/column-preferences/in-memory-column-preferences-stores.js';
import { ColumnPreferenceController } from '../../src/column-preferences/column-preferences.controllers.js';
import { ColumnPreferenceInputError } from '../../src/column-preferences/column-preferences-errors.js';
import {
  normalizeHiddenProps,
  parsePageQuery,
  parseSavePayload,
} from '../../src/column-preferences/column-preferences-input.js';
import { ColumnPreferencesModule } from '../../src/column-preferences/column-preferences.module.js';
import { ColumnPreferenceService } from '../../src/column-preferences/column-preferences.service.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');
const u1 = UserId.create('u1');
const u2 = UserId.create('u2');

function newService(): { service: ColumnPreferenceService; store: InMemoryColumnPreferenceStore } {
  const store = new InMemoryColumnPreferenceStore();
  return { service: new ColumnPreferenceService(store), store };
}

describe('端口内存实现（三元组收口）', () => {
  it('upsert 幂等：同三元组覆盖不双行；listForPage 只见本页本人本租户', async () => {
    const store = new InMemoryColumnPreferenceStore();
    await store.upsert(t1, u1, '/dispatch', 'main', ['id', 'state']);
    await store.upsert(t1, u1, '/dispatch', 'main', ['kind']); // 覆盖
    const page = await store.listForPage(t1, u1, '/dispatch');
    expect(page).toHaveLength(1); // 不双行
    expect(page[0]!.hiddenProps).toEqual(['kind']);

    // 他用户/他租户/他页互不可见（纵深防御）
    expect(await store.listForPage(t1, u2, '/dispatch')).toHaveLength(0);
    expect(await store.listForPage(t2, u1, '/dispatch')).toHaveLength(0);
    expect(await store.listForPage(t1, u1, '/other')).toHaveLength(0);
  });

  it('空数组落库不丢（显式全显示 ≠ 从未保存——行仍在，值为 []）', async () => {
    const store = new InMemoryColumnPreferenceStore();
    await store.upsert(t1, u1, '/dispatch', 'main', []);
    const page = await store.listForPage(t1, u1, '/dispatch');
    expect(page).toHaveLength(1);
    expect(page[0]!.hiddenProps).toEqual([]);
  });

  it('一页多表：不同 tableKey 各一行，同页一次拉回', async () => {
    const store = new InMemoryColumnPreferenceStore();
    await store.upsert(t1, u1, '/listing', 'main', ['id']);
    await store.upsert(t1, u1, '/listing', 'lines', ['spec', 'unit']);
    const page = await store.listForPage(t1, u1, '/listing');
    expect(page.map((row) => row.tableKey).sort()).toEqual(['lines', 'main']);
  });
});

describe('输入解析与归一', () => {
  it('键：trim/非空/≤128；hiddenProps：null→[]、去空/去重/保序、非字符串拒绝', () => {
    expect(parsePageQuery(new URLSearchParams('page=/dispatch'))).toBe('/dispatch');
    expect(parsePageQuery(new URLSearchParams('page=%20%2Fdispatch%20'))).toBe('/dispatch'); // 解码+trim
    expect(() => parsePageQuery(new URLSearchParams(''))).toThrow(ColumnPreferenceInputError);
    expect(() => parsePageQuery(new URLSearchParams(`page=${'x'.repeat(129)}`))).toThrow(
      ColumnPreferenceInputError,
    );

    expect(normalizeHiddenProps(null)).toEqual([]);
    expect(normalizeHiddenProps(undefined)).toEqual([]);
    expect(normalizeHiddenProps(['a', ' b ', '', 'a', 'c'])).toEqual(['a', 'b', 'c']);
    expect(() => normalizeHiddenProps(['a', 1])).toThrow(ColumnPreferenceInputError);
    expect(() => normalizeHiddenProps('a')).toThrow(ColumnPreferenceInputError);
  });

  it('保存载荷：page/pageKey、table/tableKey 双拼写兼容；pageKey+table 同效', () => {
    expect(parseSavePayload({ page: ' /p ', table: ' t ', hiddenProps: ['x'] })).toEqual({
      pageKey: '/p',
      tableKey: 't',
      hiddenProps: ['x'],
    });
    expect(parseSavePayload({ pageKey: '/p', tableKey: 't', hidden: null })).toEqual({
      pageKey: '/p',
      tableKey: 't',
      hiddenProps: [],
    });
    expect(() => parseSavePayload({ page: 'p', hiddenProps: [] })).toThrow(
      ColumnPreferenceInputError,
    );
    expect(() => parseSavePayload('nope')).toThrow(ColumnPreferenceInputError);
  });
});

describe('service 用例', () => {
  it('listForPage：缺 tableKey = 从未保存；空数组键在（两态可区分）；请求体不携带 userId 面', async () => {
    const { service } = newService();
    // 从未保存：tables 空
    expect(await service.listForPage(t1, u1, new URLSearchParams('page=/p'))).toEqual({ tables: {} });
    // 保存后（含空数组表）：键在
    await service.save(t1, u1, { page: '/p', table: 'main', hiddenProps: ['a'] });
    await service.save(t1, u1, { page: '/p', table: 'lines', hiddenProps: [] });
    expect(await service.listForPage(t1, u1, new URLSearchParams('page=/p'))).toEqual({
      tables: { main: ['a'], lines: [] },
    });
    // 他人视角 = 全部从未保存（隔离由 service→store 双键收口）
    expect(await service.listForPage(t1, u2, new URLSearchParams('page=/p'))).toEqual({ tables: {} });
  });

  it('save：返回归一后的 hiddenProps；userId 参数来自会话身份（service 签名无 body userId 面）', async () => {
    const { service } = newService();
    const saved = await service.save(t1, u1, {
      page: '/p',
      table: 'main',
      hiddenProps: ['x', 'x', ''],
      userId: 'attacker', // 请求体 userId 形状上被忽略（不在解析面）
    });
    expect(saved.hiddenProps).toEqual(['x']);
  });
});

describe('控制器元数据（@RequireLogin 档声明面）', () => {
  type Handler = Record<string, unknown>;

  function meta(controller: Function, handler: string, key: symbol): unknown {
    const proto = controller.prototype as Record<string, Handler>;
    return Reflect.getMetadata(key, proto[handler] as object);
  }

  it('两端点声明仅登录档（REQUIRE_LOGIN=true）且不声明权限码（无码=登录即有权）', () => {
    for (const handler of ['list', 'save']) {
      expect(meta(ColumnPreferenceController, handler, REQUIRE_LOGIN_METADATA_KEY)).toBe(true);
      expect(meta(ColumnPreferenceController, handler, PERMISSION_METADATA_KEY)).toBeUndefined();
    }
  });

  it('ColumnPreferencesModule.register 装配控制器，缺省回落内存存储', () => {
    const dynamic = ColumnPreferencesModule.register();
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      ColumnPreferencesModule.register(),
    ) as unknown[];
    expect(dynamic.module).toBe(ColumnPreferencesModule);
    expect(controllers).toContain(ColumnPreferenceController);
  });
});
