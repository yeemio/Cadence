import { describe, expect, expectTypeOf, it } from 'vitest';
import { TenantId, UserId, WorkOrderId } from '@smes/business-core';
import {
  CheckpointRecordId,
  MaintenancePlanId,
  MaintenanceTaskId,
  RepairRecordId,
  UpkeepRecordId,
  type MaintenanceActivityRow,
  type MaintenancePlanRow,
  type MaintenanceStores,
  type MaintenanceTaskRow,
} from '../src/index.js';

/**
 * 端口形状（类型级）。M3 冻结合同 v1.0 §8 定稿形状：品牌化
 * MaintenancePlanId/MaintenanceTaskId/CheckpointRecordId/UpkeepRecordId/
 * RepairRecordId（差异表 #3）、任务面扩展进存储端口（差异表 #2）、
 * MaintenanceTask 状态机（差异表 #1）。原 3 用例的断言意图不变
 * （可构造可冻结 / kind 判别收窄 / 端口可实现可异步消费），仅按定稿形状最小适配
 * ——体例同 payroll ports.test.ts。
 */
describe('maintenance 端口形状（类型级）', () => {
  it('维保计划版本行可构造、可冻结（版本化数据；判据是数据不是枚举）', () => {
    const plan: MaintenancePlanRow = Object.freeze({
      id: 'mpl-00000000-0000-7000-8000-000000000001',
      tenant: TenantId.create('t-1'),
      planId: MaintenancePlanId.create('lathe-daily-check'),
      name: '车床日保点检',
      resourceRef: '0199a0aa-uuidv7-shape',
      cycle: { kind: 'daily' } as const,
      checkpoints: [
        { checkpointId: 'oil-level', label: '油位', expectation: '视窗 1/2~2/3' },
        { checkpointId: 'air-pressure', label: '气压', expectation: '0.4~0.6 MPa' },
      ],
      upkeepActions: ['导轨润滑', '清屑'],
      objectVersion: 1,
      supersedes: null,
      auditStatus: 'published',
      createdAt: '2026-10-25T08:00:00.000Z',
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan.cycle).toEqual({ kind: 'daily' });
    expect(plan.checkpoints.length).toBe(2);
    expectTypeOf(plan.planId).toEqualTypeOf<MaintenancePlanId>();
    expectTypeOf<MaintenancePlanRow['cycle']>().toMatchTypeOf<{ kind: 'daily' } | { kind: 'interval'; days: number }>();
  });

  it('三态记录（点检/保养/维修）可构造、可冻结，kind 判别收窄；品牌隔离编译期拦截', () => {
    const checkpoint = Object.freeze({
      kind: 'checkpoint',
      id: CheckpointRecordId.create('ckr-1'),
      tenant: TenantId.create('t-1'),
      seq: 1,
      resourceRef: 'resource-1',
      planId: MaintenancePlanId.create('lathe-daily-check'),
      planVersion: 2,
      checkpointId: 'oil-level',
      performedBy: UserId.create('user-1'),
      performedAt: '2026-10-25T08:00:00Z',
      result: 'pass',
      occurredAt: '2026-10-25T08:00:01Z',
      recordedBy: 'user-1',
      objectVersion: 1,
      auditStatus: 'recorded',
    }) satisfies Extract<MaintenanceActivityRow, { kind: 'checkpoint' }>;
    const upkeep = Object.freeze({
      kind: 'upkeep',
      id: UpkeepRecordId.create('upr-1'),
      tenant: TenantId.create('t-1'),
      seq: 2,
      resourceRef: 'resource-1',
      performedBy: UserId.create('user-1'),
      performedAt: '2026-10-25T09:00:00Z',
      actionsDone: ['导轨润滑'],
      occurredAt: '2026-10-25T09:00:01Z',
      recordedBy: 'user-1',
      objectVersion: 1,
      auditStatus: 'recorded',
    }) satisfies Extract<MaintenanceActivityRow, { kind: 'upkeep' }>;
    const repair = Object.freeze({
      kind: 'repair',
      id: RepairRecordId.create('rpr-1'),
      tenant: TenantId.create('t-1'),
      seq: 3,
      resourceRef: 'resource-1',
      performedBy: UserId.create('user-2'),
      performedAt: '2026-10-25T11:00:00Z',
      faultRef: 'fault-17',
      restored: true,
      occurredAt: '2026-10-25T11:00:01Z',
      recordedBy: 'user-2',
      objectVersion: 1,
      auditStatus: 'recorded',
    }) satisfies Extract<MaintenanceActivityRow, { kind: 'repair' }>;
    for (const record of [checkpoint, upkeep, repair] as const) {
      expect(Object.isFrozen(record)).toBe(true);
    }
    // kind 判别联合收窄：checkpoint 分支可见 result，不可见 restored
    const activity: MaintenanceActivityRow = checkpoint;
    if (activity.kind === 'checkpoint') {
      expect(activity.result).toBe('pass');
      expectTypeOf(activity.result).toEqualTypeOf<'pass' | 'fail'>();
      // @ts-expect-error restored 只在 repair 分支（判别收窄，编译期拦截）
      activity.restored;
    }
    // performedBy 全三态为品牌化 UserId；faultRef 为 baseline 形状引用（字符串）
    expectTypeOf(checkpoint.performedBy).toEqualTypeOf<UserId>();
    expectTypeOf(upkeep.performedBy).toEqualTypeOf<UserId>();
    expectTypeOf(repair.performedBy).toEqualTypeOf<UserId>();
    expectTypeOf<Extract<MaintenanceActivityRow, { kind: 'repair' }>['faultRef']>().toEqualTypeOf<string | undefined>();
    // 品牌隔离（差异表 #3）：裸字符串不能当品牌化 id；WorkOrderId 不是 UserId
    // @ts-expect-error 裸字符串不能当品牌化 id（编译期拦截；反向——品牌可读作 string）
    const notBranded: MaintenanceTaskId = 'mtk-1';
    // @ts-expect-error WorkOrderId 不是 UserId（品牌隔离，编译期拦截）
    expectTypeOf<WorkOrderId>().toMatchTypeOf<UserId>();
    expect(notBranded).toBe('mtk-1');
    expect(MaintenanceTaskId.create('mtk-1')).toBe('mtk-1');
  });

  it('存储端口可实现并异步消费（差异表 #2：任务面扩展——fake 证明形状自洽，append-only 语义在实现侧）', async () => {
    const appended: MaintenanceActivityRow[] = [];
    const tasks: MaintenanceTaskRow[] = [];
    const stores: MaintenanceStores = {
      plans: {
        insert: async (input) => ({ ...input, id: 'mpl-x', createdAt: '2026-10-25T00:00:00Z' }),
        versions: async (tenant, planId) =>
          planId === MaintenancePlanId.create('lathe-daily-check')
            ? [{ planId, tenant, cycle: { kind: 'daily' }, checkpoints: [], upkeepActions: [], objectVersion: 1, supersedes: null, auditStatus: 'published', id: 'mpl-x', name: null, resourceRef: 'resource-1', createdAt: '2026-10-25T00:00:00Z' }]
            : [],
        listAll: async () => [],
      },
      tasks: {
        insert: async (input) => {
          const row: MaintenanceTaskRow = { ...input, id: MaintenanceTaskId.create('mtk-9'), createdAt: '2026-10-25T12:00:00Z' };
          tasks.push(row);
          return row;
        },
        find: async (tenant, id) => tasks.find((task) => task.tenant === tenant && task.id === id) ?? null,
        advance: async (tenant, id, expected, next) => {
          const index = tasks.findIndex((task) => task.tenant === tenant && task.id === id && task.objectVersion === expected);
          return index === -1 ? null : (tasks[index] = { ...tasks[index]!, ...next });
        },
        list: async (tenant) => tasks.filter((task) => task.tenant === tenant),
      },
      activities: {
        insert: async (input) => {
          const row = {
            ...input,
            id: RepairRecordId.create('rpr-9'),
            seq: appended.length + 1,
            objectVersion: 1,
          } as MaintenanceActivityRow;
          appended.push(row);
          return row;
        },
        list: async (tenant, query) =>
          appended.filter(
            (activity) =>
              activity.tenant === tenant &&
              (query?.kind === undefined || activity.kind === query.kind) &&
              (query?.resourceRef === undefined || activity.resourceRef === query.resourceRef),
          ),
      },
      events: { append: async () => {}, list: async () => [] },
      operations: { claim: async () => true },
    };
    // 计划读取面
    expect((await stores.plans.versions(TenantId.create('t-1'), MaintenancePlanId.create('lathe-daily-check'))).length).toBe(1);
    // 任务面（差异表 #2：创建/迁移/查询）
    const task = await stores.tasks.insert({
      tenant: TenantId.create('t-1'),
      flowConfigId: 'maintenance-task',
      source: 'fault',
      kind: 'repair',
      resourceRef: 'resource-1',
      faultRef: 'fault-17',
      state: 'scheduled',
      objectVersion: 1,
      createdBy: 'user-1',
    });
    expect(task.state).toBe('scheduled');
    const advanced = await stores.tasks.advance(TenantId.create('t-1'), task.id, 1, { state: 'executing', objectVersion: 2, startedAt: '2026-10-25T13:00:00Z' });
    expect(advanced?.state).toBe('executing');
    expect(await stores.tasks.advance(TenantId.create('t-1'), task.id, 1, { state: 'done', objectVersion: 3 })).toBeNull(); // 乐观锁失配
    // 三态记录追加/读取面
    await stores.activities.insert({
      kind: 'repair',
      tenant: TenantId.create('t-1'),
      resourceRef: 'resource-1',
      performedBy: UserId.create('user-2'),
      performedAt: '2026-10-25T12:00:00Z',
      restored: false,
      occurredAt: '2026-10-25T12:00:01Z',
      recordedBy: 'user-2',
      auditStatus: 'recorded',
    });
    const repairs = await stores.activities.list(TenantId.create('t-1'), { kind: 'repair', resourceRef: 'resource-1' });
    expect(repairs.length).toBe(1);
    expect(repairs[0] && repairs[0].kind === 'repair' ? repairs[0].restored : undefined).toBe(false);
  });
});
