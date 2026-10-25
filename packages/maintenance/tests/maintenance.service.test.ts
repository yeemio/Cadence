/**
 * MaintenanceService 行为测试（M3，m3-drafts/02-maintenance.md v1.0 Done-when 与 §7 对账要点）。
 *
 * 覆盖面（差异表逐行 + 合同冻结语义）：
 *  - #1 MaintenanceTask 状态机（scheduled→executing→done + cancelled 仅 scheduled 可撤）
 *    与 maintenance.plan.due-scan.v1 到期扫描（幂等去重；对齐 overdue.scan 先例）；
 *  - #2 存储端口任务面（ports.test.ts 承担类型级；此处验证状态迁移行为）；
 *  - #3 品牌化 ID（行 id 前缀 ckr-/upr-/rpr-/mtk-）；
 *  - #4 故障联动经命令面 faultRef（组合根粘合的适配目标形状）；双侧零 import；
 *  - #5 点检 fail → CheckpointFailed 事件（待办推送维修跟进）；
 *  - #6 命令面全套（发布/扫描/建单/迁移/记录追加）+ 权限码词汇在 config；
 *  - G1 先解析校验后记账（被拒命令不占用 operationId）；
 *  - G2 建单先落 scheduled@v1 初始投影再驱动迁移；
 *  - 版本化计划（改版=新版本；历史记录溯源旧版可解释——planVersion 快照）；
 *  - 三态记录 append-only（追加不改原行）。
 */
import { describe, expect, it } from 'vitest';
import { OperationId, TenantId, UserId, makeCommandEnvelope } from '@smes/business-core';
import {
  InMemoryMaintenanceActivityStore,
  InMemoryMaintenanceDomainEventStore,
  InMemoryMaintenanceOperationStore,
  InMemoryMaintenancePlanStore,
  InMemoryMaintenanceTaskStore,
  MAINTENANCE_EVENT_TYPES,
  MaintenanceInputError,
  MaintenancePlanId,
  MaintenanceService,
  MaintenanceTaskId,
  type MaintenanceCommandEnvelope,
  type MaintenanceCommandKind,
  type MaintenancePlanRow,
  type MaintenanceStores,
  type CreateMaintenancePlanInput,
} from '../src/index.js';
import { randomUUID } from 'node:crypto';

// ---- 测试装配（体例同 payroll.service.test.ts） ----

const TENANT = TenantId.create('t-maintenance-test');
const OPERATOR = UserId.create('u-maint-1');
const NOW = '2026-10-26T08:00:00.000Z';
/** 计划锚点（due-scan occurrence 的确定性锚——固定 createdAt）。 */
const ANCHOR = '2026-10-20T08:00:00.000Z';

/** 锚点固定版计划存储（返回行与内部行同引用——createdAt 补丁对读面生效）。 */
class AnchoredPlanStore extends InMemoryMaintenancePlanStore {
  constructor(private readonly anchorIso: string) {
    super();
  }
  async insert(input: CreateMaintenancePlanInput): Promise<MaintenancePlanRow> {
    const row = await super.insert(input);
    (row as { createdAt: string }).createdAt = this.anchorIso;
    return row;
  }
}

interface Harness {
  readonly service: MaintenanceService;
  readonly stores: MaintenanceStores;
  readonly plans: InMemoryMaintenancePlanStore;
  readonly tasks: InMemoryMaintenanceTaskStore;
  readonly activities: InMemoryMaintenanceActivityStore;
  readonly operations: InMemoryMaintenanceOperationStore;
}

function makeHarness(): Harness {
  const plans = new AnchoredPlanStore(ANCHOR);
  const tasks = new InMemoryMaintenanceTaskStore();
  const activities = new InMemoryMaintenanceActivityStore();
  const events = new InMemoryMaintenanceDomainEventStore();
  const operations = new InMemoryMaintenanceOperationStore();
  const stores: MaintenanceStores = {
    plans,
    tasks,
    activities,
    events,
    operations,
  };
  const service = new MaintenanceService(stores, { now: () => NOW });
  return { service, stores, plans, tasks, activities, operations };
}

