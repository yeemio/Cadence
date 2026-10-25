/**
 * 跨模块端口接线组合态集成测试（M2 后第一增量，Done-when 1/2/3）。
 *
 * 与 boot.e2e.test.ts（装配冒烟）的区别：本文件验证**接线后的业务链路**——
 * 九模块 + core 零 DB 全装配下，跨模块消费端口经组合根 wiring 接通后的
 * 端到端因果链（HTTP 全程走组合根路径：注册表 → wiring 注入 → 拦截器联动）：
 *
 *  1. 建工作令 → 建零件派工 → assign → 报工 submit（validDispatch 接线 #1：
 *     未接线形态 submit 全拒——能过即接线生效）→ verify → hours 有劳动条目
 *     （reportFeed #2 + ingest 拦截器联动：verify 后**不经手动 ingest 端点**
 *     直接读回即得）→ costing rebuild 出非零工时成本（laborSource #3 +
 *     workOrderSubject #6）；各环节分断言。
 *  2. 齐套拦截：装配派工在无 kit_check 快照时被拒建（kitCheck #7 fail-closed
 *     组合态生效）。
 *  3. workOrderSubject fail-closed：costing rebuild 对不存在的工作令 rejected。
 *  4. 双触发幂等组合态：verify 后拦截器已自动 ingest，手动 POST /hours/ingest
 *     再触发一次 → hours 条目数/净额不变（重放幂等实证）。
 *
 * 鉴权走 dev 身份回落（SMES_DEV_AUTH=on）+ POST /dev/policies 授 admin 角色
 * （admin bypass——测试钩子，生产形态不开，见 dev-policy.controller.ts）。
 */
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { TenantContext } from '@smes/application';
import { bindCrossModuleWiring } from '../src/cross-module-wiring.js';
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
import { MACHINING_CALIB_PACK_V1, metricSourceSetOf, type MetricSourceSet } from '@smes/metric-pack';

/** dev 身份（grant admin 角色 → 全权限码 bypass）。 */
const OPERATOR = 'u-op-wiring';
const HEADERS = {
  'content-type': 'application/json',
  'x-smes-user': OPERATOR,
};

/**
 * 内存假源集（接线 #24 的 e2e 注入面）：六源 PG 束在零 DB e2e 不可用属预期——
 * 组合根 sourceSetFor 注入位喂内存源，覆盖"激活→evaluate 出数"正路径（六源
 * PG 适配器的行形状与谓词下推取舍已由包级/business-store 测试覆盖）。
 */
const FAKE_DELIVERY_ROWS = [
  { occurredAt: '2026-05-01T08:00:00.000Z', businessTime: '2026-05-10T00:00:00.000Z', workOrderId: 'wo-e2e-metric-1', periodMonth: '2026-05', deliveryVerdict: 'on-time' },
  { occurredAt: '2026-05-01T08:00:00.000Z', businessTime: '2026-05-20T00:00:00.000Z', workOrderId: 'wo-e2e-metric-2', periodMonth: '2026-05', deliveryVerdict: 'delayed' },
] as const;
const FAKE_METRIC_SOURCE_SET: MetricSourceSet = metricSourceSetOf({
  'workorder-delivery-facts': {
    read: async () => FAKE_DELIVERY_ROWS,
  },
});

