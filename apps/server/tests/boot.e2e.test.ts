/**
 * Boot smoke（M1 增量 3-H）：CI 里机器验证 boot 行为——真实起 Nest 应用
 * （随机端口）→ HTTP 读回核心端点 → afterAll 干净关闭。进 verify 测试链
 * （`pnpm --filter @smes/server test` → 根 `pnpm verify` 的 test 步）。
 *
 * 与 app-registry.test.ts（纯单测）的区别：本文件走完整组合根路径
 * 注册表 → Nest 容器 → express HTTP → node fetch 读回，验证"装配结果真的
 * 能起服务且路由可达"，而非仅注册表数据结构。
 *
 * 零 DB 性质（ADR-0004 基础层）：装配路径不触达 business-store/Prisma，
 * 显式不设 DATABASE_URL 仍可起服——此用例把该性质变成机器断言。
 *
 * 文件命名 *.e2e.test.ts：命中 vitest 默认 include（任意路径下的 *.test.ts），
 * 无需任何 vitest 配置即被 `pnpm test` 收录，同时与单测肉眼可分。
 */
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { TenantContext } from '@smes/application';
import { buildAppModule, parseModulesEnabled } from '../src/app-registry.js';
import { ApprovalErrorFilter } from '../src/approval-error.filter.js';
import { AuthErrorFilter } from '../src/auth-error.filter.js';
import { NavigationErrorFilter } from '../src/navigation-error.filter.js';
import { BaselineErrorFilter } from '../src/baseline-error.filter.js';
import { CostingErrorFilter } from '../src/costing-error.filter.js';
import { DrawingErrorFilter } from '../src/drawing-error.filter.js';
import { MaintenanceErrorFilter } from '../src/maintenance-error.filter.js';
import { MetricPackErrorFilter } from '../src/metric-pack-error.filter.js';
import { PayrollErrorFilter } from '../src/payroll-error.filter.js';
import { DispatchErrorFilter } from '../src/dispatch-error.filter.js';
import { HoursErrorFilter } from '../src/hours-error.filter.js';
import { ReportErrorFilter } from '../src/report-error.filter.js';
import { DomainErrorFilter } from '../src/domain-error.filter.js';
import { InspectionErrorFilter } from '../src/inspection-error.filter.js';
import { InventoryErrorFilter } from '../src/inventory-error.filter.js';
import { ListingErrorFilter } from '../src/listing-error.filter.js';
import { OrgErrorFilter } from '../src/org-error.filter.js';
import { WorkOrderErrorFilter } from '../src/workorder-error.filter.js';
import { BackfillErrorFilter } from '../src/backfill-error.filter.js';
import { CapabilityErrorFilter } from '../src/capability-error.filter.js';
import { UWaveErrorFilter } from '../src/u-wave-error.filter.js';

/** 本文件起过的全部应用：afterAll 统一 close，保证不留孤儿端口。 */
const bootedApps: INestApplication[] = [];
const suiteStartAt = Date.now();

/**
 * 与 main.ts bootstrap 同构的起服路径（main.ts import 即自启、无句柄可关，
 * 故在测试内复刻同一装配序列）：解析 flag → 组合根模块 → TenantContext
 * 中间件 → listen(0)（OS 分配随机空闲端口）。
 * 唯一偏差：只保留 error/warn 级日志（绿时零输出，红时保留 ExceptionsHandler
 * 堆栈供 CI 排障；被测的是装配与路由，不是启动横幅）。
 */