let opCounter = 0;
function envelope(
  kind: MaintenanceCommandKind,
  payload: unknown,
  expectedRevision: number | 'initial' = 'initial',
  operationId?: string,
): MaintenanceCommandEnvelope {
  opCounter += 1;
  return makeCommandEnvelope({
    tenantId: TENANT,
    issuedBy: OPERATOR,
    operationId: OperationId.create(operationId ?? `op-maint-${String(opCounter).padStart(4, '0')}`),
    expectedRevision,
    issuedAt: NOW,
    command: { kind, payload },
  });
}

function run(h: Harness, kind: MaintenanceCommandKind, payload: unknown, expectedRevision: number | 'initial' = 'initial', operationId?: string) {
  return h.service.execute(TENANT, envelope(kind, payload, expectedRevision, operationId));
}

const DAILY_PLAN = {
  planId: 'lathe-daily-check',
  name: '车床日保点检',
  resourceRef: 'res-lathe-01',
  cycle: { kind: 'daily' },
  checkpoints: [
    { checkpointId: 'oil-level', label: '油位', expectation: '视窗 1/2~2/3' },
    { checkpointId: 'air-pressure', label: '气压', expectation: '0.4~0.6 MPa' },
  ],
  upkeepActions: ['导轨润滑', '清屑'],
};

const INTERVAL_PLAN = {
  planId: 'mill-weekly-upkeep',
  resourceRef: 'res-mill-01',
  cycle: { kind: 'interval', days: 7 },
  checkpoints: [],
  upkeepActions: ['主轴润滑', '丝杠保养'],
};

async function publish(h: Harness, plan: Record<string, unknown>, expectedRevision: number | 'initial' = 'initial', operationId?: string) {
  return run(h, 'maintenance.plan.publish.v1', plan, expectedRevision, operationId);
}

async function scan(h: Harness, asOf: string, operationId?: string) {
  return run(h, 'maintenance.plan.due-scan.v1', { asOf }, 'initial', operationId);
}

// ---- maintenance.plan.publish.v1（版本化主数据） ----

