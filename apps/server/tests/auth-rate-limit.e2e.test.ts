/**
 * 登录速率限制 e2e（M2 安全前置批 SP-1 验证项：连发失败→429→短窗过期→恢复 201）。
 *
 * 真实 HTTP 起停（boot.e2e.test.ts 同构路径）：注入短窗 LoginAttemptStore
 * （2 次失败 / 60s 计数窗 / 2s 锁定——构造覆写，合同"参数可注入"面），
 * dev 身份回落 + 策略注入钩子建管理员，org 端点建真实用户后走完整登录链：
 *   错口令 401 → 401 → 第 3 次（正确口令）429（锁定期一律拒——不可探测绕过）
 *   → 等锁到期（2.2s）→ 正确口令 201（成功清零计数）。
 */
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { InMemoryLoginAttemptStore, TenantContext } from '@smes/application';
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
import { ColumnPreferenceErrorFilter } from '../src/column-preference-error.filter.js';

const OPERATOR = 'user-seed-admin';
const HEADERS = { 'x-smes-user': OPERATOR, 'content-type': 'application/json' };

/** 短窗限流参数：2 次失败 / 60s 计数窗 / 2s 锁定。 */
const SHORT_WINDOW = { maxFailures: 2, windowMs: 60_000, lockMs: 2_000 };

let app: INestApplication;
let baseUrl: string;

/** 环境改写恢复登记（boot.e2e 同体例）。 */
const savedEnv = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  setEnv('MODULES_ENABLED', undefined);
  setEnv('DATABASE_URL', undefined); // 零 DB：内存回落 + 注入短窗限流存储
  setEnv('SMES_DEV_AUTH', 'on');
  setEnv('SMES_DEV_POLICY_ENDPOINT', 'on');

  const enabled = parseModulesEnabled(process.env['MODULES_ENABLED']);
  app = (await NestFactory.create(
    buildAppModule(enabled, {
      devPolicyEndpoint: true,
      loginAttemptStore: new InMemoryLoginAttemptStore(SHORT_WINDOW),
    }),
    { logger: ['error', 'warn'] },
  )) as INestApplication;
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
    new ColumnPreferenceErrorFilter(),
  );
  const tenantContext = app.get(TenantContext);
  app.use((request: unknown, _response: unknown, next: () => void) => {
    tenantContext.run(tenantContext.resolve(request), () => next());
  });
  await app.listen(0);
  const { port } = app.getHttpServer().address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  // 管理员授权（dev 策略钩子）：org 建号面可用
  const granted = await fetch(`${baseUrl}/dev/policies`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      rules: [{ kind: 'grant-role', tenant: 'default', user: OPERATOR, role: 'admin' }],
    }),
  });
  expect(granted.status).toBe(200);
}, 30_000);

afterAll(async () => {
  await app.close();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function login(username: string, password: string): Promise<Response> {
  return fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

describe('登录速率限制（短窗注入：2 次失败 / 60s 窗 / 2s 锁）', () => {
  it('连发失败→429（正确口令也拒）→锁到期→恢复 201', async () => {
    // 真实用户经 org 端点建号（SP-4 策略下的合规口令，长度 ≥ 8）
    const created = await fetch(`${baseUrl}/org/users`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        username: 'rate-limit-user',
        displayName: '限流探针',
        password: 'e2e-secret-9',
      }),
    });
    expect(created.status, `建号：${await created.text()}`).toBe(201);

    // 前两次失败：凭据拒绝 401（message 与既有语义一致）
    const first = await login('rate-limit-user', 'wrong-pass');
    expect(first.status).toBe(401);
    const second = await login('rate-limit-user', 'wrong-pass');
    expect(second.status).toBe(401);
    expect(((await second.json()) as { message: string }).message).toBe('用户名或口令不正确');

    // 第三次（正确口令）：429 固定文案（锁定期一律拒——不可探测绕过）
    const third = await login('rate-limit-user', 'e2e-secret-9');
    expect(third.status).toBe(429);
    const thirdBody = (await third.json()) as { statusCode: number; message: string };
    expect(thirdBody.message).toBe('登录尝试过于频繁，请稍后再试');
    expect(thirdBody.statusCode).toBe(429);

    // 短窗过期（锁 2s）后：正确口令恢复 201（成功清零计数）
    await delay(2_200);
    const recovered = await login('rate-limit-user', 'e2e-secret-9');
    const recoveredText = await recovered.text();
    expect(recovered.status, `恢复登录：${recoveredText}`).toBe(201);
    const recoveredBody = JSON.parse(recoveredText) as { token: string; user: { username: string } };
    expect(recoveredBody.user.username).toBe('rate-limit-user');
    expect(recoveredBody.token.length).toBeGreaterThanOrEqual(43);
  }, 30_000);
});
