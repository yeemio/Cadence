/**
 * fix-wave-3 W3-1 组合态 e2e：listing 收货→inspection 三类采购质检（接线 #37）。
 *
 * 独立 app（core+listing+inspection 子集装配，沿 capability-modules.e2e 体例）：
 * 全装配形态下 #14 listing.receiptPort 接线后，inventory 服务未配置
 * defaultWarehouseCode（本场景装配不含 inventory 模块）→ 收货命令被入库指令端口
 * 先行拒绝，无法走到 intake——本场景聚焦 intake 接线语义，装配面不含 inventory
 * （receipt 端口回落模块缺省恒放行；入库指令链路由 application/inventory 既有
 * 测试覆盖）。零 DB 真实起服：Nest 组合根 → bindCrossModuleWiring 迟到绑定 →
 * HTTP 驱动 申请→订单 submit→approve→issue→receive → inspection 查询面断言
 * standard_purchase 待检单出现（RQ-019，PRD 14 §6"收货事实携带 kind 显式"）。
 */
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { TenantContext } from '@smes/application';
import { bindCrossModuleWiring } from '../src/cross-module-wiring.js';
import { buildAppModule, parseModulesEnabled } from '../src/app-registry.js';
import { AuthErrorFilter } from '../src/auth-error.filter.js';
import { DomainErrorFilter } from '../src/domain-error.filter.js';
import { ListingErrorFilter } from '../src/listing-error.filter.js';
import { InspectionErrorFilter } from '../src/inspection-error.filter.js';
import { OrgErrorFilter } from '../src/org-error.filter.js';

/** dev 身份（grant admin 角色 → 全权限码 bypass）。 */
const OPERATOR = 'u-op-w3-receipt';
const HEADERS = {
  'content-type': 'application/json',
  'x-smes-user': OPERATOR,
};

let operationCounter = 0;
function opId(prefix: string): string {
  operationCounter += 1;
  return `w3-receipt-e2e-${prefix}-${operationCounter}`;
}

function envelope(kind: string, payload: unknown, expectedRevision: 'initial' | number = 'initial'): string {
  return JSON.stringify({
    operationId: opId(kind),
    expectedRevision,
    command: { kind, payload },
  });
}

interface OutcomeShape {
  readonly status?: string;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

async function post(baseUrl: string, path: string, body: string): Promise<{ status: number; body: OutcomeShape }> {
  const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: HEADERS, body });
  return { status: response.status, body: (await response.json()) as OutcomeShape };
}

async function getJson(baseUrl: string, path: string): Promise<OutcomeShape> {
  const response = await fetch(`${baseUrl}${path}`, { headers: HEADERS });
  return (await response.json()) as OutcomeShape;
}