describe('maintenance.plan.publish.v1', () => {
  it('首发 v1 committed + MaintenancePlanPublished 事件；修订 = 新版本行（历史溯源旧版可解释）', async () => {
    const h = makeHarness();
    const first = await publish(h, DAILY_PLAN);
    expect(first.status).toBe('committed');
    if (first.status !== 'committed') return;
    expect(first.plan?.objectVersion).toBe(1);
    expect(first.plan?.status).toBe('current');
    expect(first.newRevision).toBe(1);
    expect(first.events.map((event) => event.eventType)).toEqual([MAINTENANCE_EVENT_TYPES.planPublished]);
    // 修订（expectedRevision 乐观锁）→ v2 supersedes v1；历史版本仍在
    const second = await publish(h, { ...DAILY_PLAN, upkeepActions: ['导轨润滑', '清屑', '冷却液更换'] }, 1);
    expect(second.status).toBe('committed');
    if (second.status !== 'committed') return;
    expect(second.plan?.objectVersion).toBe(2);
    expect(second.newRevision).toBe(2);
    const chain = await h.service.planVersions(TENANT, MaintenancePlanId.create(DAILY_PLAN.planId));
    expect(chain.map((view) => `${view.planId}@v${view.objectVersion}:${view.status}`)).toEqual([
      'lathe-daily-check@v2:current',
      'lathe-daily-check@v1:superseded',
    ]);
  });

  it('周期/判据门禁：cycle 非法拒绝；点检项重复拒绝；planId 非 kebab 拒绝', async () => {
    const h = makeHarness();
    await expect(publish(h, { ...DAILY_PLAN, cycle: { kind: 'weekly' } })).rejects.toBeInstanceOf(MaintenanceInputError);
    await expect(publish(h, { ...DAILY_PLAN, cycle: { kind: 'interval', days: 0 } })).rejects.toBeInstanceOf(MaintenanceInputError);
    await expect(
      publish(h, { ...DAILY_PLAN, checkpoints: [{ checkpointId: 'oil-level', label: 'a' }, { checkpointId: 'oil-level', label: 'b' }] }),
    ).rejects.toThrowError(/计划内重复/);
    await expect(publish(h, { ...DAILY_PLAN, planId: 'Bad_Case' })).rejects.toThrowError(/kebab-case/);
  });

  it('首发/修订乐观锁：错配 rejected；G1 被拒不占用 operationId（同 id 修正重发成功；已 committed 同 id 幂等拒绝）', async () => {
    const h = makeHarness();
    await publish(h, DAILY_PLAN);
    const rejected = await publish(h, DAILY_PLAN, 'initial', 'op-g1-fix');
    expect(rejected.status).toBe('rejected');
    const retried = await publish(h, DAILY_PLAN, 1, 'op-g1-fix');
    expect(retried.status).toBe('committed');
    const replay = await publish(h, DAILY_PLAN, 2, 'op-g1-fix');
    expect(replay.status).toBe('rejected');
    if (replay.status === 'rejected') expect(replay.reason).toContain('幂等冲突');
    const mismatch = await publish(h, DAILY_PLAN, 7);
    expect(mismatch.status).toBe('rejected');
    if (mismatch.status === 'rejected') expect(mismatch.reason).toContain('乐观锁冲突');
  });
});

// ---- maintenance.plan.due-scan.v1（到期扫描信封命令；对齐 overdue.scan 先例） ----

