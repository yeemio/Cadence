/**
 * 故障上报（FaultReportId，P2）行为测试：上报即派修（open→assigned：IM 推送 +
 * 维修待办）、fault.resolve 闭环（assigned→resolved：消待办）、机器账本重放对账、
 * 状态机配置合法性（含 REJECT 回退迁移）、幂等与乐观锁守门。
 */
import { describe, expect, it } from 'vitest';
import { UserId, type CommandOutcome, type TenantId } from '@smes/business-core';
import { startApprovalFlow } from '@smes/engine-flow';
import { createInMemoryApprovalEventStore } from '@smes/engine-flow';
import { InMemoryTodoStore } from '../../src/workbench/in-memory-workbench-stores.js';
import type { TodoStore } from '../../src/workbench/workbench-stores.js';
import type { NotifyChannel, NotifyMessage } from '../../src/inspection/inspection-ports.js';
import { BASELINE_COMMAND_KINDS } from '../../src/baseline/baseline-input.js';
import { BASELINE_EVENT_TYPES } from '../../src/baseline/baseline-events.js';
import { DEFAULT_FAULT_REPORT_FLOW_CONFIG } from '../../src/baseline/baseline-fault-config.js';
import { BaselineService } from '../../src/baseline/baseline.service.js';
import { createInMemoryBaselineStores } from '../../src/baseline/in-memory-baseline-stores.js';
import { InMemoryItemStore } from '../../src/masterdata/in-memory-masterdata-stores.js';
import { committedEvents, envelope, freshOperationId, newService, t1, techUser } from './helpers.js';

const repairer = 'u-repair-01';

/** 采集型 IM 端口（测试替身）。 */
class CapturingNotifyChannel implements NotifyChannel {
  readonly messages: { tenant: TenantId; message: NotifyMessage }[] = [];
  async notify(tenant: TenantId, message: NotifyMessage): Promise<void> {
    this.messages.push({ tenant, message });
  }
}

/** 装配带故障线观测的服务（内存待办 + 采集 IM + 内存机器账本）。 */
function newFaultService(options: { todos?: TodoStore } = {}): {
  service: BaselineService;
  todos: InMemoryTodoStore;
  notify: CapturingNotifyChannel;
} {
  const todos = options.todos ?? new InMemoryTodoStore();
  const notify = new CapturingNotifyChannel();
  const service = new BaselineService(
    createInMemoryBaselineStores(),
    new InMemoryItemStore(),
    {},
    { machineEvents: createInMemoryApprovalEventStore(), todos, notify },
  );
  return { service, todos: todos as InMemoryTodoStore, notify };
}

const reportFault = (payload: Record<string, unknown> = {}) =>
  envelope(BASELINE_COMMAND_KINDS.faultReport, {
    equipmentCode: 'EQ-001',
    description: '主轴异响，停机待检',
    assignee: repairer,
    ...payload,
  });

const resolveFault = (faultReportId: string, expectedRevision: number, payload: Record<string, unknown> = {}) =>
  envelope(BASELINE_COMMAND_KINDS.faultResolve, payload, { expectedRevision, operationId: freshOperationId() });

function committedRevision(outcome: CommandOutcome): number {
  if (outcome.status !== 'committed') throw new Error(`expected committed, got '${outcome.status}': ${'reason' in outcome ? outcome.reason : ''}`);
  return outcome.newRevision;
}

