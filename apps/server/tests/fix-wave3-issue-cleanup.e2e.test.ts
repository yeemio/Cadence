/**
 * fix-wave-3 W3-2 组合态 e2e：撤销派工→issue.cleanup 钩子（U6 #29 装饰器扩展）。
 *
 * 独立 app（core+workorder+dispatch+issue 子集装配，沿 fix-wave3-receipt-intake
 * 体例）：workorder 仅为装配派工的齐套放行记录而装（零需求行刷新即 complete，
 * listing/inventory 不装）；#29 装饰器经 storeOverrides.dispatchOrders 套用，
 * bindCrossModuleWiring 后 advance→cancelled 触发 issue.cleanup.v1。
 *
 * 场景：
 *  1. 显式 sync 造设备维任务 → 建装配派工→assigned→cancelled → 任务被清理
 *     （listTasks 空——清理确实经装饰器发生，未接线形态任务会残留）。
 *  2. 目标任务已非未开始（发料中）→ 撤销仍 committed（通知式不回滚）、任务
 *     保留（清理被拒 console.warn 路径）。
 *  3. 幂等：确定性 operationId `wiring-issue-cleanup:<dispatchId>` 重放 → issue
 *     侧 operations.record 拒重复（rejected 幂等冲突），重建的任务不被重复删账。
 *
 * 说明：demand 行源本波为空实现（app-registry 未注入），draft→assigned 的归拢
 * 同步不产生任务；设备维任务经显式同步面 POST /issue/tasks/sync（运维补发面，
 * 模块文件头注明的正式合同）造数。场景 2 的"已发料中"态经 ISSUE_TASK_STORE
 * 直接播种（issue 域状态机归 application 测试，此处只验接线语义）。
 */
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NestFactory } from '@nestjs/core';
import {
  ISSUE_TASK_STORE,
  IssueService,
  TenantContext,
  WORKORDER_KIT_STORE,
  newKitCheckId,
  type IssueCommand,
  type IssueTaskStore,
  type KitCheckStore,
} from '@smes/application';
import { OperationId, TenantId, UserId, WorkOrderId, makeCommandEnvelope } from '@smes/business-core';
import { bindCrossModuleWiring } from '../src/cross-module-wiring.js';
import { buildAppModule, parseModulesEnabled } from '../src/app-registry.js';
import { AuthErrorFilter } from '../src/auth-error.filter.js';
import { DomainErrorFilter } from '../src/domain-error.filter.js';
import { DispatchErrorFilter } from '../src/dispatch-error.filter.js';
import { OrgErrorFilter } from '../src/org-error.filter.js';
import { WorkOrderErrorFilter } from '../src/workorder-error.filter.js';

/** dev 身份（grant admin 角色 → 全权限码 bypass）。 */
const OPERATOR = 'u-op-w3-cleanup';
const HEADERS = {
  'content-type': 'application/json',
  'x-smes-user': OPERATOR,
};
const TENANT = TenantId.create('default');

/** beforeAll 捕获的齐套快照 store（模块级辅助函数播种放行前置用）。 */
let kitCheckStore: KitCheckStore | undefined;