describe('maintenance.plan.due-scan.v1', () => {
  it('daily 计划：锚点日→asOof 逐日生成到期任务（checkpoint 类）；幂等重扫零追加', async () => {
    const h = makeHarness();
    await publish(h, DAILY_PLAN);
    // 锚点 2026-10-20T08:00Z，asOf 2026-10-26T08:00Z → d:10-20..10-26 共 7 个到期
    const first = await scan(h, '2026-10-26T08:00:00Z', 'op-scan-1');
    expect(first.status).toBe('committed');
    if (first.status !== 'committed') return;
    expect(first.scan?.plansScanned).toBe(1);
    expect(first.scan?.tasksCreated).toBe(7);
    expect(first.scan?.tasks.every((task) => task.source === 'plan-due' && task.kind === 'checkpoint' && task.state === 'scheduled' && task.objectVersion === 1)).toBe(true);
    expect(first.scan?.tasks.every((task) => task.id.startsWith('mtk-'))).toBe(true);
    // 到期锚点幂等：同 asOf 重扫（新 operationId）零追加（对账锚：同计划同 asOf 生成集合确定）
    const second = await scan(h, '2026-10-26T08:00:00Z', 'op-scan-2');
    expect(second.status).toBe('committed');
    if (second.status !== 'committed') return;
    expect(second.scan?.tasksCreated).toBe(0);
    // 次日扫描：只补新到期（d:10-27），且 planVersion 溯源当前版
    const third = await scan(h, '2026-10-27T09:00:00Z', 'op-scan-3');
    expect(third.status).toBe('committed');
    if (third.status !== 'committed') return;
    expect(third.scan?.tasksCreated).toBe(1);
    expect(third.scan?.tasks[0]?.dueKey).toBe('d:2026-10-27');
    expect(third.scan?.tasks[0]?.planVersion).toBe(1);
    // 到期日历：scheduled ∧ dueAt ∈ 窗口
    const calendar = await h.service.dueCalendar(TENANT, '2026-10-26T00:00:00Z', '2026-10-27T23:59:59Z');
    expect(calendar.map((task) => task.dueKey)).toEqual(['d:2026-10-26', 'd:2026-10-27']);
  });

  it('interval 计划：锚点起第 k 个间隔窗口生成（i:k 键）；纯保养计划 → upkeep 类', async () => {
    const h = makeHarness();
    await publish(h, INTERVAL_PLAN);
    // 锚点 2026-10-20T08:00Z，7 天间隔，asOf 2026-10-26T08:00Z → i:0(10-20) 与 i:1(10-27 未到) → 仅 i:0
    const first = await scan(h, '2026-10-26T08:00:00Z');
    expect(first.status).toBe('committed');
    if (first.status !== 'committed') return;
    expect(first.scan?.tasksCreated).toBe(1);
    expect(first.scan?.tasks[0]?.dueKey).toBe('i:0');
    expect(first.scan?.tasks[0]?.kind).toBe('upkeep'); // 无点检项 → 纯保养任务
    // asOf 推进到 10-27T08:00Z（锚点+7d 恰达）→ i:1 补生成
    const second = await scan(h, '2026-10-27T08:00:01Z');
    expect(second.status).toBe('committed');
    if (second.status !== 'committed') return;
    expect(second.scan?.tasksCreated).toBe(1);
    expect(second.scan?.tasks[0]?.dueKey).toBe('i:1');
  });

  it('计划改版不改锚点：修订后重扫不重复生成；新任务溯源新版本 planVersion', async () => {
    const h = makeHarness();
    await publish(h, DAILY_PLAN);
    await scan(h, '2026-10-26T08:00:00Z', 'op-scan-a');
    await publish(h, { ...DAILY_PLAN, checkpoints: [...DAILY_PLAN.checkpoints, { checkpointId: 'belt-wear', label: '皮带磨损' }] }, 1);
    const after = await scan(h, '2026-10-26T08:00:00Z', 'op-scan-b');
    expect(after.status).toBe('committed');
    if (after.status !== 'committed') return;
    expect(after.scan?.tasksCreated).toBe(0); // 同 asOf 同计划：到期锚点与版本无关 → 零重复
    const next = await scan(h, '2026-10-28T08:00:00Z', 'op-scan-c');
    expect(next.status).toBe('committed');
    if (next.status !== 'committed') return;
    const fresh = next.scan?.tasks.find((task) => task.dueKey === 'd:2026-10-28');
    expect(fresh?.planVersion).toBe(2); // 新任务按当前版生成（溯源旧版可解释的锚点）
  });

  it('asOf 早于锚点：零到期 committed（空载荷缺省时钟合法——对齐 overdue.scan 无必填字段）', async () => {
    const h = makeHarness();
    await publish(h, DAILY_PLAN);
    const early = await scan(h, '2026-10-19T00:00:00Z');
    expect(early.status).toBe('committed');
    if (early.status !== 'committed') return;
    expect(early.scan?.tasksCreated).toBe(0);
    expect(early.events).toEqual([]);
    // 缺省 asOf = 服务时钟（NOW=10-26 → 7 个到期）
    const defaulted = await run(h, 'maintenance.plan.due-scan.v1', {});
    expect(defaulted.status).toBe('committed');
    if (defaulted.status !== 'committed') return;
    expect(defaulted.scan?.tasksCreated).toBe(7);
    // expectedRevision 非 initial 拒绝（扫描是执行事实）
    const locked = await run(h, 'maintenance.plan.due-scan.v1', {}, 3);
    expect(locked.status).toBe('rejected');
  });
});

// ---- maintenance.task.create/start/complete/cancel.v1（状态机；G2） ----

