/**
 * 租户解析失败 → 421 e2e（M4 部署期收尾波）：saas 形态下未知/域外/空/多级
 * Host 的 fail-closed 响应从 500 收敛为 421 Misdirected Request。
 *
 * 装配与 main.ts saas 形态同构（租户中间件 + Express 全局错误中间件——
 * tenantResolutionErrorHandler；main.ts import 即自启、无句柄可关，故测试内
 * 复刻，同 boot.e2e.test.ts 纪律）。
 *
 * 请求用 node:http 而非 fetch：fetch 规范禁改 Host 头（静默忽略）——与镜像内
 * 健康探针同一取舍（healthcheck-probe.ts 文件头）。
 */
import 'reflect-metadata';
import { get as httpGet } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { TenantContext } from '@smes/application';
import { hostBasedTenantResolver } from '@smes/business-core';
import { buildAppModule, parseModulesEnabled } from '../src/app-registry.js';
import { parseKnownTenants } from '../src/healthcheck-probe.js';
import { tenantResolutionErrorHandler } from '../src/tenant-resolution-error.handler.js';

const bootedApps: INestApplication[] = [];

/** main.ts saas 形态同构起服（零 DB；解析器 + 中间件 + 错误中间件）。 */
async function bootSaasApp(): Promise<number> {
  const app = await NestFactory.create(buildAppModule(parseModulesEnabled(undefined)), {
    logger: ['error', 'warn'],
  });
  const tenantContext = app.get(TenantContext);
  const domain = 'smes.test';
  tenantContext.useResolver(
    hostBasedTenantResolver({ domain, lookup: () => parseKnownTenants('tenant-a') }),
  );
  app.use((request: unknown, _response: unknown, next: () => void) => {
    tenantContext.run(tenantContext.resolve(request), () => next());
  });
  app.use(tenantResolutionErrorHandler);
  await app.listen(0);
  bootedApps.push(app);
  return (app.getHttpServer().address() as AddressInfo).port;
}

/** 带自定义 Host 头的 GET（fetch 禁改 Host，故用 node:http）。 */
function getWithHost(port: number, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveGet, rejectGet) => {
    const request = httpGet(
      { host: '127.0.0.1', port, path: '/health', headers: { Host: host } },
      (response) => {
        let data = '';
        response.on('data', (chunk: string) => {
          data += chunk;
        });
        response.on('end', () => resolveGet({ status: response.statusCode ?? 0, body: data }));
      },
    );
    request.on('error', rejectGet);
  });
}

describe('saas 形态租户解析失败 → 421（Express 全局错误中间件）', () => {
  let port: number;

  afterAll(async () => {
    for (const app of bootedApps) {
      await app.close();
    }
  });

  it('先起服：已知租户 Host 正常路由（tenant-a → 200，对照组）', async () => {
    port = await bootSaasApp();
    const known = await getWithHost(port, 'tenant-a.smes.test');
    expect(known.status).toBe(200);
    expect(JSON.parse(known.body)).toEqual({ status: 'ok', tenant: 'tenant-a' });
  });

  it('域内未知租户 → 421 + Misdirected Request 体（原 500 收敛）', async () => {
    const rogue = await getWithHost(port, 'rogue.smes.test');
    expect(rogue.status).toBe(421);
    const body = JSON.parse(rogue.body) as { statusCode: number; error: string; message: string };
    expect(body.statusCode).toBe(421);
    expect(body.error).toBe('Misdirected Request');
    expect(body.message).toContain('rogue');
  });

  it('域外 Host → 421（fail-closed：不回落默认租户）', async () => {
    const offDomain = await getWithHost(port, 'evil.example.com');
    expect(offDomain.status).toBe(421);
  });

  it('多级子域 → 421（a.b.smes.test 非首标签直匹配）', async () => {
    const multi = await getWithHost(port, 'a.b.smes.test');
    expect(multi.status).toBe(421);
  });

  it('空 Host → 421（缺 Host 同 fail-closed）', async () => {
    const empty = await getWithHost(port, '');
    expect(empty.status).toBe(421);
  });

  it('非 TenantResolutionError 异常原样放行（处理器不吞其他错误）', () => {
    const nextCalls: unknown[][] = [];
    const statusCalls: number[] = [];
    const response = { status: (code: number) => { statusCalls.push(code); return { json: () => {} }; } };
    tenantResolutionErrorHandler(
      new Error('unrelated'),
      {},
      response,
      (err?: unknown) => nextCalls.push([err]),
    );
    expect(nextCalls).toHaveLength(1);
    expect(statusCalls).toEqual([]);
  });
});
