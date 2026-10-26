/**
 * hasPassword 只读投影 HTTP 层 e2e（D-2 验收登记 P3 的组合根锚定）。
 *
 * 投影语义：UserAccount 视图带 passwordHash 非空的派生布尔——管理员经
 * GET /org/users 区分"未设口令"用户（不能登录、待首设）；哈希本体绝不出
 * 响应（认证专用，只在 findByUsername 凭据视图出现）。服务层投影已由
 * application/tests/org.test.ts 锚定；本文件锚 HTTP 面：
 *   1. 三视图投影一致：建号单用户视图（POST /org/users 详情返回）、列表行
 *      （GET /org/users）、首设/重置单用户视图（PUT /org/users/:id/password）；
 *   2. 哈希不出响应：原始响应体无 passwordHash 字段名、无 scrypt 哈希形态、
 *      无明文口令——以"该口令可登录"做差分证明：投影依据（存储侧哈希）真实
 *      存在，泄漏物不在响应里。
 *
 * 装配与 main.ts 同构（boot.e2e.test.ts 纪律）：默认模块 + 全域错误过滤器 +
 * 零 DB 内存存储；鉴权走 dev 身份回落 + admin 角色 bypass（测试钩子，生产
 * 形态不开）。
 */
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { TenantContext } from '@smes/application';
import { buildAppModule, parseModulesEnabled } from '../src/app-registry.js';
import { ApprovalErrorFilter } from '../src/approval-error.filter.js';
import { AuthErrorFilter } from '../src/auth-error.filter.js';
import { BaselineErrorFilter } from '../src/baseline-error.filter.js';
import { CostingErrorFilter } from '../src/costing-error.filter.js';
import { DrawingErrorFilter } from '../src/drawing-error.filter.js';
import { MaintenanceErrorFilter } from '../src/maintenance-error.filter.js';
import { MetricPackErrorFilter } from '../src/metric-pack-error.filter.js';
import { PayrollErrorFilter } from '../src/payroll-error.filter.js';
import { DispatchErrorFilter } from '../src/dispatch-error.filter.js';
import { DomainErrorFilter } from '../src/domain-error.filter.js';
import { HoursErrorFilter } from '../src/hours-error.filter.js';
import { ReportErrorFilter } from '../src/report-error.filter.js';
import { InspectionErrorFilter } from '../src/inspection-error.filter.js';
import { InventoryErrorFilter } from '../src/inventory-error.filter.js';
import { ListingErrorFilter } from '../src/listing-error.filter.js';
import { OrgErrorFilter } from '../src/org-error.filter.js';
import { WorkOrderErrorFilter } from '../src/workorder-error.filter.js';
import { BackfillErrorFilter } from '../src/backfill-error.filter.js';
import { CapabilityErrorFilter } from '../src/capability-error.filter.js';
import { UWaveErrorFilter } from '../src/u-wave-error.filter.js';

/** dev 身份（grant admin 角色 → 域内全权限码 bypass）。 */
const OPERATOR = 'u-org-projection-e2e';
const HEADERS = {
  'content-type': 'application/json',
  'x-smes-user': OPERATOR,
};

const bootedApps: INestApplication[] = [];

