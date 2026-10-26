/**
 * 未知租户 404 / 其余 421 分叉 e2e（M5 收尾波欠账补齐）。
 *
 * main.ts saas 形态的租户中间件在 resolve 外做内联窄捕（历史欠账写明：
 * 既有 tenant-resolution.e2e.test.ts 只锚兜底错误中间件层——M4 形态的全 421
 * 装配，窄捕引入前；404/421 分叉自此无自动化锚定）：
 *   - 域内未知租户（reason 'unknown-tenant'）→ 404 Not Found：Host 属本域但
 *     租户不存在——通配 DNS 下等价 NXDOMAIN；
 *   - 其余解析失败（'off-domain' 域外 Host / 'missing-host' 缺 Host /
 *     'invalid-subdomain' 裸基础域或多级子域）→ 421 Misdirected Request。
 *
 * 装配与 main.ts saas 形态同构（main.ts import 即自启、无句柄可关，故测试内
 * 复刻，同 boot.e2e / tenant-resolution.e2e 纪律）：解析器 + 内联窄捕中间件
 * （respondTenantResolutionFailure 逐位复刻）+ 兜底 tenantResolutionErrorHandler。
 * 偏差仅一处，写明：main.ts saas 形态还包 runWithRlsTenant（RLS 电流路径，
 * 需 PG 连接才可生效），零 DB e2e 无连接可设置、分叉行为不依赖它——与既有
 * tenant-resolution.e2e 同取舍，不装。
 *
 * 零 DB：分叉在中间件层完成，不触任何存储。请求用 node:http 而非 fetch：
 * fetch 规范禁改 Host 头（静默忽略）——与镜像内健康探针同一取舍
 * （healthcheck-probe.ts 文件头）。
 */
import 'reflect-metadata';
import { get as httpGet } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { TenantContext } from '@smes/application';
import {
  hostBasedTenantResolver,
  TenantResolutionError,
  type TenantId,
} from '@smes/business-core';
import { buildAppModule, parseModulesEnabled } from '../src/app-registry.js';
import { parseKnownTenants } from '../src/healthcheck-probe.js';
import { tenantResolutionErrorHandler } from '../src/tenant-resolution-error.handler.js';

const bootedApps: INestApplication[] = [];

/** main.ts 同构的最小响应面（结构 typing，组合根不依赖 express 类型）。 */
interface TenantMiddlewareResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body: string): unknown;
}

/**
 * main.ts respondTenantResolutionFailure 复刻：unknown-tenant → 404，
 * 其余 reason → 421。响应体仅含 statusCode/error/message（消息内只有客户端
 * 自带的 Host 与非密的域配置，不回显任何租户数据）。
 */
function respondTenantResolutionFailure(
  response: TenantMiddlewareResponse,
  error: TenantResolutionError,
): void {
  const isUnknownTenant = error.reason === 'unknown-tenant';
  const statusCode = isUnknownTenant ? 404 : 421;
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(
    `${JSON.stringify({
      statusCode,
      error: isUnknownTenant ? 'Not Found' : 'Misdirected Request',
      message: error.message,
    })}\n`,
  );
}

/** main.ts saas 形态同构起服（零 DB：解析器 + 内联窄捕 + 兜底错误中间件）。 */
async function bootSaasApp(): Promise<number> {
  const app = await NestFactory.create(buildAppModule(parseModulesEnabled(undefined)), {
    logger: ['error', 'warn'],
  });
  const tenantContext = app.get(TenantContext);
  const domain = 'smes.example.com';
  tenantContext.useResolver(
    hostBasedTenantResolver({ domain, lookup: () => parseKnownTenants('tenant-a') }),
  );
  app.use((request: unknown, response: unknown, next: () => void) => {
    let tenant: TenantId;
    try {
      tenant = tenantContext.resolve(request);
    } catch (error) {
      // 仅窄捕租户解析错误（其余异常维持 Express 原生 500 路径，不吞意外错误）
      if (error instanceof TenantResolutionError) {
        respondTenantResolutionFailure(response as TenantMiddlewareResponse, error);
        return;
      }
      throw error;
    }
    tenantContext.run(tenant, () => next());
  });
  // 兜底错误中间件（main.ts 同序：窄捕中间件之后）——本装配下解析错误已被
  // 窄捕全量接住，此层是"窄捕漏接"形态的保险（漏接时 421 而非 500）。
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

describe('saas 形态未知租户 404 / 其余解析失败 421（main.ts 内联窄捕分叉）', () => {
  let port = 0;

  afterAll(async () => {
    for (const app of bootedApps) {
      await app.close();
    }
  });

  it('先起服：已知租户 Host 正常路由（tenant-a → 200，对照组）', async () => {
    port = await bootSaasApp();
    const known = await getWithHost(port, 'tenant-a.smes.example.com');
    expect(known.status).toBe(200);
    expect(JSON.parse(known.body)).toEqual({ status: 'ok', tenant: 'tenant-a' });
  });

  it('域内未知租户 → 404 + Not Found 体（reason unknown-tenant 分叉）', async () => {
    const rogue = await getWithHost(port, 'rogue.smes.example.com');
    expect(rogue.status).toBe(404);
    const body = JSON.parse(rogue.body) as { statusCode: number; error: string; message: string };
    expect(body.statusCode).toBe(404);
    expect(body.error).toBe('Not Found');
    expect(body.message).toContain('rogue'); // 通配 DNS 下等价 NXDOMAIN：客户端可提示"租户不存在"
  });

  it('域外 Host → 421（Misdirected Request；fail-closed 不回落默认租户）', async () => {
    const offDomain = await getWithHost(port, 'evil.example.com');
    expect(offDomain.status).toBe(421);
    const body = JSON.parse(offDomain.body) as { statusCode: number; error: string };
    expect(body.statusCode).toBe(421);
    expect(body.error).toBe('Misdirected Request');
  });

  it('缺 Host（空 Host 头）→ 421（missing-host 同 fail-closed）', async () => {
    const empty = await getWithHost(port, '');
    expect(empty.status).toBe(421);
  });

  it('多级子域 → 421（a.b.smes.example.com 非单级子域，invalid-subdomain）', async () => {
    const multi = await getWithHost(port, 'a.b.smes.example.com');
    expect(multi.status).toBe(421);
  });
});