async function bootApp(): Promise<string> {
  const enabled = parseModulesEnabled(process.env['MODULES_ENABLED']);
  // bodyParser:false + 重注册（main.ts U6 #⑥ 同构——attachment 上传传输面 45MiB）。
  const app = (await NestFactory.create(buildAppModule(enabled), {
    logger: ['error', 'warn'],
    bodyParser: false,
  })) as NestExpressApplication;
  app.useBodyParser('json', { limit: '45mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '45mb' });

  // 域错误过滤器与 main.ts 同构（收尾波-③ 起含 AuthErrorFilter——
  // 认证域错误 400/401 的映射是组合根装配的一部分，boot 路径不可缺；
  // U6 起含 Backfill/Capability/UWave 三聚合过滤器）。
  app.useGlobalFilters(
    new OrgErrorFilter(),
    new AuthErrorFilter(),
    new NavigationErrorFilter(),
    new DomainErrorFilter(),
    new ApprovalErrorFilter(),
    new BaselineErrorFilter(),
    new WorkOrderErrorFilter(),
    new ListingErrorFilter(),
    new InspectionErrorFilter(),
    new InventoryErrorFilter(),
    new DispatchErrorFilter(),
    new ReportErrorFilter(),
    new HoursErrorFilter(),
    new CostingErrorFilter(),
    new PayrollErrorFilter(),
    new MaintenanceErrorFilter(),
    new DrawingErrorFilter(),
    new MetricPackErrorFilter(),
    new BackfillErrorFilter(),
    new CapabilityErrorFilter(),
    new UWaveErrorFilter(),
  );

  const tenantContext = app.get(TenantContext);
  app.use((request: unknown, _response: unknown, next: () => void) => {
    tenantContext.run(tenantContext.resolve(request), () => next());
  });

  await app.listen(0);
  bootedApps.push(app);
  const { port } = app.getHttpServer().address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('boot smoke（真实 HTTP 起停，零 DB 装配）', () => {
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
    console.log(
      `[boot.e2e] ${bootedApps.length} 个应用起停（listen(0) 随机端口），套件耗时 ${Date.now() - suiteStartAt}ms`,
    );
  });

  it('默认装配零 DB 起 HTTP：/health、/modules 含 core+approval+demo、/demo/ping 200、审批路由门禁照常', async () => {
    setEnv('MODULES_ENABLED', undefined); // 显式缺省 → 默认装配（六模块，M1 收尾波-①）
    setEnv('DATABASE_URL', undefined); // 启动零 DB：不设 DATABASE_URL 也要能起
    setEnv('SMES_DEV_AUTH', undefined); // 生产默认形态：dev 身份回落关闭
    const baseUrl = await bootApp();

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', tenant: 'default' });

    const modules = await fetch(`${baseUrl}/modules`);
    expect(modules.status).toBe(200);
    const modulesBody = (await modules.json()) as { modules: string[] };
    expect(modulesBody.modules).toEqual(
      expect.arrayContaining(['core', 'approval', 'demo']),
    );

    const ping = await fetch(`${baseUrl}/demo/ping`);
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ module: 'demo', pong: true });

    // 审批模块已装配：受保护路由无凭据 → 401（收尾波-③ 起 401/403 分离：
    // 缺/坏 token = 401；身份有效但无权限 = 403——此处验证缺凭据路径）。
    const approval = await fetch(`${baseUrl}/approval/cases`);
    expect(approval.status).toBe(401);

    // dev 身份头在生产默认形态被完全忽略（无 Bearer → 仍 401）。
    const devHeaderRejected = await fetch(`${baseUrl}/approval/cases`, {
      headers: { 'x-smes-user': 'user-seed-admin' },
    });
    expect(devHeaderRejected.status).toBe(401);

    // 认证端点已装配（auth 恒装配）：零 DB 无种子用户 → 登录拒绝 401。
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'demo-password' }),
    });
    expect(login.status).toBe(401);
    // 输入形状违规是 400 不是 401（AuthErrorFilter 装配证据）。
    const badLogin = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: '', password: 'x' }),
    });
    expect(badLogin.status).toBe(400);
  });

  it('SMES_DEV_AUTH=on：dev 身份头回落可用（既有 e2e 形状，内存策略下 viewer 仍 403）', async () => {
    setEnv('MODULES_ENABLED', undefined);
    setEnv('DATABASE_URL', undefined);
    setEnv('SMES_DEV_AUTH', 'on');
    const baseUrl = await bootApp();

    // 无策略身份经 dev 头进入 → 身份有效但无权限 = 403（门禁照常）。
    const viewer = await fetch(`${baseUrl}/org/users`, {
      headers: { 'x-smes-user': 'user-seed-viewer' },
    });
    expect(viewer.status).toBe(403);
    // 无任何身份 → 401。
    const anonymous = await fetch(`${baseUrl}/org/users`);
    expect(anonymous.status).toBe(401);
  });

  it('MODULES_ENABLED=core：/modules=["core"] 且 demo 路由 404（flag 真实生效）', async () => {
    setEnv('MODULES_ENABLED', 'core');
    setEnv('DATABASE_URL', undefined);
    setEnv('SMES_DEV_AUTH', undefined); // 上一用例开过的回落在此复位（生产默认形态）
    const baseUrl = await bootApp();

    const modules = await fetch(`${baseUrl}/modules`);
    expect(modules.status).toBe(200);
    expect(await modules.json()).toEqual({ modules: ['core'] });

    const ping = await fetch(`${baseUrl}/demo/ping`);
    expect(ping.status).toBe(404);
  });

  it('MODULES_ENABLED=core+M2 九模块+M3 四专业包全集：全环节装配，路由可达且门禁同构（含三包 401 探针）', async () => {
    setEnv(
      'MODULES_ENABLED',
      'core,workorder,baseline,listing,inspection,inventory,dispatch,reporting,hours,costing,payroll,maintenance,drawing,metric-pack',
    );
    setEnv('DATABASE_URL', undefined); // 零 DB：M2 环节模块 + M3 专业包内存回落可起服
    setEnv('SMES_DEV_AUTH', undefined);
    const baseUrl = await bootApp();

    const modules = await fetch(`${baseUrl}/modules`);
    expect(modules.status).toBe(200);
    expect(await modules.json()).toEqual({
      modules: [
        'core',
        'workorder',
        'baseline',
        'listing',
        'inspection',
        'inventory',
        'dispatch',
        'reporting',
        'hours',
        'costing',
        'payroll',
        'maintenance',
        'drawing',
        'metric-pack',
      ],
    });

    // 各模块受保护路由：无凭据 → 401（M2 模块群门禁与既有模块同构）
    expect((await fetch(`${baseUrl}/workorder/work-orders`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/baseline/processes`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/listing/sheets`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/inspection/orders`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/inventory/stock`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/dispatch/orders`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/reports`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/hours/my`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/costing/models`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/payroll/rules`)).status).toBe(401);
    // M3 三包探针（每路由必挂 @RequirePermission——payroll 漏挂教训的回归防线）
    expect((await fetch(`${baseUrl}/maintenance/tasks`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/drawing/notices/dwg-probe`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/metric-pack/packs`)).status).toBe(401);
  });

  it('U6：issue/aftercare-claim + T1 三域全装，零 DB 起服且路由门禁同构（含 45MiB 传输面）', async () => {
    setEnv(
      'MODULES_ENABLED',
      'core,workbench,workorder,dispatch,inventory,reporting,issue,aftercare-claim,attachment,menu-config,notifications,approval-config',
    );
    setEnv('DATABASE_URL', undefined); // 零 DB：U 波模块 + T1 三域内存回落可起服
    setEnv('SMES_DEV_AUTH', undefined);
    const baseUrl = await bootApp();

    // attachment.controllers.ts 的 import type 缺陷已由总控修复（值导入，Nest DI
    // 元数据恢复）——模块进全装场景清单，路由探针回归。
    const modules = await fetch(`${baseUrl}/modules`);
    expect(modules.status).toBe(200);
    expect(await modules.json()).toEqual({
      modules: [
        'core',
        'workbench',
        'workorder',
        'dispatch',
        'inventory',
        'reporting',
        'issue',
        'aftercare-claim',
        'attachment',
        'menu-config',
        'notifications',
        'approval-config',
      ],
    });

    // U 波两模块路由探针（无凭据 → 401——每路由必挂 @RequirePermission 同构门禁）
    expect((await fetch(`${baseUrl}/issue/tasks`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/dispatch/aftercare/claims/context?dispatchId=dsp-1`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/attachment/list-by-biz-id?bizId=biz-1`)).status).toBe(401);
    // T1 三域路由探针（M1 线已接，此处回归防线——全装形态下与 U 波模块共存）
    expect((await fetch(`${baseUrl}/menu-config/configs`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/notifications`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/approval-config/flows`)).status).toBe(401);

    // 传输面护栏（U6 #⑥）：45MiB json parser 装配证据——>100kb 的合法 JSON
    // 载荷不被内建 100kb 拒绝（业务上限另由 attachment-input 把关，此处只证
    // 传输面放宽生效；~1MiB 载荷足够区分 100kb 默认与 45mb 限额）。
    const bigPayload = await fetch(`${baseUrl}/issue/tasks/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }),
    });
    expect(bigPayload.status).toBe(401); // 门禁先于 body 解析语义——但 413（Payload Too Large）不得出现
  });
});