let operationCounter = 0;
function opId(prefix: string): string {
  operationCounter += 1;
  return `wiring-e2e-${prefix}-${operationCounter}`;
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

describe('跨模块端口接线组合态（九模块零 DB 全装配）', () => {
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
    setEnv(
      'MODULES_ENABLED',
      'core,workorder,baseline,listing,inspection,inventory,dispatch,reporting,hours,costing,payroll,maintenance,drawing,metric-pack',
    );
    setEnv('DATABASE_URL', undefined); // 零 DB：组合根 wiring 的 store 级适配器全走内存共享实例
    setEnv('SMES_DEV_AUTH', 'on'); // dev 身份回落（测试钩子）
    setEnv('SMES_DEV_POLICY_ENDPOINT', 'on'); // 策略注入钩子

    const enabled = parseModulesEnabled(process.env['MODULES_ENABLED']);
    const app = await NestFactory.create(
      buildAppModule(enabled, {
        devPolicyEndpoint: true,
        // 接线 #24 e2e 注入面：内存假源集（零 DB 下六源 PG 束不可用属预期）
        metricPackSourceSetFor: () => FAKE_METRIC_SOURCE_SET,
      }),
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
    );
    const tenantContext = app.get(TenantContext);
    app.use((request: unknown, _response: unknown, next: () => void) => {
      tenantContext.run(tenantContext.resolve(request), () => next());
    });
    // 组合根构造后注入（与 main.ts 同构）：service 级迟到绑定在此刻回填。
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
    for (const [name, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it(
    '端到端链：建工作令→建派工→assign→报工 submit→verify→hours 劳动条目→costing 非零工时成本',
    async () => {
      // ---- 环节 1：建工作令（WorkOrderCreated 落域事件——workOrderFeed #11 的事实源）----
      const createdOrder = await post(
        baseUrl,
        '/workorder/work-orders',
        envelope('workorder.create.v1', { projectName: '接线组合态验证-Proj' }),
      );
      expect(createdOrder.status).toBe(201);
      expect(createdOrder.body.status).toBe('committed');
      const workOrder = createdOrder.body['workOrder'] as { id: string };
      expect(typeof workOrder?.id).toBe('string');

      // ---- 环节 2：建零件派工（kind=part：图号×工序随单）----
      const createdDispatch = await post(
        baseUrl,
        '/dispatch/orders',
        envelope('dispatch.create.v1', {
          workOrderId: workOrder.id,
          kind: 'part',
          drawingNo: 'DWG-WIRING-01',
          operationCode: 'OP-10',
          quantity: 10,
        }),
      );
      expect(createdDispatch.status).toBe(201);
      expect(createdDispatch.body.status).toBe('committed');
      const dispatchOrder = createdDispatch.body['dispatchOrder'] as { id: string; state: string; objectVersion: number };
      expect(dispatchOrder.state).toBe('draft');

      // ---- 环节 3：assign（assigned 态可报工）----
      const assigned = await post(
        baseUrl,
        `/dispatch/orders/${dispatchOrder.id}/assign`,
        envelope('dispatch.assign.v1', { assignee: 'u-worker-01', remark: null }, dispatchOrder.objectVersion),
      );
      expect(assigned.body.status).toBe('committed');

      // ---- 环节 4：报工 submit（validDispatch #1：未接线形态此步全拒）----
      const submitted = await post(
        baseUrl,
        '/reports',
        envelope('report.submit.v1', { dispatchId: dispatchOrder.id, doneQty: 10, laborMinutes: 90 }),
      );
      expect(submitted.status).toBe(201);
      expect(submitted.body.status).toBe('committed');
      const report = submitted.body['report'] as { id: string; state: string; kind: string; objectVersion: number };
      expect(report.state).toBe('reported');
      expect(report.kind).toBe('part'); // 报工类别从派工单事实推导（validDispatch 快照）

      // verify 前：无 verified 事件 → hours 无条目（ingest 联动不是"提前入账"）
      const beforeVerify = (await getJson(baseUrl, `/hours/work-orders/${workOrder.id}`))['view'] as {
        entryCount: number;
      };
      expect(beforeVerify.entryCount).toBe(0);

      // ---- 环节 5：verify（committed 收场 → 拦截器联动 hours.ingest——实时触发面）----
      const verified = await post(
        baseUrl,
        `/reports/${report.id}/verify`,
        envelope('report.verify.v1', {}, report.objectVersion),
      );
      expect(verified.body.status).toBe('committed');
      expect(((verified.body['report'] as { state: string }).state)).toBe('verified');

      // ---- 环节 6：hours 有劳动条目（reportFeed #2 + minutesToHours：90min → 1.5h）----
      const hoursView = (await getJson(baseUrl, `/hours/work-orders/${workOrder.id}`))['view'] as {
        totalHours: number;
        entryCount: number;
        byTrade: { trade: string; totalHours: number; outputQty: number; entryCount: number }[];
      };
      expect(hoursView.entryCount).toBe(1);
      expect(hoursView.totalHours).toBe(1.5);
      expect(hoursView.byTrade).toEqual([
        { trade: 'machining', totalHours: 1.5, outputQty: 10, entryCount: 1 }, // part → machining（REPORT_KIND_TO_TRADE）
      ]);

      // ---- 环节 7：costing rebuild 出非零工时成本（laborSource #3 + workOrderSubject #6）----
      const published = await post(
        baseUrl,
        '/costing/models',
        envelope('costing.model.publish.v1', {
          code: 'standard',
          name: '接线组合态口径',
          hourlyRates: { machining: 6000, assembly: 5000, electrical: 6500, aftercare: 5500, misc: 4000 },
          status: 'active',
        }),
      );
      expect(published.body.status).toBe('committed');

      const rebuilt = await post(
        baseUrl,
        '/costing/rebuild',
        envelope('costing.rebuild.v1', { workOrderId: workOrder.id }),
      );
      expect(rebuilt.body.status).toBe('committed');
      const totals = rebuilt.body['totals'] as {
        laborMinor: number;
        materialMinor: number;
        outsourcingMinor: number;
        laborHoursByTrade: Record<string, number>;
      };
      expect(totals.laborMinor).toBe(9000); // 1.5h × 6000 分/h（口径层金额化）
      expect(totals.laborHoursByTrade['machining']).toBe(1.5);
      expect(totals.materialMinor).toBe(0); // 无发料流水（材料源空集——不静默估算）
      expect(totals.outsourcingMinor).toBe(0);

      // 幂等重算：值未变不追加新版本行（snapshotChanged=false）
      const rebuiltAgain = await post(
        baseUrl,
        '/costing/rebuild',
        envelope('costing.rebuild.v1', { workOrderId: workOrder.id }),
      );
      expect(rebuiltAgain.body.status).toBe('committed');
      expect(rebuiltAgain.body['snapshotChanged']).toBe(false);

      // 查询面同口径读回（summary 实时净额 = 快照）
      const summary = (await getJson(baseUrl, `/costing/work-orders/${workOrder.id}/summary`))['summary'] as {
        totals: { laborMinor: number };
      };
      expect(summary.totals.laborMinor).toBe(9000);
    },
    60_000,
  );

  it('齐套拦截组合态生效：无 kit_check 快照的装配派工拒建（kitCheck #7 fail-closed）', async () => {
    const createdOrder = await post(
      baseUrl,
      '/workorder/work-orders',
      envelope('workorder.create.v1', { projectName: '接线组合态-齐套拦截' }),
    );
    const workOrder = createdOrder.body['workOrder'] as { id: string };
    expect(createdOrder.body.status).toBe('committed');

    const refused = await post(
      baseUrl,
      '/dispatch/orders',
      envelope('dispatch.create.v1', {
        workOrderId: workOrder.id,
        kind: 'assembly',
        operationCode: 'ASM-01',
        quantity: 2,
      }),
    );
    // 命令三分结果：拦截是业务拒绝（HTTP 200/201 + status=rejected），不是 5xx
    expect(refused.body.status).toBe('rejected');
    expect(String(refused.body.reason)).toMatch(/齐套/);
  });

  it('workOrderSubject fail-closed：costing rebuild 对不存在的工作令 rejected（接线 #6）', async () => {
    // 自足：本用例独立发布口径（不依赖用例 1 的发布次序）
    const published = await post(
      baseUrl,
      '/costing/models',
      envelope('costing.model.publish.v1', {
        code: 'wiring-subject-check',
        name: '主体校验口径',
        hourlyRates: { machining: 6000, assembly: 5000, electrical: 6500, aftercare: 5500, misc: 4000 },
        status: 'active',
      }),
    );
    expect(['committed', 'rejected']).toContain(published.body.status); // committed=首发 / rejected=已存在（幂等）

    const rebuilt = await post(
      baseUrl,
      '/costing/rebuild',
      envelope('costing.rebuild.v1', { workOrderId: 'wo-does-not-exist', modelCode: 'wiring-subject-check' }),
    );
    expect(rebuilt.body.status).toBe('rejected');
    expect(String(rebuilt.body.reason)).toMatch(/不存在/);
  });

  it(
    '双触发幂等组合态：verify 拦截器已联动 ingest，手动 POST /hours/ingest 后条目数不变',
    async () => {
      // 自足链：建工作令 → 零件派工 → assign → 报工 → verify（拦截器自动联动 hours.ingest）
      const createdOrder = await post(
        baseUrl,
        '/workorder/work-orders',
        envelope('workorder.create.v1', { projectName: '接线组合态-双触发幂等' }),
      );
      const workOrder = createdOrder.body['workOrder'] as { id: string };

      const createdDispatch = await post(
        baseUrl,
        '/dispatch/orders',
        envelope('dispatch.create.v1', {
          workOrderId: workOrder.id,
          kind: 'part',
          drawingNo: 'DWG-WIRING-DUP-01',
          operationCode: 'OP-10',
          quantity: 4,
        }),
      );
      const dispatchOrder = createdDispatch.body['dispatchOrder'] as { id: string; objectVersion: number };

      const assigned = await post(
        baseUrl,
        `/dispatch/orders/${dispatchOrder.id}/assign`,
        envelope('dispatch.assign.v1', { assignee: 'u-worker-01', remark: null }, dispatchOrder.objectVersion),
      );
      expect(assigned.body.status).toBe('committed');

      const submitted = await post(
        baseUrl,
        '/reports',
        envelope('report.submit.v1', { dispatchId: dispatchOrder.id, doneQty: 4, laborMinutes: 60 }),
      );
      expect(submitted.body.status).toBe('committed');
      const report = submitted.body['report'] as { id: string; objectVersion: number };

      const verified = await post(
        baseUrl,
        `/reports/${report.id}/verify`,
        envelope('report.verify.v1', {}, report.objectVersion),
      );
      expect(verified.body.status).toBe('committed'); // verify 成功即拦截器联动 ingest（失败不阻塞）

      const afterAuto = (await getJson(baseUrl, `/hours/work-orders/${workOrder.id}`))['view'] as {
        totalHours: number;
        entryCount: number;
      };
      expect(afterAuto.entryCount).toBe(1); // 自动联动已入账（60min → 1h）
      expect(afterAuto.totalHours).toBe(1);

      // 双触发：手动重放面再 POST /hours/ingest 一次（等价重放，消费位已确认 →
      // 零新入账）；断言条目数与净额不变——skipped/空批幂等路径组合态实证。
      const manualIngest = await post(baseUrl, '/hours/ingest', envelope('hours.ingest.v1', {}));
      expect(manualIngest.body.status).toBe('committed');
      expect(Number(manualIngest.body['ingested'] ?? 0)).toBe(0); // 无新入账（自动联动已消费）

      const afterManual = (await getJson(baseUrl, `/hours/work-orders/${workOrder.id}`))['view'] as {
        totalHours: number;
        entryCount: number;
      };
      expect(afterManual.entryCount).toBe(afterAuto.entryCount); // 条目数不变（幂等）
      expect(afterManual.totalHours).toBe(afterAuto.totalHours); // 净额不变（1h）
    },
    60_000,
  );
  it(
    'payroll 全链（#21 事实源+导出+HTTP 面）：规则发布→月度核算（hours 净工时经逆映射）→查询→xlsx 导出→冲销重算归零→400 映射',
    async () => {
      const month = new Date().toISOString().slice(0, 7); // 'YYYY-MM'（hours 条目按 workDate 归属月）

      // ---- 独立工作链：建令→派工→assign→报工→verify（reporter=OPERATOR）----
      const order = await post(baseUrl, '/workorder/work-orders', envelope('workorder.create.v1', { projectName: 'payroll 接线链' }));
      expect(order.body.status).toBe('committed');
      const wo = order.body['workOrder'] as { id: string };
      const disp = await post(baseUrl, '/dispatch/orders', envelope('dispatch.create.v1', { workOrderId: wo.id, kind: 'part', drawingNo: 'DWG-PR-1', operationCode: 'OP-10', quantity: 4 }));
      expect(disp.body.status).toBe('committed');
      const d = disp.body['dispatchOrder'] as { id: string; objectVersion: number };
      expect((await post(baseUrl, `/dispatch/orders/${d.id}/assign`, envelope('dispatch.assign.v1', { assignee: OPERATOR, remark: null }, d.objectVersion))).body.status).toBe('committed');
      const rep = await post(baseUrl, '/reports', envelope('report.submit.v1', { dispatchId: d.id, doneQty: 4, laborMinutes: 120 }));
      expect(rep.body.status).toBe('committed');
      const r = rep.body['report'] as { id: string; objectVersion: number };
      const myHoursBefore = (await getJson(baseUrl, `/hours/my?month=${month}`)) as unknown as { my?: { totalHours: number }; view?: { totalHours: number }; totalHours?: number };
      const baselineHours = ((myHoursBefore['my'] ?? myHoursBefore['view'] ?? myHoursBefore) as { totalHours: number })['totalHours'];
      const verified = await post(baseUrl, `/reports/${r.id}/verify`, envelope('report.verify.v1', {}, r.objectVersion));
      expect(verified.body.status).toBe('committed');
      const verifiedReport = verified.body['report'] as { objectVersion: number };

      // ---- 规则发布（scope.laborKind='part'——若 #21 逆映射错一词则匹配失败，本链即红）----
      const published = await post(baseUrl, '/payroll/rules/commands', envelope('payroll.rule.publish.v1', { ruleId: 'std-part', name: '标准件时薪', rateMinor: 10000, scope: { laborKind: 'part' } }));
      expect(published.status).toBe(201);
      expect(published.body.status).toBe('committed');

      // ---- 月度核算（#21：hours 条目按月聚合净工时 + machining→part 逆映射）----
      const run = await post(baseUrl, '/payroll/runs/commands', envelope('payroll.run.month.v1', { periodKey: month }));
      expect(run.status).toBe(201);
      expect(run.body.status).toBe('committed');

      // ---- 查询（差分断言：以本链 verify 前的本人同月净工时为基线，不依赖其他用例数据）----
      const runs = (await getJson(baseUrl, `/payroll/runs?month=${month}&personId=${OPERATOR}`)) as unknown as { personId: string; totalQuantity: number; totalAmountMinor: number; lineCount: number; lines: { laborKind: string; sourceRefs: string[] }[] }[];
      const mine = Array.isArray(runs) ? runs.find((row) => row.personId === OPERATOR) : undefined;
      expect(mine).toBeDefined();
      expect(mine!.totalQuantity).toBe(baselineHours + 2); // 本链 120min → 2h（差分）
      expect(mine!.totalAmountMinor).toBe((baselineHours + 2) * 10000); // × 时薪 10000 分/h
      const partLine = mine!.lines.find((line) => line.laborKind === 'part');
      expect(partLine).toBeDefined();
      expect(partLine!.sourceRefs.length).toBeGreaterThanOrEqual(1); // hours 条目可下钻

      // ---- 导出（#21 exportPort：ExcelJS 同实例结构同形 → xlsx-base64）----
      const exported = await post(baseUrl, '/payroll/exports/commands', envelope('payroll.export.v1', { periodKey: month, personId: OPERATOR }));
      expect(exported.body.status).toBe('committed');
      const output = exported.body['export'] as { kind: string; base64?: string };
      expect(output.kind).toBe('xlsx-base64');
      expect(typeof output.base64).toBe('string');
      expect(output.base64!.length).toBeGreaterThan(100);

      // ---- 冲销联动（direction reverse + 净额零不投递）：撤销本链报工→重算→本人净额回落 1.5h ----
      const revoked = await post(baseUrl, `/reports/${r.id}/revoke`, envelope('report.revoke.v1', { reason: 'payroll 冲销验证' }, verifiedReport.objectVersion));
      expect(revoked.body.status).toBe('committed'); // verified→revoked 触发 hours 冲销条目（拦截器联动）
      const rerun = await post(baseUrl, '/payroll/runs/commands', envelope('payroll.run.month.v1', { periodKey: month }));
      expect(rerun.body.status).toBe('committed');
      const runsAfter = (await getJson(baseUrl, `/payroll/runs?month=${month}&personId=${OPERATOR}`)) as unknown as { totalQuantity: number }[];
      const mineAfter = Array.isArray(runsAfter) ? runsAfter.find((row) => (row as { personId?: string }).personId === OPERATOR) : undefined;
      expect(mineAfter?.totalQuantity).toBe(baselineHours); // 本链 2h 全冲销（净额零不投递）→ 回落基线

      // ---- HTTP 400 映射（PayrollErrorFilter）：非法月份查询参数 ----
      const bad = await fetch(`${baseUrl}/payroll/runs?month=2026-13`, { headers: HEADERS });
      expect(bad.status).toBe(400);
    },
    60_000,
  );

  it(
    'maintenance 全链：建计划→due-scan 出任务（重放零新建）→task.create→start→complete→点检留痕→查询面+404/400 映射',
    async () => {
      // ---- 建计划（daily 周期；anchor=首发 createdAt，合同 §7 对账锚）----
      const published = await post(
        baseUrl,
        '/maintenance/plans/commands',
        envelope('maintenance.plan.publish.v1', {
          planId: 'e2e-lathe-daily-check',
          name: '车床日点检',
          resourceRef: 'eq-lathe-01',
          cycle: { kind: 'daily' },
          checkpoints: [{ checkpointId: 'belt-check', label: '皮带松紧检查', expectation: '按压下沉 <10mm' }],
          upkeepActions: ['导轨润滑'],
        }),
      );
      expect(published.status).toBe(201);
      expect(published.body.status).toBe('committed');
      const plan = published.body['plan'] as { planId: string; objectVersion: number; status: string };
      expect(plan.objectVersion).toBe(1);
      expect(plan.status).toBe('current');

      // ---- 到期扫描（asOf=+36h：daily 到期 occurrence ≥1；source=plan-due）----
      const asOf = new Date(Date.now() + 36 * 3_600_000).toISOString();
      const scanned = await post(
        baseUrl,
        '/maintenance/plans/due-scan/commands',
        envelope('maintenance.plan.due-scan.v1', { asOf }),
      );
      expect(scanned.body.status).toBe('committed');
      const scan = scanned.body['scan'] as {
        plansScanned: number;
        tasksCreated: number;
        tasks: { id: string; source: string; kind: string; state: string }[];
      };
      expect(scan.plansScanned).toBeGreaterThanOrEqual(1);
      expect(scan.tasksCreated).toBeGreaterThanOrEqual(1);
      expect(scan.tasks[0]!.source).toBe('plan-due');
      // 同 asOf 重放：到期集合确定 → 零新建（对账锚语义，合同 §7）
      const rescanned = await post(
        baseUrl,
        '/maintenance/plans/due-scan/commands',
        envelope('maintenance.plan.due-scan.v1', { asOf }),
      );
      expect(rescanned.body.status).toBe('committed');
      expect((rescanned.body['scan'] as { tasksCreated: number }).tasksCreated).toBe(0);

      // ---- 手工建任务 → start → complete（状态机迁移乐观锁逐级）----
      const created = await post(
        baseUrl,
        '/maintenance/tasks/commands',
        envelope('maintenance.task.create.v1', {
          resourceRef: 'eq-lathe-01',
          kind: 'repair',
          planId: 'e2e-lathe-daily-check',
          assignee: OPERATOR,
        }),
      );
      expect(created.body.status).toBe('committed');
      const task = created.body['task'] as { id: string; state: string; objectVersion: number; source: string };
      expect(task.state).toBe('scheduled');
      expect(task.source).toBe('manual');

      const started = await post(
        baseUrl,
        '/maintenance/tasks/start/commands',
        envelope('maintenance.task.start.v1', { taskId: task.id }, 1),
      );
      expect(started.body.status).toBe('committed');
      const startedTask = started.body['task'] as { state: string; objectVersion: number };
      expect(startedTask.state).toBe('executing');

      const completed = await post(
        baseUrl,
        '/maintenance/tasks/complete/commands',
        envelope('maintenance.task.complete.v1', { taskId: task.id }, startedTask.objectVersion),
      );
      expect(completed.body.status).toBe('committed');
      expect((completed.body['task'] as { state: string }).state).toBe('done');

      // ---- 点检记录追加（判据清单内 checkpointId——计划溯源校验）----
      const recorded = await post(
        baseUrl,
        '/maintenance/records/commands',
        envelope('maintenance.record.append.v1', {
          kind: 'checkpoint',
          resourceRef: 'eq-lathe-01',
          planId: 'e2e-lathe-daily-check',
          checkpointId: 'belt-check',
          result: 'pass',
        }),
      );
      expect(recorded.body.status).toBe('committed');
      expect((recorded.body['record'] as { kind: string }).kind).toBe('checkpoint');

      // ---- 查询面：队列过滤 + 计划版本链 ----
      const queue = (await getJson(baseUrl, '/maintenance/tasks?state=done')) as unknown as { id: string }[];
      expect(Array.isArray(queue)).toBe(true);
      expect(queue.some((row) => row.id === task.id)).toBe(true);
      const versions = (await getJson(baseUrl, '/maintenance/plans/e2e-lathe-daily-check/versions')) as unknown as {
        objectVersion: number;
      }[];
      expect(versions.length).toBe(1);

      // ---- 过滤器映射：不存在计划 404 / 非法 kind 400（MaintenanceErrorFilter）----
      const notFound = await fetch(`${baseUrl}/maintenance/plans/no-such-plan/versions`, { headers: HEADERS });
      expect(notFound.status).toBe(404);
      const badQuery = await fetch(`${baseUrl}/maintenance/tasks?kind=unknown`, { headers: HEADERS });
      expect(badQuery.status).toBe(400);
    },
    60_000,
  );

  it(
    '故障联动 #22：baseline 上报→组合根建议→触发建维修任务（faultRef 挂接）→重触发幂等零重建',
    async () => {
      // ---- baseline 故障上报（FaultReported 事件落 wiring 共享的 baseline 事件存储）----
      const reported = await post(
        baseUrl,
        '/baseline/fault-reports/commands',
        envelope('baseline.fault.report.v1', {
          equipmentCode: 'EQ-LATHE-02',
          description: '主轴异响，需停机检查',
          assignee: OPERATOR,
        }),
      );
      expect(reported.body.status).toBe('committed');
      const events = reported.body['events'] as { payload: { faultReportId: string } }[];
      const faultReportId = events[0]!.payload.faultReportId;

      // ---- 建议面：pending 含该故障（equipmentCode→resourceRef 结构同形）----
      const pending = (await getJson(baseUrl, '/maintenance/fault-linkage')) as unknown as {
        resourceRef: string;
        faultRef: string;
        suggestedAssignee: string | null;
      }[];
      const suggestion = pending.find((row) => row.faultRef === faultReportId);
      expect(suggestion).toBeDefined();
      expect(suggestion!.resourceRef).toBe('EQ-LATHE-02');
      expect(suggestion!.suggestedAssignee).toBe(OPERATOR);

      // ---- 触发同步：maintenance.task.create（kind=repair + faultRef 挂接）----
      const synced = await post(baseUrl, '/maintenance/fault-linkage/commands', envelope('maintenance.fault-linkage.v1', {}));
      expect(synced.status).toBe(201);
      const sync = synced.body as unknown as { tasksCreated: number; skipped: number };
      expect(sync.tasksCreated).toBeGreaterThanOrEqual(1);

      const faultTasks = (await getJson(baseUrl, '/maintenance/tasks?source=fault')) as unknown as {
        id: string;
        faultRef: string;
        kind: string;
        state: string;
        assignee: string | undefined;
      }[];
      const linked = faultTasks.find((row) => row.faultRef === faultReportId);
      expect(linked).toBeDefined();
      expect(linked!.kind).toBe('repair');
      expect(linked!.state).toBe('scheduled');

      // ---- 幂等重触发：已联动 faultRef（+消费位/确定性 operationId）→ 零重建 ----
      const resynced = await post(baseUrl, '/maintenance/fault-linkage/commands', envelope('maintenance.fault-linkage.v1', {}));
      expect(resynced.status).toBe(201);
      const resync = resynced.body as unknown as { tasksCreated: number; skipped: number };
      expect(resync.tasksCreated).toBe(0);
      const faultTasksAfter = (await getJson(baseUrl, '/maintenance/tasks?source=fault')) as unknown as { faultRef: string }[];
      expect(faultTasksAfter.filter((row) => row.faultRef === faultReportId).length).toBe(1);
    },
    60_000,
  );

  it(
    'drawing 全链：publish v1/v2→viewRevision 留痕→超许可同形 404→#23 workorder 附件钉版清单',
    async () => {
      // ---- 发布 v1（public）→ v2（restricted，expectedRevision=1 乐观锁）----
      const first = await post(
        baseUrl,
        '/drawing/revisions/commands',
        envelope('drawing.publish.v1', {
          drawingId: 'DWG-E2E-1',
          fileRef: 'storage://drawings/DWG-E2E-1/v1.pdf',
          changeNote: '首发',
          classification: 'public',
        }),
      );
      expect(first.status).toBe(201);
      expect(first.body.status).toBe('committed');
      expect((first.body['revision'] as { version: number }).version).toBe(1);

      const second = await post(
        baseUrl,
        '/drawing/revisions/commands',
        envelope('drawing.publish.v1', {
          drawingId: 'DWG-E2E-1',
          fileRef: 'storage://drawings/DWG-E2E-1/v2.pdf',
          changeNote: '公差收紧',
          classification: 'restricted',
        }, 1),
      );
      expect(second.body.status).toBe('committed');
      expect((second.body['revision'] as { version: number; classification: string }).version).toBe(2);
      // 发布即联动变更通知（from→to）
      expect((second.body['notice'] as { toVersion: number }).toVersion).toBe(2);

      // ---- 查看留痕：钉版 v1（public 许可可见）+ v2（restricted 许可）----
      const viewV1 = await fetch(`${baseUrl}/drawing/revisions/DWG-E2E-1/view?version=1&clearance=public`, { headers: HEADERS });
      expect(viewV1.status).toBe(200);
      const v1 = (await viewV1.json()) as { fileRef: string; status: string };
      expect(v1.fileRef).toContain('v1.pdf');
      expect(v1.status).toBe('superseded'); // 钉版查看常态：v2 已发布，v1 读回仍 v1

      const viewV2 = await fetch(`${baseUrl}/drawing/revisions/DWG-E2E-1/view?version=2&clearance=restricted`, { headers: HEADERS });
      expect(viewV2.status).toBe(200);
      expect(((await viewV2.json()) as { status: string }).status).toBe('current');

      // ---- 超许可与不存在同形 404（不泄漏存在性，合同 §2 内核不变量 1）----
      const overClearance = await fetch(`${baseUrl}/drawing/revisions/DWG-E2E-1/view?version=2&clearance=public`, { headers: HEADERS });
      const missing = await fetch(`${baseUrl}/drawing/revisions/DWG-E2E-1/view?version=99&clearance=restricted`, { headers: HEADERS });
      expect(overClearance.status).toBe(404);
      expect(missing.status).toBe(404);
      const overBody = (await overClearance.json()) as { statusCode: number; message: string };
      const missingBody = (await missing.json()) as { statusCode: number; message: string };
      expect(overBody.statusCode).toBe(missingBody.statusCode);
      // 消息只回显调用方已知入参（图纸/请求版本），无等级/链长泄漏
      expect(overBody.message).not.toContain('restricted');
      expect(overBody.message).toContain('v2');
      expect(missingBody.message).toContain('v99');

      // ---- 查看留痕审计（两次成功查看各一行；404 路径不留痕）----
      const audit = (await getJson(baseUrl, '/drawing/view-audit?drawingId=DWG-E2E-1')) as unknown as {
        drawingId: string;
        version: number;
      }[];
      expect(audit.filter((row) => row.drawingId === 'DWG-E2E-1').length).toBe(2);

      // ---- #23 workorder 附件钉版清单（ref='drawingId@vN' 编码 → refs 装配）----
      const order = await post(baseUrl, '/workorder/work-orders', envelope('workorder.create.v1', { projectName: 'drawing 接线链' }));
      expect(order.body.status).toBe('committed');
      const wo = order.body['workOrder'] as { id: string; objectVersion: number };
      const attached = await post(
        baseUrl,
        `/workorder/work-orders/${wo.id}/attachments`,
        envelope('workorder.attach.v1', { name: 'DWG-E2E-1', kind: 'drawing', ref: 'DWG-E2E-1@v1' }, wo.objectVersion),
      );
      expect(attached.body.status).toBe('committed');

      const forTech = (await getJson(baseUrl, `/drawing/work-orders/${wo.id}/drawings?clearance=restricted`)) as unknown as {
        drawingId: string;
        version: number;
        status: string;
        latestVersion?: number;
        hasUpdate?: boolean;
      }[];
      expect(forTech).toEqual([
        expect.objectContaining({
          drawingId: 'DWG-E2E-1',
          version: 1,
          status: 'ok',
          latestVersion: 2, // 许可内可见 v2 → 有升级目标
          hasUpdate: true, // 钉版不漂移，升级是显式动作
        }),
      ]);
      // public 许可：v1 可见，升级视图只数许可内新版（v2 restricted 不越级泄漏）
      const forLine = (await getJson(baseUrl, `/drawing/work-orders/${wo.id}/drawings?clearance=public`)) as unknown as {
        status: string;
        hasUpdate: boolean;
      }[];
      expect(forLine[0]!.status).toBe('ok');
      expect(forLine[0]!.hasUpdate).toBe(false);

      // ---- 通知读取（sinceVersion 游标）+ 400 映射（未知许可词 fail-fast）----
      const notices = (await getJson(baseUrl, '/drawing/notices/DWG-E2E-1?sinceVersion=1')) as unknown as {
        toVersion: number;
      }[];
      expect(notices.map((row) => row.toVersion)).toEqual([2]);
      const badClearance = await fetch(`${baseUrl}/drawing/revisions/DWG-E2E-1?clearance=secret`, { headers: HEADERS });
      expect(badClearance.status).toBe(400);
    },
    60_000,
  );

  it(
    'metric-pack 全链：activate（smes-machining-calib v1）→内存源集 evaluate 出数→packs/resolve 查询+未装载 404',
    async () => {
      // ---- 装载机加垂直口径包 v1（定义从包导出取——MACHINING_CALIB_PACK_V1）----
      const activated = await post(
        baseUrl,
        '/metric-pack/activations/commands',
        envelope('metric-pack.activate.v1', {
          pack: JSON.parse(JSON.stringify(MACHINING_CALIB_PACK_V1)) as Record<string, unknown>,
        }),
      );
      expect(activated.status).toBe(201);
      if (activated.body.status !== 'committed') {
        // 唯一合法重试形态：先前的装载已存在（升级须严格递增）——本用例要求首装
        expect(String(activated.body.reason)).toMatch(/严格递增/);
      } else {
        const activation = activated.body['activation'] as { packId: string; packVersion: number; status: string };
        expect(activation.packId).toBe('smes-machining-calib');
        expect(activation.packVersion).toBe(1);
        expect(activation.status).toBe('current');
      }

      // ---- evaluate 出数（#24 内存源集注入：workorder-delivery-facts 两行）----
      const query = encodeURIComponent(JSON.stringify({ metricId: 'workorder-delivery-comparison', version: 1 }));
      const evaluated = await fetch(`${baseUrl}/metric-pack/evaluate?query=${query}`, { headers: HEADERS });
      expect(evaluated.status).toBe(200);
      const result = (await evaluated.json()) as {
        metric: { metricId: string; version: number };
        dimensionFields: string[];
        measureIds: string[];
        rows: { key: Record<string, unknown>; values: Record<string, unknown> }[];
      };
      expect(result.metric).toEqual({ metricId: 'workorder-delivery-comparison', version: 1 });
      expect(result.dimensionFields).toEqual(['periodMonth', 'deliveryVerdict']);
      expect(result.rows.length).toBe(2); // on-time + delayed 各一行（count=1）
      const delayedRow = result.rows.find((row) => row.key['deliveryVerdict'] === 'delayed');
      expect(delayedRow!.values['workorder-count']).toBe(1);

      // ---- 查询面：装载清单 + 定义定位（溯源视图）----
      const packs = (await getJson(baseUrl, '/metric-pack/packs')) as unknown as {
        packId: string;
        packVersion: number;
        status: string;
      }[];
      const calib = packs.find((row) => row.packId === 'smes-machining-calib');
      expect(calib).toBeDefined();
      expect(calib!.packVersion).toBe(1);
      expect(calib!.status).toBe('current');

      const resolved = (await getJson(
        baseUrl,
        '/metric-pack/metrics/resolve?metricId=workorder-delivery-comparison&version=1',
      )) as unknown as {
        activation: { packId: string };
        definition: { metricId: string; version: number };
      };
      expect(resolved.activation.packId).toBe('smes-machining-calib');
      expect(resolved.definition.metricId).toBe('workorder-delivery-comparison');

      // ---- 可见性纪律：未装载口径 404（MetricPackNotFoundError→404 映射）----
      const unknownMetric = await fetch(
        `${baseUrl}/metric-pack/metrics/resolve?metricId=no-such-metric&version=1`,
        { headers: HEADERS },
      );
      expect(unknownMetric.status).toBe(404);
    },
    60_000,
  );

});