describe('fault.report（上报即派修：open → assigned）', () => {
  it('建 open 投影 → ASSIGN 迁移 assigned v2 → IM 推送 + 维修待办 + FaultReported 事件', async () => {
    const { service, todos, notify } = newFaultService();
    const outcome = await service.execute(t1, reportFault());
    expect(committedRevision(outcome)).toBe(2);

    const event = committedEvents(outcome)[0]!;
    expect(event.eventType).toBe(BASELINE_EVENT_TYPES.faultReported);
    expect(event.aggregate.type).toBe('baseline-fault-report');
    expect(event.payload).toMatchObject({
      equipmentCode: 'EQ-001',
      assignee: repairer,
      state: 'assigned',
      objectVersion: 2,
    });
    expect((event.payload as { todoId: string }).todoId).not.toBeNull();

    const list = await service.listFaultReports(t1);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      state: 'assigned',
      objectVersion: 2,
      equipmentCode: 'EQ-001',
      reportedBy: String(techUser),
      assignee: repairer,
      flowConfigId: DEFAULT_FAULT_REPORT_FLOW_CONFIG.flowId,
    });

    // IM 推送挂在 assigned 进入事件（合同 §2）
    expect(notify.messages).toHaveLength(1);
    expect(notify.messages[0]!.message.refType).toBe('baseline-fault-report');

    // 维修待办落在 assignee 名下（TodoStore 端口）
    const own = await todos.listOwn(t1, UserId.create(repairer));
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ source: 'baseline', status: 'open', refType: 'baseline-fault-report' });
    expect(own[0]!.refId).toBe(list[0]!.id as string);
  });

  it('载荷守门：assignee/equipmentCode/description 非法 → rejected；expectedRevision 须 initial', async () => {
    const { service } = newFaultService();
    const noAssignee = await service.execute(t1, reportFault({ assignee: '  ' }));
    expect(noAssignee).toMatchObject({ status: 'rejected' });

    const badEquipment = await service.execute(t1, reportFault({ equipmentCode: '带 空 格' }));
    expect(badEquipment).toMatchObject({ status: 'rejected' });

    const noDescription = await service.execute(t1, reportFault({ description: '' }));
    expect(noDescription).toMatchObject({ status: 'rejected' });

    const wrongRev = await service.execute(t1, envelope(BASELINE_COMMAND_KINDS.faultReport, { equipmentCode: 'EQ-1', description: 'x', assignee: repairer }, { expectedRevision: 1 }));
    expect(wrongRev).toMatchObject({ status: 'rejected' });
    expect((wrongRev as { reason: string }).reason).toContain("'initial'");
  });
});

describe('fault.resolve（闭环：assigned → resolved）', () => {
  it('RESOLVE 迁移 resolved v3 → 消待办 + FaultResolved 事件', async () => {
    const { service, todos } = newFaultService();
    await service.execute(t1, reportFault());
    const [report] = await service.listFaultReports(t1);

    const outcome = await service.execute(t1, resolveFault(report!.id as string, 2, { remark: '更换轴承，恢复运行' }), report!.id as string);
    expect(committedRevision(outcome)).toBe(3);
    const event = committedEvents(outcome)[0]!;
    expect(event.eventType).toBe(BASELINE_EVENT_TYPES.faultResolved);
    expect(event.payload).toMatchObject({ state: 'resolved', objectVersion: 3, remark: '更换轴承，恢复运行' });

    const detail = await service.getFaultReport(t1, report!.id as string);
    expect(detail).toMatchObject({ state: 'resolved', objectVersion: 3, resolvedBy: String(techUser) });
    expect(detail.resolutionRemark).toBe('更换轴承，恢复运行');

    // 闭环消待办（Done-when）
    const own = await todos.listOwn(t1, UserId.create(repairer));
    expect(own).toHaveLength(1);
    expect(own[0]!.status).toBe('done');
  });

  it('守门：不存在 / 乐观锁不符 / 非 assigned 态 / 缺 pathId → rejected', async () => {
    const { service } = newFaultService();
    await service.execute(t1, reportFault());
    const [report] = await service.listFaultReports(t1);
    const id = report!.id as string;

    const missing = await service.execute(t1, resolveFault('fr-not-exist', 1), undefined);
    expect(missing).toMatchObject({ status: 'rejected' });

    const stale = await service.execute(t1, resolveFault(id, 1), id);
    expect(stale).toMatchObject({ status: 'rejected' });
    expect((stale as { reason: string }).reason).toContain('乐观锁冲突');

    const noPath = await service.execute(t1, resolveFault(id, 2));
    expect(noPath).toMatchObject({ status: 'rejected' });
    expect((noPath as { reason: string }).reason).toContain('路径参数');

    // 闭环成功后再 resolve：resolved 终态，仅 assigned 可闭环 → rejected
    await service.execute(t1, resolveFault(id, 2), id);
    const again = await service.execute(t1, resolveFault(id, 3), id);
    expect(again).toMatchObject({ status: 'rejected' });
    expect((again as { reason: string }).reason).toContain('仅已派修单可闭环');
  });

  it('幂等：同 operationId 重复信封 → rejected（不变量 3）', async () => {
    const { service } = newFaultService();
    const fixed = envelope(
      BASELINE_COMMAND_KINDS.faultReport,
      { equipmentCode: 'EQ-001', description: '主轴异响，停机待检', assignee: repairer },
      { operationId: 'op-fault-idem-1' },
    );
    expect((await service.execute(t1, fixed)).status).toBe('committed');
    const dup = await service.execute(t1, fixed);
    expect(dup).toMatchObject({ status: 'rejected' });
    expect((dup as { reason: string }).reason).toContain('operationId');
    expect(await service.listFaultReports(t1)).toHaveLength(1);
  });

  it('队列过滤与跨租户收口：?state=assigned 只见未闭环单', async () => {
    const { service } = newFaultService();
    await service.execute(t1, reportFault({ equipmentCode: 'EQ-A' }));
    await service.execute(t1, reportFault({ equipmentCode: 'EQ-B' }));
    const before = await service.listFaultReports(t1);
    expect(before).toHaveLength(2);
    // 顺序无关：闭环队列首单（createdAt 降序，同毫秒稳定性不依赖），断言剩下的是另一台设备
    const target = before[0]!;
    const other = before.find((row) => row.id !== target.id)!;
    const resolved = await service.execute(t1, resolveFault(target.id as string, 2), target.id as string);
    expect(resolved.status).toBe('committed');

    expect((await service.listFaultReports(t1)).length).toBe(2);
    const assigned = await service.listFaultReports(t1, 'assigned');
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatchObject({ equipmentCode: other.equipmentCode });
  });
});

