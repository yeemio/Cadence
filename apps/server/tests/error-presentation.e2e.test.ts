/**
 * 错误呈现 focused e2e（UX 缺陷批 UX-VW-04 / UX-VW-03 / UX-WH-13）：
 * NavigationErrorFilter 的形态分流 + AuthGuard 401 文案去内部开关名。
 *
 * 被测行为（只读回，不改鉴权判定/状态码）：
 *  1. API 形态（Accept 无 text/html）：401/404 保持 Nest 默认 JSON 体（零回归——
 *     web apiClient 读 body.message），且 401 文案不再出现 dev/test 回落开关名
 *     等技术细节；
 *  2. 浏览器文档导航（Accept 含 text/html）：401/404 渲染中文可读 HTML 错误页，
 *     正文无内部开关名、无英文技术串（"Cannot GET"）。
 *
 * 与 boot.e2e 的区别：boot.e2e 验证装配面（全过滤器同构 main.ts）；本文件只装
 * NavigationErrorFilter（被测单元本身），探针路径用 /approval/cases（默认六模块
 * 内、与页面路由同名撞车的 API 路由先例）与 /workorders（无同名 API 路由的
 * 深链未知路径）——两形态即真实深链缺陷的 server 侧复刻。
 *
 * 文件命名 *.e2e.test.ts：命中 vitest 默认 include，`pnpm test` 收录。
 */
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { TenantContext } from '@smes/application';
import { buildAppModule, parseModulesEnabled } from '../src/app-registry.js';
import { NavigationErrorFilter } from '../src/navigation-error.filter.js';

/** 本文件起过的全部应用：afterAll 统一 close，保证不留孤儿端口。 */
const bootedApps: INestApplication[] = [];
/** 起服后的 baseUrl（listen(0) 随机端口），由首个用例赋值。 */
let baseUrl = '';

/**
 * 起服路径（boot.e2e bootApp 同构，只装被测过滤器）：组合根模块 → TenantContext
 * 中间件 → NavigationErrorFilter → listen(0)（OS 分配随机空闲端口）。
 */
async function bootApp(): Promise<string> {
  const enabled = parseModulesEnabled(process.env['MODULES_ENABLED']);
  const app = (await NestFactory.create(buildAppModule(enabled), {
    logger: ['error', 'warn'],
    bodyParser: false,
  })) as NestExpressApplication;
  app.useGlobalFilters(new NavigationErrorFilter());
  const tenantContext = app.get(TenantContext);
  app.use((request: unknown, _response: unknown, next: () => void) => {
    tenantContext.run(tenantContext.resolve(request), () => next());
  });
  await app.listen(0);
  bootedApps.push(app);
  const { port } = app.getHttpServer().address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('错误呈现：导航/API 形态分流（401/404）', () => {
  /** 被改写过的环境变量 → 原值，afterAll 恢复。 */
  const savedEnv = new Map<string, string | undefined>();

  function setEnv(name: string, value: string | undefined): void {
    if (!savedEnv.has(name)) {
      savedEnv.set(name, process.env[name]);
    }
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  afterAll(async () => {
    for (const app of bootedApps) {
      await app.close();
    }
    for (const [name, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it('生产默认形态起服（SMES_DEV_AUTH 关闭、零 DB）', async () => {
    setEnv('MODULES_ENABLED', undefined);
    setEnv('DATABASE_URL', undefined);
    setEnv('SMES_DEV_AUTH', undefined); // 生产默认形态：dev 身份回落关闭
    baseUrl = await bootApp();
    expect(bootedApps.length).toBe(1);
  });

  it('API 形态 401：Nest 默认 JSON 体透传，文案为中文登录指引且无内部开关名', async () => {
    const response = await fetch(`${baseUrl}/approval/cases`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { statusCode: number; message: unknown };
    expect(body.statusCode).toBe(401);
    expect(typeof body.message).toBe('string');
    const message = String(body.message);
    expect(message).toContain('登录');
    expect(message).not.toContain('SMES_DEV_AUTH'); // 内部开关名不再泄漏
    expect(message).not.toContain('Bearer'); // 协议头等技术细节不再出现在用户文案
  });

  it('导航形态 401（撞名 API 路由深链）：中文 HTML 错误页，无开关名无英文技术串', async () => {
    const response = await fetch(`${baseUrl}/approval/cases`, {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    expect(response.status).toBe(401); // 状态语义原样保留（M2 域不动）
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('需要登录');
    expect(html).toContain('登录');
    expect(html).not.toContain('SMES_DEV_AUTH');
    expect(html).not.toContain('Bearer');
    expect(html).not.toContain('Unauthorized');
  });

  it('导航形态 404（未知路径深链）：中文 HTML 错误页，无 Cannot GET 技术串', async () => {
    const response = await fetch(`${baseUrl}/workorders`, {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    expect(response.status).toBe(404); // 状态语义原样保留（M2 域不动）
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('页面不存在');
    expect(html).not.toContain('Cannot GET');
    expect(html).not.toContain('SMES_DEV_AUTH');
    expect(html).not.toContain('Not Found');
  });

  it('API 形态 404（未知路径）：Nest 默认 JSON 体透传（API 消费方零回归）', async () => {
    const response = await fetch(`${baseUrl}/workorders`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { statusCode: number; message: string };
    expect(body.statusCode).toBe(404);
    expect(body.message).toContain('Cannot GET /workorders'); // Nest 默认体原样
  });
});