describe('fix-wave-3 W3-1：收货→三类采购质检组合态（listing+inspection 装配，#37）', () => {
  let baseUrl = '';
  const savedEnv = new Map<string, string | undefined>();
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;

  function setEnv(name: string, value: string | undefined): void {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  beforeAll(async () => {
    setEnv('MODULES_ENABLED', 'core,listing,inspection');
    setEnv('DATABASE_URL', undefined); // 零 DB：组合根 wiring 全走内存共享实例
    setEnv('SMES_DEV_AUTH', 'on');
    setEnv('SMES_DEV_POLICY_ENDPOINT', 'on');

    const enabled = parseModulesEnabled(process.env['MODULES_ENABLED']);
    app = await NestFactory.create(buildAppModule(enabled, { devPolicyEndpoint: true }), {
      logger: ['error', 'warn'],
    });
    app.useGlobalFilters(
      new OrgErrorFilter(),
      new AuthErrorFilter(),
      new DomainErrorFilter(),
      new ListingErrorFilter(),
      new InspectionErrorFilter(),
    );
    const tenantContext = app.get(TenantContext);
    app.use((request: unknown, _response: unknown, next: () => void) => {
      tenantContext.run(tenantContext.resolve(request), () => next());
    });
    // 组合根构造后注入（与 main.ts 同构）：#37 listing.inspectionIntake 迟到绑定生效。
    bindCrossModuleWiring(app);
    await app.listen(0);
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    const granted = await post(
      baseUrl,
      '/dev/policies',
      JSON.stringify({ rules: [{ kind: 'grant-role', tenant: 'default', user: OPERATOR, role: 'admin' }] }),
    );
    expect(granted.status).toBe(200);
    expect(granted.body).toEqual({ applied: 1 });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('申请（standard）→订单 submit 承接→approve→issue→receive→standard_purchase 待检单出现', async () => {
    // ---- 环节 1：三类采购申请（kind=standard；itemId 为申请单物料匹配键）----
    const requested = await post(
      baseUrl,
      '/purchase/requests',
      envelope('purchase.request.create.v1', {
        workOrderId: 'wo-w3-rcpt',
        kind: 'standard',
        itemId: 'item-w3-std',
        quantity: 8,
      }),
    );
    expect(requested.status, `建申请：${JSON.stringify(requested.body)}`).toBe(201);
    expect(requested.body.status).toBe('committed');
    const request = requested.body['purchaseRequest'] as { id: string };

    // ---- 环节 2：订单提交承接申请（draft→submitted@v2）----
    const submitted = await post(
      baseUrl,
      '/purchase/orders',
      envelope('purchase.order.submit.v1', {
        workOrderId: 'wo-w3-rcpt',
        supplierRef: 'SUP-W3-RCPT',
        supplierName: 'W3 收货触发供应商',
        promisedAt: '2026-11-30T00:00:00.000Z',
        lines: [{ itemId: 'item-w3-std', quantity: 8, unitPriceMinor: 1200 }],
        requestIds: [request.id],
        buyer: OPERATOR,
        remark: null,
      }),
    );
    expect(submitted.status, `订单提交：${JSON.stringify(submitted.body)}`).toBe(201);
    expect(submitted.body.status).toBe('committed');
    const order = submitted.body['purchaseOrder'] as { id: string; state: string; objectVersion: number };
    expect(order.state).toBe('submitted');

    // ---- 环节 3：approve → issue（推进到可收货态）----
    const approved = await post(
      baseUrl,
      `/purchase/orders/${order.id}/approval`,
      envelope('purchase.order.approve.v1', { remark: 'W3 组合态审批' }, 2),
    );
    expect(approved.body.status, `审批：${JSON.stringify(approved.body)}`).toBe('committed');
    const issued = await post(
      baseUrl,
      `/purchase/orders/${order.id}/issue`,
      envelope('purchase.order.issue.v1', { remark: null }, 3),
    );
    expect(issued.body.status, `下发：${JSON.stringify(issued.body)}`).toBe('committed');

    // ---- 环节 4：收货（一次收货定稿；#37 intake 逐行投递）----
    const received = await post(
      baseUrl,
      `/purchase/orders/${order.id}/receipts`,
      envelope('purchase.order.receive.v1', { lines: [{ lineNo: 1, receivedQty: 8 }], receiptRef: 'RCPT-W3-01' }, 4),
    );
    expect(received.status, `收货：${JSON.stringify(received.body)}`).toBe(201);
    expect(received.body.status).toBe('committed');
    expect((received.body['purchaseOrder'] as { state: string }).state).toBe('received');

    // ---- 环节 5：inspection 出现 standard_purchase 待检单（来源=receipt，来源对象=订单#行号）----
    const queue = (await getJson(baseUrl, '/inspection/orders?kind=standard_purchase&state=pending'))['orders'] as {
      id: string;
      kind: string;
      state: string;
      sourceType: string | null;
      sourceRefId: string | null;
      itemId: string | null;
      quantity: number;
    }[];
    const triggered = queue.find((row) => row.sourceRefId === `${order.id}#1`);
    expect(triggered, `待检单读回：${JSON.stringify(queue)}`).toBeDefined();
    expect(triggered!.kind).toBe('standard_purchase');
    expect(triggered!.sourceType).toBe('receipt');
    expect(triggered!.itemId).toBe('item-w3-std');
    expect(triggered!.quantity).toBe(8);
  }, 60_000);
});