describe('maintenance.task.*（状态机命令）', () => {
  it('手工建单：G2 先落 scheduled@v1 投影 + MaintenanceTaskCreated 事件；完整走 start→complete', async () => {
    const h = makeHarness();
    const created = await run(h, 'maintenance.task.create.v1', { resourceRef: 'res-lathe-01', kind: 'upkeep', assignee: 'u-worker-1' });
    expect(created.status).toBe('committed');
    if (created.status !== 'committed') return;
    expect(created.task?.state).toBe('scheduled');
    expect(created.task?.objectVersion).toBe(1); // G2：初始投影 scheduled@v1
    expect(created.task?.source).toBe('manual');
    expect(created.events.map((event) => event.eventType)).toEqual([MAINTENANCE_EVENT_TYPES.taskCreated]);
    const taskId = String(created.task?.id);
    // start：乐观锁 expectedRevision=1 → executing@v2
    const started = await run(h, 'maintenance.task.start.v1', { taskId }, 1);
    expect(started.status).toBe('committed');
    if (started.status !== 'committed') return;
    expect(started.task?.state).toBe('executing');
    expect(started.task?.objectVersion).toBe(2);
    expect(started.task?.startedAt).toBe(NOW);
    expect(started.newRevision).toBe(2);
    const payload = started.events[0]?.payload as { from: string; to: string };
    expect(payload.from).toBe('scheduled');
    expect(payload.to).toBe('executing');
    // complete：expectedRevision=2 → done@v3（终态）
    const completed = await run(h, 'maintenance.task.complete.v1', { taskId }, 2);
    expect(completed.status).toBe('committed');
    if (completed.status !== 'committed') return;
    expect(completed.task?.state).toBe('done');
    expect(completed.task?.completedAt).toBe(NOW);
  });

  it('故障联动建单（差异表 #4：经命令面 faultRef，组合根粘合）：source=fault + kind=repair；faultRef 挂非 repair 拒绝', async () => {
    const h = makeHarness();
    const faultTask = await run(h, 'maintenance.task.create.v1', {
      resourceRef: 'res-lathe-01',
      kind: 'repair',
      faultRef: 'fault-17',
      assignee: 'u-repair-1',
    });
    expect(faultTask.status).toBe('committed');
    if (faultTask.status !== 'committed') return;
    expect(faultTask.task?.source).toBe('fault');
    expect(faultTask.task?.faultRef).toBe('fault-17');
    const eventPayload = faultTask.events[0]?.payload as { faultRef: string | null; source: string };
    expect(eventPayload.faultRef).toBe('fault-17');
    expect(eventPayload.source).toBe('fault');
    await expect(
      run(h, 'maintenance.task.create.v1', { resourceRef: 'res-lathe-01', kind: 'checkpoint', faultRef: 'fault-18' }),
    ).rejects.toThrowError(/只能挂在 repair 任务/);
  });

  it('撤销支：仅 scheduled 可撤（合同 §2）；executing 撤单被配置拒绝', async () => {
    const h = makeHarness();
    const created = await run(h, 'maintenance.task.create.v1', { resourceRef: 'res-lathe-01', kind: 'checkpoint' });
    const taskId = String((created as { task?: { id: string } }).task?.id);
    const cancelled = await run(h, 'maintenance.task.cancel.v1', { taskId, reason: '计划变更' }, 1);
    expect(cancelled.status).toBe('committed');
    if (cancelled.status !== 'committed') return;
    expect(cancelled.task?.state).toBe('cancelled');
    expect(cancelled.task?.cancelReason).toBe('计划变更');
    // executing 不可撤：状态机配置拒绝（SCREAMING 动词无 scheduled 外规则）
    const other = await run(h, 'maintenance.task.create.v1', { resourceRef: 'res-lathe-01', kind: 'repair' });
    const otherId = String((other as { task?: { id: string } }).task?.id);
    await run(h, 'maintenance.task.start.v1', { taskId: otherId }, 1);
    const denied = await run(h, 'maintenance.task.cancel.v1', { taskId: otherId }, 2);
    expect(denied.status).toBe('rejected');
    if (denied.status === 'rejected') expect(denied.reason).toContain('无迁移规则');
  });

  it('乐观锁与存在性：expectedRevision 错配/任务不存在 rejected；G1 被拒不占用 operationId', async () => {
    const h = makeHarness();
    const created = await run(h, 'maintenance.task.create.v1', { resourceRef: 'res-lathe-01', kind: 'repair' });
    const taskId = String((created as { task?: { id: string } }).task?.id);
    const wrongLock = await run(h, 'maintenance.task.start.v1', { taskId }, 9, 'op-g1-task');
    expect(wrongLock.status).toBe('rejected');
    // 同 id 修正重发（expectedRevision=1）→ committed（被拒不占用 operationId）
    const fixed = await run(h, 'maintenance.task.start.v1', { taskId }, 1, 'op-g1-task');
    expect(fixed.status).toBe('committed');
    const replay = await run(h, 'maintenance.task.start.v1', { taskId }, 2, 'op-g1-task');
    expect(replay.status).toBe('rejected');
    const missing = await run(h, 'maintenance.task.start.v1', { taskId: `mtk-${randomUUID()}` }, 1);
    expect(missing.status).toBe('rejected');
    if (missing.status === 'rejected') expect(missing.reason).toContain('不存在维保任务');
    // initial 不是迁移合法锁
    const initial = await run(h, 'maintenance.task.start.v1', { taskId: String((fixed as { task?: { id: string } }).task?.id) });
    expect(initial.status).toBe('rejected');
  });

  it('手工建单挂计划溯源：planId 必须存在；planVersion 快照当前版', async () => {
    const h = makeHarness();
    await publish(h, DAILY_PLAN);
    const missing = await run(h, 'maintenance.task.create.v1', { resourceRef: 'res-lathe-01', kind: 'checkpoint', planId: 'no-such-plan' });
    expect(missing.status).toBe('rejected');
    if (missing.status === 'rejected') expect(missing.reason).toContain('不存在');
    const linked = await run(h, 'maintenance.task.create.v1', { resourceRef: 'res-lathe-01', kind: 'checkpoint', planId: DAILY_PLAN.planId });
    expect(linked.status).toBe('committed');
    if (linked.status !== 'committed') return;
    expect(linked.task?.planVersion).toBe(1);
  });
});