let operationCounter = 0;
function opId(prefix: string): string {
  operationCounter += 1;
  return `w3-cleanup-e2e-${prefix}-${operationCounter}`;
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

/** 自足前置链：建令 → 齐套刷新（零需求行 complete）→ 建装配派工（draft v1）。 */
async function createAssemblyDispatch(
  baseUrl: string,
  projectName: string,
): Promise<{ workOrderId: string; dispatchId: string; dispatchVersion: number }> {
  const createdOrder = await post(
    baseUrl,
    '/workorder/work-orders',
    envelope('workorder.create.v1', { projectName }),
  );
  expect(createdOrder.body.status, `建工作令：${JSON.stringify(createdOrder.body)}`).toBe('committed');
  const workOrder = createdOrder.body['workOrder'] as { id: string; objectVersion: number };

  // Round-2 裁决后空清单刷新不再 vacuous 判齐（UX-PLAN-03 同构口径），本测试的
  // 齐套放行前置改为直接播种 complete=true 快照（有行有料——与 ISSUE_TASK_STORE
  // 播种先例同体例；kit.refresh 真实判定链归 workorder 域单测覆盖）。
  const kitStore = kitCheckStore!;
  await kitStore.append({
    tenant: TENANT,
    id: newKitCheckId(),
    workOrderId: WorkOrderId.create(workOrder.id),
    kinds: [{ kind: 'part', lineCount: 1, gapLineCount: 0, complete: true }],
    gapLines: [],
    complete: true,
    refreshedBy: UserId.create(OPERATOR),
  });

  const createdDispatch = await post(
    baseUrl,
    '/dispatch/orders',
    envelope('dispatch.create.v1', {
      workOrderId: workOrder.id,
      kind: 'assembly',
      operationCode: 'ASM-W3-CLEANUP',
      quantity: 2,
    }),
  );
  expect(createdDispatch.body.status, `建装配派工：${JSON.stringify(createdDispatch.body)}`).toBe('committed');
  const dispatchOrder = createdDispatch.body['dispatchOrder'] as { id: string; state: string; objectVersion: number };
  expect(dispatchOrder.state).toBe('draft');
  return { workOrderId: workOrder.id, dispatchId: dispatchOrder.id, dispatchVersion: dispatchOrder.objectVersion };
}

/** 派工到人（draft→assigned，触发 #29 同步钩子——空 demand 源下无任务生成）。 */
async function assignDispatch(
  baseUrl: string,
  dispatchId: string,
  version: number,
): Promise<number> {
  const assigned = await post(
    baseUrl,
    `/dispatch/orders/${dispatchId}/assign`,
    envelope('dispatch.assign.v1', { assignee: OPERATOR, remark: null }, version),
  );
  expect(assigned.body.status, `派工：${JSON.stringify(assigned.body)}`).toBe('committed');
  return (assigned.body['dispatchOrder'] as { objectVersion: number }).objectVersion;
}

/** 显式同步面造设备维任务（运维补发面——空 demand 源下唯一造数路径）。 */
async function syncEquipmentTask(
  baseUrl: string,
  workOrderId: string,
  equipmentRef: string,
): Promise<{ id: string; equipmentRef: string | null; rollup: boolean; state: string }> {
  const synced = await post(
    baseUrl,
    '/issue/tasks/sync',
    envelope('issue.sync.v1', { workOrderId, dispatchKind: 'assembly', equipmentRefs: [equipmentRef] }),
  );
  expect(synced.body.status, `显式同步：${JSON.stringify(synced.body)}`).toBe('committed');
  const tasks = synced.body['tasks'] as { id: string; equipmentRef: string | null; rollup: boolean; state: string }[];
  expect(tasks.length).toBe(1);
  expect(tasks[0]!.equipmentRef).toBe(equipmentRef);
  expect(tasks[0]!.rollup).toBe(false);
  return tasks[0]!;
}

async function listIssueTasks(baseUrl: string, workOrderId: string): Promise<{ id: string; state: string }[]> {
  return (await getJson(baseUrl, `/issue/tasks?workOrderId=${encodeURIComponent(workOrderId)}`))['tasks'] as {
    id: string;
    state: string;
  }[];
}

describe('fix-wave-3 W3-2：撤销派工→发料任务清理组合态（dispatch+issue 装配，#29 扩展）', () => {
  let baseUrl = '';
  const savedEnv = new Map<string, string | undefined>();
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;

  function setEnv(name: string, value: string | undefined): void {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  beforeAll(async () => {
    setEnv('MODULES_ENABLED', 'core,workorder,dispatch,issue');
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
      new WorkOrderErrorFilter(),
      new DispatchErrorFilter(),
    );
    const tenantContext = app.get(TenantContext);
    app.use((request: unknown, _response: unknown, next: () => void) => {
      tenantContext.run(tenantContext.resolve(request), () => next());
    });
    // 组合根构造后注入（与 main.ts 同构）：#29 装饰器（含 W3-2 清理钩子）生效。
    bindCrossModuleWiring(app);
    await app.listen(0);
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    kitCheckStore = app.get(WORKORDER_KIT_STORE, { strict: false });

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

  it('场景1：派工 assigned 后撤销 → 发料任务被清理（listTasks 空）', async () => {
    const { workOrderId, dispatchId, dispatchVersion } = await createAssemblyDispatch(baseUrl, 'W3-2 场景1 清理');
    const task = await syncEquipmentTask(baseUrl, workOrderId, 'eq-w3-a');
    expect((await listIssueTasks(baseUrl, workOrderId)).length).toBe(1); // 前置：任务在

    const assignedVersion = await assignDispatch(baseUrl, dispatchId, dispatchVersion);
    // 空归拢同步不产生任务——设备维任务仍 1 条。
    expect((await listIssueTasks(baseUrl, workOrderId)).length).toBe(1);

    const cancelled = await post(
      baseUrl,
      `/dispatch/orders/${dispatchId}/cancel`,
      envelope('dispatch.cancel.v1', { remark: 'W3-2 撤销清理' }, assignedVersion),
    );
    expect(cancelled.body.status, `撤销：${JSON.stringify(cancelled.body)}`).toBe('committed');
    expect((cancelled.body['dispatchOrder'] as { state: string }).state).toBe('cancelled');

    // 清理钩子（通知式同步语义——撤销响应内已落账）：任务消失。
    const remaining = await listIssueTasks(baseUrl, workOrderId);
    expect(remaining, `撤销后任务读回：${JSON.stringify(remaining)}`).toEqual([]);
    void task;
  }, 60_000);

  it('场景2：目标任务已发料中 → 撤销仍成功、任务保留（清理被拒 warn 路径）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { workOrderId, dispatchId, dispatchVersion } = await createAssemblyDispatch(baseUrl, 'W3-2 场景2 拒清理');
      const task = await syncEquipmentTask(baseUrl, workOrderId, 'eq-w3-b');
      // 播种"发料中"（非未开始）：issue 状态机归域内测试，此处只造清理拒绝前置。
      const taskStore = app!.get(ISSUE_TASK_STORE, { strict: false }) as IssueTaskStore;
      const seeded = await taskStore.refreshSummary(TENANT, task.id, 1, {
        state: 'issuing',
        totalRequiredQty: 0,
        totalIssuedQty: 0,
        finishedAt: null,
      });
      expect(seeded?.state).toBe('issuing');

      const assignedVersion = await assignDispatch(baseUrl, dispatchId, dispatchVersion);
      const cancelled = await post(
        baseUrl,
        `/dispatch/orders/${dispatchId}/cancel`,
        envelope('dispatch.cancel.v1', { remark: 'W3-2 目标已发料撤销' }, assignedVersion),
      );
      // 通知式合同：清理被拒不回滚撤销。
      expect(cancelled.body.status, `撤销：${JSON.stringify(cancelled.body)}`).toBe('committed');
      expect((cancelled.body['dispatchOrder'] as { state: string }).state).toBe('cancelled');

      // 任务保留 + 清理被拒留痕（warn 路径真的走到，非静默跳过）。
      const remaining = await listIssueTasks(baseUrl, workOrderId);
      expect(remaining.map((row) => row.id)).toEqual([task.id]);
      const cleanupWarn = warnSpy.mock.calls.some((args) =>
        args.some((arg) => typeof arg === 'string' && arg.includes('撤销派工→发料任务清理被拒')),
      );
      expect(cleanupWarn, `清理被拒 warn 留痕：${JSON.stringify(warnSpy.mock.calls)}`).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  }, 60_000);

  it('场景3（幂等）：确定性 operationId 重放被拒，重建任务不重复删账', async () => {
    const { workOrderId, dispatchId, dispatchVersion } = await createAssemblyDispatch(baseUrl, 'W3-2 场景3 幂等');
    const task = await syncEquipmentTask(baseUrl, workOrderId, 'eq-w3-c');

    const assignedVersion = await assignDispatch(baseUrl, dispatchId, dispatchVersion);
    const cancelled = await post(
      baseUrl,
      `/dispatch/orders/${dispatchId}/cancel`,
      envelope('dispatch.cancel.v1', { remark: 'W3-2 幂等撤销' }, assignedVersion),
    );
    expect(cancelled.body.status).toBe('committed');
    expect(await listIssueTasks(baseUrl, workOrderId)).toEqual([]); // 首次清理已删

    // 重放前提：同维度任务重建（维度已空，显式同步可再建）。
    const rebuilt = await syncEquipmentTask(baseUrl, workOrderId, 'eq-w3-c');
    expect(rebuilt.id).not.toBe(task.id);

    // 直接再调装饰器同款信封（同 operationId `wiring-issue-cleanup:<dispatchId>`）：
    // issue 侧 operations.record 拒重复——幂等拒路径不炸、不重复删账。
    const service = app!.get(IssueService, { strict: false });
    const replay = await service.execute(
      makeCommandEnvelope<IssueCommand>({
        tenantId: TENANT,
        issuedBy: UserId.create('u-system-wiring-issue'),
        operationId: OperationId.create(`wiring-issue-cleanup:${dispatchId}`),
        expectedRevision: 'initial',
        issuedAt: new Date().toISOString(),
        command: {
          kind: 'issue.cleanup.v1',
          payload: {
            workOrderId,
            dispatchKind: 'assembly',
            equipmentRefs: ['eq-w3-c'],
            remark: '撤销派工自动清理',
          },
        },
      }),
    );
    expect(replay.status).toBe('rejected');
    expect(String((replay as { reason?: string }).reason)).toContain('幂等冲突');
    // 重建任务仍在——同 operationId 不重复删账。
    expect((await listIssueTasks(baseUrl, workOrderId)).map((row) => row.id)).toEqual([rebuilt.id]);
  }, 60_000);
});
