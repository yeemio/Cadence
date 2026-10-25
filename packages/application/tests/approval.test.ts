/**
 * 审批模块测试（M1 收尾波-①）：端口内存实现合同、用例编排（start/act 全路径、
 * 版本冲突、状态冲突、待办联动、配置注入形状）、输入解析边界、控制器权限码、
 * 模块装配。全部零框架直连（内存实现 + engine-flow 内存账本）。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TenantId, UserId } from '@smes/business-core';
import {
  createInMemoryApprovalEventStore,
  createInMemoryApprovalRecordStore,
  defineApprovalFlowConfig,
  DEFAULT_APPROVAL_FLOW_CONFIG,
} from '@smes/engine-flow';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import {
  PERMISSION_METADATA_KEY,
  InMemoryApprovalCaseStore,
  InMemoryTodoStore,
  ApprovalModule,
  ApprovalService,
  ApprovalConflictError,
  ApprovalInputError,
  ApprovalNotFoundError,
  ApprovalStateError,
} from '../src/index.js';
import { ApprovalCasesController } from '../src/approval/approval.controllers.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');
const alice = UserId.create('alice');
const bob = UserId.create('bob');

function newApproval(options?: ConstructorParameters<typeof ApprovalService>[4]) {
  const cases = new InMemoryApprovalCaseStore();
  const records = createInMemoryApprovalRecordStore();
  const events = createInMemoryApprovalEventStore();
  const todos = new InMemoryTodoStore();
  const service = new ApprovalService(cases, records, events, todos, options);
  return { cases, records, events, todos, service };
}

async function startedCase(service: ApprovalService, approvers = [alice]) {
  return service.start(t1, bob, {
    subjectRef: { type: 'item', id: 'item-1' },
    approvers,
    reason: '采购前请审批',
  });
}

describe('案件端口（内存实现，租户收口 + 乐观推进）', () => {
  it('create/list/find 按租户收口；list 新的在前、状态过滤精确', async () => {
    const store = new InMemoryApprovalCaseStore();
    const a = await store.create({
      tenant: t1, id: 'case-a', flowConfigId: 'general-approval', state: 'in_review',
      objectVersion: 3, subjectRef: { type: 'item', id: 'i1' }, submitter: bob,
    });
    await new Promise((resolve) => setTimeout(resolve, 3)); // createdAt 毫秒可分
    await store.create({
      tenant: t1, id: 'case-b', flowConfigId: 'general-approval', state: 'approved',
      objectVersion: 4, subjectRef: { type: 'item', id: 'i2' }, submitter: bob,
    });
    expect((await store.list(t1)).map((c) => c.id)).toEqual(['case-b', 'case-a']);
    expect((await store.list(t1, { state: 'in_review' })).map((c) => c.id)).toEqual(['case-a']);
    expect(await store.find(t2, 'case-a')).toBeNull(); // 跨租户不可见
    expect((await store.find(t1, 'case-a'))?.subjectRef).toEqual({ type: 'item', id: 'i1' });
    expect(a.objectVersion).toBe(3);
  });

  it('advance：版本相符才推进；不符/不存在 → ApprovalConflictError', async () => {
    const store = new InMemoryApprovalCaseStore();
    await store.create({
      tenant: t1, id: 'case-a', flowConfigId: 'general-approval', state: 'in_review',
      objectVersion: 3, subjectRef: { type: 'item', id: 'i1' }, submitter: bob,
    });
    const advanced = await store.advance(t1, 'case-a', 3, 'approved', 4);
    expect(advanced.state).toBe('approved');
    expect(advanced.objectVersion).toBe(4);
    await expect(store.advance(t1, 'case-a', 3, 'rejected', 4)).rejects.toBeInstanceOf(ApprovalConflictError);
    await expect(store.advance(t1, 'ghost', 1, 'x', 2)).rejects.toBeInstanceOf(ApprovalConflictError);
  });
});

describe('发起审批（start）', () => {
  it('默认配置：建案落到 in_review@v3，两名审批人各得一条待办，事件账本两条', async () => {
    const { service, todos } = newApproval();
    const result = await service.start(t1, bob, {
      subjectRef: { type: 'item', id: 'item-9' },
      approvers: [alice, bob, alice], // 重复审批人去重
      title: '请审这批物品',
      reason: '采购前请审批',
    });
    expect(result.case.state).toBe('in_review');
    expect(result.case.objectVersion).toBe(3); // 初始 1 + SUBMIT + START_REVIEW
    expect(result.case.flowConfigId).toBe('general-approval');
    expect(result.case.submitter).toBe(bob);
    expect(result.case.subjectRef).toEqual({ type: 'item', id: 'item-9' });
    expect(result.events.map((e) => e.eventType)).toEqual([
      'smes.general-approval.v1.submitted',
      'smes.general-approval.v1.review-started',
    ]);
    expect(result.todosCreated.length).toBe(2); // 去重后 alice + bob
    const aliceTodos = await todos.listOwn(t1, alice);
    expect(aliceTodos.length).toBe(1);
    expect(aliceTodos[0]!.source).toBe('approval');
    expect(aliceTodos[0]!.refId).toBe(result.case.id);
    expect(aliceTodos[0]!.title).toBe('请审这批物品');
    const defaultTitle = await (await startedCase(service)).case;
    // 缺省标题由 subjectRef 组合
    const again = await service.start(t1, bob, { subjectRef: { type: 'item', id: 'x' }, approvers: [alice], reason: 'r' });
    expect((await todos.listOwn(t1, alice)).some((todo) => todo.title === '审批：item/x' && todo.refId === again.case.id)).toBe(true);
    expect(defaultTitle).toBeDefined();
  });

  it('reviewEvent=null：发起后停在 submitted（配置注入形状）', async () => {
    const { service } = newApproval({ config: DEFAULT_APPROVAL_FLOW_CONFIG, submitEvent: 'SUBMIT', reviewEvent: null });
    const result = await startedCase(service);
    expect(result.case.state).toBe('submitted');
    expect(result.case.objectVersion).toBe(2);
  });

  it('整份配置可替换：换 flowId 即换事件命名空间与状态集', async () => {
    const config = defineApprovalFlowConfig({
      schemaVersion: 1,
      flowId: 'two-step',
      initial: 'draft',
      states: [{ id: 'draft' }, { id: 'pending' }, { id: 'closed', final: true }],
      transitions: [
        { from: 'draft', event: 'SUBMIT', to: 'pending', eventAction: 'submitted' },
        { from: 'pending', event: 'CLOSE', to: 'closed', decision: 'approve' },
      ],
    });
    const { service } = newApproval({ config, submitEvent: 'SUBMIT', reviewEvent: null });
    const result = await service.start(t1, bob, {
      subjectRef: { type: 'item', id: 'i' },
      approvers: [alice],
      reason: '两步走',
    });
    expect(result.case.state).toBe('pending');
    expect(result.events[0]!.eventType).toBe('smes.two-step.v1.submitted');
    const acted = await service.act(t1, result.case.id, alice, { decision: 'approve', reason: '可以' });
    expect(acted.case.state).toBe('closed');
    expect(acted.event.eventType).toBe('smes.two-step.v1.close'); // 缺省 eventAction = 命令小写全形
  });

  it('非法输入：subjectRef 形状 / 空审批人 / 空理由 → ApprovalInputError', async () => {
    const { service } = newApproval();
    await expect(service.start(t1, bob, { subjectRef: { type: 'Item', id: 'x' }, approvers: [alice], reason: 'r' }))
      .rejects.toBeInstanceOf(ApprovalInputError);
    await expect(service.start(t1, bob, { subjectRef: { type: 'item', id: 'x' }, approvers: [], reason: 'r' }))
      .rejects.toBeInstanceOf(ApprovalInputError);
    await expect(service.start(t1, bob, { subjectRef: { type: 'item', id: 'x' }, approvers: [alice], reason: '  ' }))
      .rejects.toBeInstanceOf(ApprovalInputError);
  });
});

describe('审批决策（act）', () => {
  it('approve：案件 approved@v4，决策记录落账，审批人本人待办自动完成', async () => {
    const { service, todos } = newApproval();
    const started = await startedCase(service, [alice]);
    const acted = await service.act(t1, started.case.id, alice, {
      decision: 'approve',
      reason: '同意采购',
      objectVersion: 3,
    });
    expect(acted.case.state).toBe('approved');
    expect(acted.case.objectVersion).toBe(4);
    expect(acted.record?.decision).toBe('approve');
    expect(acted.record?.reviewer).toBe(alice);
    expect(acted.event.eventType).toBe('smes.general-approval.v1.approved');
    expect(acted.todosCompleted.length).toBe(1);
    expect((await todos.listOwn(t1, alice))[0]!.status).toBe('done');
  });

  it('reject 路径一例：案件 rejected，记录 decision=reject', async () => {
    const { service } = newApproval();
    const started = await startedCase(service, [alice]);
    const acted = await service.act(t1, started.case.id, alice, { decision: 'reject', reason: '预算不足' });
    expect(acted.case.state).toBe('rejected');
    expect(acted.record?.decision).toBe('reject');
  });

  it('withdraw 路径：发起人撤回（submitted 态可 withdraw）', async () => {
    const { service } = newApproval({ config: DEFAULT_APPROVAL_FLOW_CONFIG, submitEvent: 'SUBMIT', reviewEvent: null });
    const started = await startedCase(service, [alice]);
    const acted = await service.act(t1, started.case.id, bob, { decision: 'withdraw', reason: '计划变更' });
    expect(acted.case.state).toBe('withdrawn');
  });

  it('版本冲突：过期 objectVersion → ApprovalConflictError；不带声明则放行（默认配置无守卫）', async () => {
    const { service } = newApproval();
    const started = await startedCase(service, [alice]);
    await expect(
      service.act(t1, started.case.id, alice, { decision: 'approve', reason: 'r', objectVersion: 2 }),
    ).rejects.toBeInstanceOf(ApprovalConflictError);
    const acted = await service.act(t1, started.case.id, alice, { decision: 'approve', reason: 'r' });
    expect(acted.case.state).toBe('approved'); // 无声明版本：默认配置无守卫，放行
  });

  it('状态冲突：终态案件再决策 → ApprovalStateError（unhandled）', async () => {
    const { service } = newApproval();
    const started = await startedCase(service, [alice]);
    await service.act(t1, started.case.id, alice, { decision: 'approve', reason: 'r' });
    await expect(
      service.act(t1, started.case.id, alice, { decision: 'reject', reason: 'r' }),
    ).rejects.toBeInstanceOf(ApprovalStateError);
  });

  it('重放对账：案件行与事件账本不一致 → ApprovalStateError（不静默继续）', async () => {
    const { service, cases } = newApproval();
    const started = await startedCase(service, [alice]);
    // 直接篡改投影行（模拟中断写入）：advance 不经引擎多走一步
    await cases.advance(t1, started.case.id, 3, 'escalated', 4);
    await expect(
      service.act(t1, started.case.id, alice, { decision: 'approve', reason: 'r' }),
    ).rejects.toBeInstanceOf(ApprovalStateError);
  });

  it('escalate：案件 escalated；决策人待办完成、其余审批人待办保持 open', async () => {
    const { service, todos } = newApproval();
    const started = await startedCase(service, [alice, bob]);
    const acted = await service.act(t1, started.case.id, alice, { decision: 'escalate', reason: '需上级复核' });
    expect(acted.case.state).toBe('escalated');
    expect((await todos.listOwn(t1, alice))[0]!.status).toBe('done');
    expect((await todos.listOwn(t1, bob)).find((todo) => todo.refId === started.case.id)?.status).toBe('open');
  });

  it('案件不存在 / 跨租户 → ApprovalNotFoundError', async () => {
    const { service } = newApproval();
    const started = await startedCase(service, [alice]);
    await expect(service.act(t1, 'case-ghost', alice, { decision: 'approve', reason: 'r' }))
      .rejects.toBeInstanceOf(ApprovalNotFoundError);
    await expect(service.act(t2, started.case.id, alice, { decision: 'approve', reason: 'r' }))
      .rejects.toBeInstanceOf(ApprovalNotFoundError);
  });
});

describe('查询（get / list）', () => {
  it('get：案件 + 决策记录 + 迁移事件一次读回（事件账本可查口径）', async () => {
    const { service } = newApproval();
    const started = await startedCase(service, [alice]);
    await service.act(t1, started.case.id, alice, { decision: 'approve', reason: 'ok' });
    const detail = await service.get(t1, started.case.id);
    expect(detail.case.state).toBe('approved');
    expect(detail.records.map((r) => r.decision)).toEqual(['approve']);
    expect(detail.events.map((e) => e.eventType)).toEqual([
      'smes.general-approval.v1.submitted',
      'smes.general-approval.v1.review-started',
      'smes.general-approval.v1.approved',
    ]);
    await expect(service.get(t1, 'case-ghost')).rejects.toBeInstanceOf(ApprovalNotFoundError);
  });

  it('list：状态过滤（in_review 只剩待审案件）；非法过滤参数 → ApprovalInputError', async () => {
    const { service } = newApproval();
    await startedCase(service, [alice]);
    const second = await startedCase(service, [alice]);
    await service.act(t1, second.case.id, alice, { decision: 'approve', reason: 'ok' });
    expect((await service.list(t1, 'in_review')).length).toBe(1);
    expect((await service.list(t1, undefined)).length).toBe(2);
    expect((await service.list(t1, 'approved')).map((c) => c.id)).toEqual([second.case.id]);
    await expect(service.list(t1, 'In Review')).rejects.toBeInstanceOf(ApprovalInputError);
  });
});

describe('模块装配（ADR-0004 注册表形态）', () => {
  it('ApprovalModule.register：控制器 + 服务可装配，权限码元数据齐备', () => {
    const module = ApprovalModule.register();
    expect(module.controllers).toContain(ApprovalCasesController);
    const provider = module.providers?.find(
      (p) => typeof p === 'object' && p !== null && 'provide' in p && (p as { provide: unknown }).provide === ApprovalService,
    );
    expect(provider).toBeDefined();

    const metadata = Reflect.getMetadata(
      PERMISSION_METADATA_KEY,
      ApprovalCasesController.prototype.create,
    );
    expect(metadata).toBe('approval:write');
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, ApprovalCasesController.prototype.list)).toBe('approval:read');
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, ApprovalCasesController.prototype.get)).toBe('approval:read');
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, ApprovalCasesController.prototype.decide)).toBe('approval:write');
  });

  it('模块元数据：controllers 注册完整（Nest 装配面）', () => {
    const module = ApprovalModule.register();
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ApprovalModule)).toBeUndefined();
    expect(module.controllers?.length).toBe(1);
  });
});