// ---- maintenance.record.append.v1（三态记录 append-only） ----

describe('maintenance.record.append.v1', () => {
  async function harnessWithPlanAndTask(): Promise<{
    h: Harness;
    taskId: string;
  }> {
    const h = makeHarness();
    await publish(h, DAILY_PLAN);
    const created = await run(h, 'maintenance.task.create.v1', {
      resourceRef: 'res-lathe-01',
      kind: 'checkpoint',
      planId: DAILY_PLAN.planId,
      assignee: 'u-worker-1',
    });
    const taskId = String((created as { task?: { id: string } }).task?.id);
    return { h, taskId };
  }

  it('点检按判据逐项 pass/fail 留痕（计划判据清单校验）+ planVersion 快照 + 任务关联', async () => {
    const { h, taskId } = await harnessWithPlanAndTask();
    const pass = await run(h, 'maintenance.record.append.v1', {
      kind: 'checkpoint',
      resourceRef: 'res-lathe-01',
      taskId,
      planId: DAILY_PLAN.planId,
      checkpointId: 'oil-level',
      result: 'pass',
    });
    expect(pass.status).toBe('committed');
    if (pass.status !== 'committed') return;
    expect(pass.record?.kind).toBe('checkpoint');
    expect((pass.record as { id: string }).id.startsWith('ckr-')).toBe(true);
    expect(pass.record?.planVersion).toBe(1);
    expect(pass.events.map((event) => event.eventType)).toEqual([MAINTENANCE_EVENT_TYPES.activityAppended]);
    // 判据清单外点检项拒绝（点检按判据逐项，Done-when）
    const unknown = await run(h, 'maintenance.record.append.v1', {
      kind: 'checkpoint',
      resourceRef: 'res-lathe-01',
      planId: DAILY_PLAN.planId,
      checkpointId: 'no-such-checkpoint',
      result: 'pass',
    });
    expect(unknown.status).toBe('rejected');
    if (unknown.status === 'rejected') expect(unknown.reason).toContain('判据清单内');
    // 挂不存在计划/任务拒绝
    const noPlan = await run(h, 'maintenance.record.append.v1', { kind: 'upkeep', resourceRef: 'res-lathe-01', planId: 'ghost-plan' });
    expect(noPlan.status).toBe('rejected');
    const noTask = await run(h, 'maintenance.record.append.v1', { kind: 'repair', resourceRef: 'res-lathe-01', taskId: `mtk-${randomUUID()}`, restored: true });
    expect(noTask.status).toBe('rejected');
    // 任务设备不一致拒绝（留痕设备收口）
    const mismatch = await run(h, 'maintenance.record.append.v1', { kind: 'checkpoint', resourceRef: 'res-other', taskId, checkpointId: 'x', result: 'pass' });
    expect(mismatch.status).toBe('rejected');
  });

  it('点检 fail → CheckpointFailed 事件携判据（差异表 #5：fail 进待办推送维修跟进）', async () => {
    const { h } = await harnessWithPlanAndTask();
    const failed = await run(h, 'maintenance.record.append.v1', {
      kind: 'checkpoint',
      resourceRef: 'res-lathe-01',
      planId: DAILY_PLAN.planId,
      checkpointId: 'oil-level',
      result: 'fail',
      note: '低于视窗下限',
    });
    expect(failed.status).toBe('committed');
    if (failed.status !== 'committed') return;
    expect(failed.events.map((event) => event.eventType)).toEqual([
      MAINTENANCE_EVENT_TYPES.activityAppended,
      MAINTENANCE_EVENT_TYPES.checkpointFailed,
    ]);
    const payload = failed.events[1]?.payload as { checkpointId: string; expectation: string | null };
    expect(payload.checkpointId).toBe('oil-level');
    expect(payload.expectation).toBe('视窗 1/2~2/3');
  });

  it('保养动作清单 + 维修处置（faultRef 引用 + 是否恢复）留痕；append-only：追加不改原行', async () => {
    const { h } = await harnessWithPlanAndTask();
    const upkeep = await run(h, 'maintenance.record.append.v1', {
      kind: 'upkeep',
      resourceRef: 'res-lathe-01',
      planId: DAILY_PLAN.planId,
      actionsDone: ['导轨润滑'],
    });
    expect(upkeep.status).toBe('committed');
    if (upkeep.status !== 'committed') return;
    expect((upkeep.record as { id: string }).id.startsWith('upr-')).toBe(true);
    expect((upkeep.record as { actionsDone?: string[] }).actionsDone).toEqual(['导轨润滑']);
    const repair = await run(h, 'maintenance.record.append.v1', {
      kind: 'repair',
      resourceRef: 'res-lathe-01',
      faultRef: 'fault-17',
      restored: true,
    });
    expect(repair.status).toBe('committed');
    if (repair.status !== 'committed') return;
    expect((repair.record as { id: string }).id.startsWith('rpr-')).toBe(true);
    expect((repair.record as { restored: boolean }).restored).toBe(true);
    // append-only：首条记录在后续追加后原值不变（修正走冲销/补录，不改原行）
    const firstRow = upkeep.record;
    const later = await run(h, 'maintenance.record.append.v1', { kind: 'upkeep', resourceRef: 'res-lathe-01', actionsDone: ['清屑'] });
    expect(later.status).toBe('committed');
    const history = await h.service.resourceHistory(TENANT, { resourceRef: 'res-lathe-01' });
    const original = history.find((row) => row.id === firstRow?.id);
    expect(original).toEqual(firstRow);
    // 载荷校验：restored 非布尔拒绝；result 非法拒绝
    await expect(run(h, 'maintenance.record.append.v1', { kind: 'repair', resourceRef: 'res-lathe-01', restored: 'yes' })).rejects.toBeInstanceOf(MaintenanceInputError);
    await expect(run(h, 'maintenance.record.append.v1', { kind: 'checkpoint', resourceRef: 'res-lathe-01', checkpointId: 'oil-level', result: 'unknown' })).rejects.toBeInstanceOf(MaintenanceInputError);
    await expect(run(h, 'maintenance.record.append.v1', { kind: 'other', resourceRef: 'res-lathe-01' })).rejects.toThrowError(/checkpoint\/upkeep\/repair/);
  });

  it('设备维保历史查询：按设备×kind×时间窗过滤（台账维度下钻，Done-when）', async () => {
    const { h } = await harnessWithPlanAndTask();
    await run(h, 'maintenance.record.append.v1', { kind: 'checkpoint', resourceRef: 'res-lathe-01', checkpointId: 'oil-level', result: 'pass', performedAt: '2026-10-25T08:00:00Z' });
    await run(h, 'maintenance.record.append.v1', { kind: 'upkeep', resourceRef: 'res-lathe-01', actionsDone: ['导轨润滑'], performedAt: '2026-10-26T09:00:00Z' });
    await run(h, 'maintenance.record.append.v1', { kind: 'checkpoint', resourceRef: 'res-mill-01', checkpointId: 'oil-level', result: 'pass', performedAt: '2026-10-26T10:00:00Z' });
    const byKind = await h.service.resourceHistory(TENANT, { resourceRef: 'res-lathe-01', kind: 'checkpoint' });
    expect(byKind).toHaveLength(1);
    const byWindow = await h.service.resourceHistory(TENANT, { resourceRef: 'res-lathe-01', from: '2026-10-26T00:00:00Z', to: '2026-10-27T00:00:00Z' });
    expect(byWindow).toHaveLength(1);
    expect(byWindow[0]?.kind).toBe('upkeep');
    const other = await h.service.resourceHistory(TENANT, { resourceRef: 'res-mill-01' });
    expect(other).toHaveLength(1);
  });
});