describe('FaultReport 状态机配置（engine-flow 形态，ADR-0010 分层）', () => {
  it('默认配置合法集：open --ASSIGN--> assigned --RESOLVE--> resolved（终态）；REJECT 回退 assigned→open', () => {
    const config = DEFAULT_FAULT_REPORT_FLOW_CONFIG;
    expect(config.initial).toBe('open');
    expect(config.states.map((state) => state.id)).toEqual(['open', 'assigned', 'resolved']);
    expect(config.transitions).toEqual([
      { from: 'open', event: 'ASSIGN', to: 'assigned', eventAction: 'assigned' },
      { from: 'assigned', event: 'RESOLVE', to: 'resolved', eventAction: 'resolved' },
      { from: 'assigned', event: 'REJECT', to: 'open', eventAction: 'rejected' },
    ]);
    expect(config.states.find((state) => state.id === 'resolved')?.final).toBe(true);

    // 直接驱动 runtime 验证合法集（含 v1 命令面未接的 REJECT 回退迁移）
    const runtime = startApprovalFlow({
      config,
      subject: { aggregate: { id: 'fr-config-probe', type: 'baseline-fault-report' }, initialObjectVersion: 1 },
    });
    try {
      expect(runtime.state()).toBe('open');
      expect(runtime.send('ASSIGN', { by: techUser, reason: 'probe' }).status).toBe('transitioned');
      expect(runtime.state()).toBe('assigned');
      expect(runtime.send('REJECT', { by: techUser, reason: 'probe' }).status).toBe('transitioned');
      expect(runtime.state()).toBe('open'); // 回退后可再派修
      expect(runtime.send('ASSIGN', { by: techUser, reason: 'probe' }).status).toBe('transitioned');
      expect(runtime.send('RESOLVE', { by: techUser, reason: 'probe' }).status).toBe('transitioned');
      expect(runtime.state()).toBe('resolved');
      expect(runtime.objectVersion()).toBe(5); // 初始 1 + 四次迁移（ASSIGN/REJECT/ASSIGN/RESOLVE）
    } finally {
      runtime.stop();
    }
  });

  it('机器事件账本与投影重放对账：上报单重放结果 = assigned@v2（service 内建对账不抛）', async () => {
    const { service } = newFaultService();
    await service.execute(t1, reportFault());
    const [report] = await service.listFaultReports(t1);
    expect(report).toMatchObject({ state: 'assigned', objectVersion: 2 });
    // resolve 内部先 replayFaultReport（不一致即 BaselineConflictError）——通过即对账成立
    const outcome = await service.execute(t1, resolveFault(report!.id as string, 2), report!.id as string);
    expect(outcome.status).toBe('committed');
  });
});

describe('下图统计事实（workorder 附件图纸计数消费端口）', () => {
  it('缺省空实现：未接线时事实查询返回空集（零接线 boot 语义完整）', async () => {
    const service = newService(); // bare 构造（P1 三参体例）
    expect(await service.listDrawingReceiptFacts(t1)).toEqual([]);
  });

  it('接线后透出事实原样（口径归 engine-reporting，本模块不聚合）', async () => {
    const service = new BaselineService(
      createInMemoryBaselineStores(),
      new InMemoryItemStore(),
      {},
      {
        workOrderDrawings: {
          listDrawingCounts: async () => [
            { workOrderId: 'wo-1', drawingCount: 3, asOf: '2026-10-26T04:00:00.000Z' },
            { workOrderId: 'wo-2', drawingCount: 0 },
          ],
        },
      },
    );
    const facts = await service.listDrawingReceiptFacts(t1);
    expect(facts).toEqual([
      { workOrderId: 'wo-1', drawingCount: 3, asOf: '2026-10-26T04:00:00.000Z' },
      { workOrderId: 'wo-2', drawingCount: 0 },
    ]);
  });
});
