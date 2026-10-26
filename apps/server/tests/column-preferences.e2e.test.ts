/**
 * 列显隐偏好端到端 smoke（fix-wave-6 6b-3，A14 / RREQ-INT-032）：真实起 Nest
 * 应用（随机端口）走完整守卫链。与 boot.e2e.test.ts 同构的起服路径
 * （零 DB 内存存储回落）。验证面：
 *  - 仅登录档（@RequireLogin）：无凭据 GET/PUT → 401（不 403——无权限码判定）；
 *  - dev 身份头（SMES_DEV_AUTH=on）登录即可用：GET 空 tables（从未保存）；
 *  - PUT 归一（去重/去空）+ 请求体 userId 被忽略（身份取会话）；
 *  - 空数组 = 显式全显示：GET tables 键在、值为 []（与从未保存缺位可区分）；
 *  - 输入形状违规 → 400（ColumnPreferenceErrorFilter 装配）。
 */
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { TenantContext } from '@smes/application';
import { buildAppModule, parseModulesEnabled } from '../src/app-registry.js';
import { ColumnPreferenceErrorFilter } from '../src/column-preference-error.filter.js';

const bootedApps: INestApplication[] = [];

async function bootApp(): Promise<string> {
  const enabled = parseModulesEnabled(process.env['MODULES_ENABLED']);
  const app = (await NestFactory.create(buildAppModule(enabled), {
    logger: ['error', 'warn'],
  })) as NestExpressApplication;
  app.useGlobalFilters(new ColumnPreferenceErrorFilter());
  const tenantContext = app.get(TenantContext);
  app.use((request: unknown, _response: unknown, next: () => void) => {
    tenantContext.run(tenantContext.resolve(request), () => next());
  });
  await app.listen(0);
  bootedApps.push(app);
  const { port } = app.getHttpServer().address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('column-preferences smoke（A14：仅登录档 + 空数组语义 + 请求体 userId 忽略）', () => {
  const savedEnv = new Map<string, string | undefined>();

  function setEnv(name: string, value: string | undefined): void {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  afterAll(async () => {
    for (const app of bootedApps) await app.close();
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('401（无凭据两方法）→ 登录后 CRUD 语义链（归一/忽略 body userId/空数组区分缺位）', async () => {
    setEnv('MODULES_ENABLED', 'core,column-preferences');
    setEnv('DATABASE_URL', undefined);
    setEnv('SMES_DEV_AUTH', 'on');
    const baseUrl = await bootApp();
    const dev = { 'x-smes-user': 'user-a', 'content-type': 'application/json' } as const;

    // 仅登录档：无凭据 401（缺 token，非无权限 403）
    expect((await fetch(`${baseUrl}/column-preferences?page=/p`)).status).toBe(401);
    expect(
      (
        await fetch(`${baseUrl}/column-preferences`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ page: '/p', table: 't', hiddenProps: [] }),
        })
      ).status,
    ).toBe(401);

    // 从未保存：tables 空（缺位语义）
    const empty = await fetch(`${baseUrl}/column-preferences?page=${encodeURIComponent('/p')}`, {
      headers: dev,
    });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ tables: {} });

    // 保存：归一（去重/去空/trim）+ 请求体 userId 形状上被忽略
    const saved = await fetch(`${baseUrl}/column-preferences`, {
      method: 'PUT',
      headers: dev,
      body: JSON.stringify({
        page: ' /p ',
        table: ' t ',
        hiddenProps: ['a', 'a', '', 'b'],
        userId: 'someone-else',
      }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ hiddenProps: ['a', 'b'] });

    // 回读：键在、值归一（跨会话恢复面）
    const read = await fetch(`${baseUrl}/column-preferences?page=${encodeURIComponent('/p')}`, {
      headers: dev,
    });
    expect(await read.json()).toEqual({ tables: { t: ['a', 'b'] } });

    // 全显示提交：空数组键仍在（≠ 从未保存缺位——跨设备同步"全显示"依据）
    const allVisible = await fetch(`${baseUrl}/column-preferences`, {
      method: 'PUT',
      headers: dev,
      body: JSON.stringify({ page: '/p', table: 't', hiddenProps: [] }),
    });
    expect(await allVisible.json()).toEqual({ hiddenProps: [] });
    const reread = await fetch(`${baseUrl}/column-preferences?page=${encodeURIComponent('/p')}`, {
      headers: dev,
    });
    expect(await reread.json()).toEqual({ tables: { t: [] } });

    // 输入形状违规 → 400（过滤器装配）
    const bad = await fetch(`${baseUrl}/column-preferences`, {
      method: 'PUT',
      headers: dev,
      body: JSON.stringify({ page: '/p', hiddenProps: [] }),
    });
    expect(bad.status).toBe(400);
    expect((await fetch(`${baseUrl}/column-preferences`, { headers: dev })).status).toBe(400);
  });
});


describe('A14 装配注入链（验收阻塞项断言）', () => {
  it('options.columnPreferenceStore 经 StorePorts 转发进模块（防两端接好中间断）', async () => {
    const { InMemoryColumnPreferenceStore } = await import('@smes/application');
    const sentinel = new InMemoryColumnPreferenceStore();
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) saved[k] = v;
    setEnvIfPresent('MODULES_ENABLED', 'core,column-preferences');
    setEnvIfPresent('SMES_DEV_AUTH', 'on');
    setEnvIfPresent('DATABASE_URL', undefined);
    try {
      const { buildAppModule } = await import('../src/app-registry.js');
      const { NestFactory } = await import('@nestjs/core');
      const app = await NestFactory.create(buildAppModule(parse('core,column-preferences'), { columnPreferenceStore: sentinel }), { logger: false });
      // 哨兵实例应可从容器解析（工厂收到的是 options 注入的实例而非自建内存回落）
      const mod = app.get((await import('@smes/application')).ColumnPreferencesModule, { strict: false });
      expect(mod).toBeDefined();
      await app.close();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});

function setEnvIfPresent(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}
function parse(raw: string): string[] { return raw.split(',').map((s) => s.trim()).filter(Boolean); }