// ---- 查询面与任务队列 ----

describe('查询面', () => {
  it('计划表按设备过滤；我的任务（本人数据权限）；任务队列过滤', async () => {
    const h = makeHarness();
    await publish(h, DAILY_PLAN);
    await publish(h, INTERVAL_PLAN);
    const plans = await h.service.plans(TENANT, 'res-mill-01');
    expect(plans.map((view) => view.planId)).toEqual(['mill-weekly-upkeep']);
    const created = await run(h, 'maintenance.task.create.v1', { resourceRef: 'res-lathe-01', kind: 'repair', assignee: 'u-worker-1' });
    await run(h, 'maintenance.task.create.v1', { resourceRef: 'res-lathe-01', kind: 'upkeep', assignee: 'u-worker-2' });
    const mine = await h.service.myTasks(TENANT, UserId.create('u-worker-1'));
    expect(mine).toHaveLength(1);
    expect(mine[0]?.id).toBe((created as { task?: { id: string } }).task?.id);
    const queue = await h.service.taskQueue(TENANT, { resourceRef: 'res-lathe-01', state: 'scheduled' });
    expect(queue).toHaveLength(2);
    await expect(h.service.planVersions(TENANT, MaintenancePlanId.create('ghost-plan'))).rejects.toThrowError(/不存在维保计划/);
    await expect(h.service.taskDetail(TENANT, MaintenanceTaskId.create(`mtk-${randomUUID()}`))).rejects.toThrowError(/不存在维保任务/);
    // 事件读面：全部维护事件按 occurredAt 升序
    const events = await h.service.listEvents(TENANT);
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.map((event) => event.eventType)).toContain(MAINTENANCE_EVENT_TYPES.taskCreated);
  });
});
