/**
 * D-11 HTTP 层 e2e：发起审批指定不存在审批人 → 400 的组合根映射锚定。
 *
 * 服务层行为已由 application/tests/approval.test.ts 锚定（ApprovalInputError、
 * 拒绝发生在任何落账之前、与"停用/他租户"同错误形态）；本文件补端到端断言
 * （历史欠账：400 只有服务层锚定，ApprovalErrorFilter 的映射无自动化锚）——
 * 真实 HTTP 栈（Nest 容器 + express + 全域错误过滤器）下：
 *   1. 对照组：审批人为本租户活动用户 → 201 建案（目录接线真实生效，非全拒）；
 *   2. D-11：审批人清单含不存在用户 → 400 + 域过滤器同形 JSON 体（statusCode +
 *      指名道姓的消息），且案件列表零新增（拒绝先于任何落账）。
 *
 * 装配与 main.ts 同构（main.ts import 即自启、无句柄可关，故测试内复刻，同
 * boot.e2e.test.ts 纪律）：默认模块（org+approval 均在默认装配，零 DB 下经
 * app-registry sharedUserStore 同一内存实例——org 建号与 approval 目录校验
 * 同源）+ 全域错误过滤器 + 租户中间件。鉴权走 dev 身份回落 + admin 角色
 * bypass（SMES_DEV_AUTH=on + POST /dev/policies——测试钩子，生产形态不开，
 * 见 dev-policy.controller.ts）。
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
const OPERATOR = 'u-approval-dir-e2e';
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

describe('D-11 审批人目录 → 400（真实 HTTP 栈 + ApprovalErrorFilter）', () => {
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
    setEnv('MODULES_ENABLED', undefined); // 默认装配：org + approval 均在（DEFAULT_MODULES_ENABLED）
    setEnv('DATABASE_URL', undefined); // 零 DB：sharedUserStore 内存实例（org 与 approval 同源）
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

  it('对照组：审批人为本租户活动用户 → 201 建案（目录接线生效，非全拒）', async () => {
    // 管理员经 org 端点建审批人账户——零 DB 下 org 与 approval 经 buildAppModule
    // 的 sharedUserStore 同一实例，审批人目录读到同一事实源。
    const created = await post(baseUrl, '/org/users', {
      username: 'approver-real',
      displayName: '在册审批人',
    });
    expect(created.status, `建审批人：${JSON.stringify(created.body)}`).toBe(201);
    const approverId = created.body['id'] as string;
    expect(typeof approverId).toBe('string');

    const started = await post(baseUrl, '/approval/cases', {
      subjectRef: { type: 'item', id: 'item-d11-e2e' },
      approvers: [approverId],
      reason: 'D-11 对照组：审批人为本租户活动用户',
    });
    expect(started.status, `发起审批：${JSON.stringify(started.body)}`).toBe(201);
    const startedCase = started.body['case'] as { state: string };
    expect(startedCase.state).toBe('in_review');
  });

  it('D-11：审批人清单含不存在用户 → 400（ApprovalErrorFilter 映射 ApprovalInputError）；不建案', async () => {
    // 已知用户 + 幽灵用户混合名单：逐人校验对清单中任一不满足即整单拒绝。
    const created = await post(baseUrl, '/org/users', {
      username: 'approver-mixed',
      displayName: '混合名单在册审批人',
    });
    expect(created.status).toBe(201);
    const approverId = created.body['id'] as string;

    const before = (await (
      await fetch(`${baseUrl}/approval/cases`, { headers: HEADERS })
    ).json()) as { cases: unknown[] };

    const refused = await fetch(`${baseUrl}/approval/cases`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        subjectRef: { type: 'item', id: 'item-d11-e2e' },
        approvers: [approverId, 'user-ghost-d11'],
        reason: 'D-11：清单含不存在审批人',
      }),
    });
    expect(refused.status).toBe(400);
    const body = JSON.parse(await refused.text()) as { statusCode: number; message: string };
    expect(body.statusCode).toBe(400); // 域过滤器同形 JSON 体
    expect(body.message).toContain('user-ghost-d11'); // 指名道姓到幽灵 id，管理员可定位
    expect(body.message).toContain('不存在或不可用');

    // 拒绝发生在任何落账之前：案件列表零新增（服务层合同的 HTTP 面复证）
    const after = (await (
      await fetch(`${baseUrl}/approval/cases`, { headers: HEADERS })
    ).json()) as { cases: unknown[] };
    expect(after.cases.length).toBe(before.cases.length);
  });
});