/** main.ts bootstrap 同构起服（默认模块 + 全域过滤器 + 租户中间件；零 DB）。 */
async function bootApp(): Promise<string> {
  const app = await NestFactory.create(
    buildAppModule(parseModulesEnabled(undefined), { devPolicyEndpoint: true }),
    { logger: ['error', 'warn'] },
  );
  app.useGlobalFilters(
    new OrgErrorFilter(),
    new AuthErrorFilter(),
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

interface UserRowView {
  readonly id: string;
  readonly username: string;
  readonly hasPassword: boolean;
}

async function post(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('hasPassword 只读投影（D-2 P3：管理员区分未设口令用户；哈希不出响应）', () => {
  let baseUrl = '';
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

  beforeAll(async () => {
    setEnv('MODULES_ENABLED', undefined); // 默认装配（org 在默认模块清单）
    setEnv('DATABASE_URL', undefined); // 零 DB：内存回落
    setEnv('SMES_DEV_AUTH', 'on'); // dev 身份回落（测试钩子）
    setEnv('SMES_DEV_POLICY_ENDPOINT', 'on'); // 策略注入钩子（与 devPolicyEndpoint 选项同 main.ts 语义）
    baseUrl = await bootApp();

    const granted = await post(baseUrl, '/dev/policies', {
      rules: [{ kind: 'grant-role', tenant: 'default', user: OPERATOR, role: 'admin' }],
    });
    expect(granted.status).toBe(200);
    expect(granted.body).toEqual({ applied: 1 });
  }, 30_000);

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

  it('三视图投影一致：建号详情 false/true → 列表行 → 首设口令后翻转', async () => {
    // ---- 建号单用户视图（POST /org/users 详情返回）----
    const bare = await post(baseUrl, '/org/users', {
      username: 'e2e-bare',
      displayName: '未设口令建号',
    });
    expect(bare.status, `建号（未带口令）：${JSON.stringify(bare.body)}`).toBe(201);
    expect(bare.body.hasPassword).toBe(false); // 未设口令态：不能登录，管理员待首设

    const withPass = await post(baseUrl, '/org/users', {
      username: 'e2e-with-pass',
      displayName: '带初始口令建号',
      password: 'e2e-init-pass',
    });
    expect(withPass.status, `建号（带初始口令）：${JSON.stringify(withPass.body)}`).toBe(201);
    expect(withPass.body.hasPassword).toBe(true);

    // ---- 列表行（GET /org/users）：管理员按行区分 ----
    const listBody = (await (
      await fetch(`${baseUrl}/org/users`, { headers: HEADERS })
    ).json()) as { users: UserRowView[] };
    const byName = new Map(listBody.users.map((row) => [row.username, row]));
    expect(byName.get('e2e-bare')?.hasPassword).toBe(false);
    expect(byName.get('e2e-with-pass')?.hasPassword).toBe(true);

    // ---- 首设口令（PUT /org/users/:id/password 单用户视图）→ 投影翻转 ----
    const bareId = bare.body['id'] as string;
    const firstSet = await fetch(`${baseUrl}/org/users/${bareId}/password`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify({ password: 'e2e-first-pass' }),
    });
    expect(firstSet.status).toBe(200);
    expect(((await firstSet.json()) as UserRowView).hasPassword).toBe(true);

    const listAfter = (await (
      await fetch(`${baseUrl}/org/users`, { headers: HEADERS })
    ).json()) as { users: UserRowView[] };
    expect(listAfter.users.find((row) => row.username === 'e2e-bare')?.hasPassword).toBe(true);
  });

  it('哈希不出响应：账户视图无 passwordHash 字段名 / scrypt 串 / 明文口令（登录差分证明投影依据真实）', async () => {
    // ---- 投影依据真实存在：带口令建号 → 该口令可登录（服务端确有 scrypt 哈希）----
    const created = await post(baseUrl, '/org/users', {
      username: 'e2e-hash-probe',
      displayName: '哈希泄漏探针',
      password: 'e2e-plain-secret',
    });
    expect(created.status).toBe(201);
    expect(created.body.hasPassword).toBe(true);
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'e2e-hash-probe', password: 'e2e-plain-secret' }),
    });
    expect(login.status, '该口令可登录 = 存储侧确有哈希（投影非空穴）').toBe(201);

    // ---- 但 GET /org/users 原始响应体：投影字段在场，泄漏物三不 ----
    const rawList = await (await fetch(`${baseUrl}/org/users`, { headers: HEADERS })).text();
    expect(rawList).toContain('hasPassword'); // 先证投影在场（差分锚），再证泄漏物不在
    expect(rawList).not.toContain('passwordHash');
    expect(rawList).not.toContain('scrypt$');
    expect(rawList).not.toContain('e2e-plain-secret');

    // ---- 单用户详情视图同口径（PUT password 返回的 UserAccount）----
    const probeId = created.body['id'] as string;
    const rawReset = await (
      await fetch(`${baseUrl}/org/users/${probeId}/password`, {
        method: 'PUT',
        headers: HEADERS,
        body: JSON.stringify({ password: 'e2e-reset-secret' }),
      })
    ).text();
    expect(rawReset).toContain('hasPassword');
    expect(rawReset).not.toContain('passwordHash');
    expect(rawReset).not.toContain('scrypt$');
    expect(rawReset).not.toContain('e2e-reset-secret');
  });
});
