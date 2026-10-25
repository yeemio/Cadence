/**
 * 审批配置（T 波 #102 + T1 接线增量，approval 域）测试：端口内存实现
 * （租户收口/flowId 冲突/软停用/**版本历史/单启用 activate**）、engine-flow
 * 权威校验包装、期望态更新与 flowId 不可变守卫、校验端点、控制器权限码
 * 元数据、模块装配、**ApprovalService 租户级配置解析器**（启用配置驱动新案）。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TenantId, UserId } from '@smes/business-core';
import { DEFAULT_APPROVAL_FLOW_CONFIG } from '@smes/engine-flow';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import { PERMISSION_METADATA_KEY } from '../../src/core/auth/require-permission.decorator.js';
import { InMemoryApprovalFlowConfigStore } from '../../src/approval-config/in-memory-approval-config-stores.js';
import { ApprovalConfigController } from '../../src/approval-config/approval-config.controllers.js';
import {
  ApprovalConfigConflictError,
  ApprovalConfigInputError,
  ApprovalConfigNotFoundError,
} from '../../src/approval-config/approval-config-errors.js';
import { ApprovalConfigModule } from '../../src/approval-config/approval-config.module.js';
import { ApprovalConfigService } from '../../src/approval-config/approval-config.service.js';
import { ApprovalService } from '../../src/approval/approval.service.js';
import {
  InMemoryApprovalCaseStore,
} from '../../src/approval/in-memory-approval-stores.js';
import { createInMemoryApprovalRecordStore, createInMemoryApprovalEventStore } from '@smes/engine-flow';
import { InMemoryTodoStore } from '../../src/workbench/in-memory-workbench-stores.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');

function newService(): { service: ApprovalConfigService; store: InMemoryApprovalFlowConfigStore } {
  const store = new InMemoryApprovalFlowConfigStore();
  return { service: new ApprovalConfigService(store), store };
}

/** 合法自定义配置（engine-flow 校验可过：draft → submitted 双态最小流）。 */
function validCustomFlow(flowId: string) {
  return {
    schemaVersion: 1 as const,
    flowId,
    initial: 'draft',
    states: [
      { id: 'draft' },
      { id: 'submitted', final: true },
    ],
    transitions: [{ from: 'draft', event: 'SUBMIT', to: 'submitted' }],
  };
}

describe('审批配置端口（内存实现先行）', () => {
  it('create/list/find：租户内收口、flowId 冲突 409、他租户同 flowId 不冲突、读出经固化复核', async () => {
    const store = new InMemoryApprovalFlowConfigStore();
    const created = await store.create({
      tenant: t1,
      flowId: DEFAULT_APPROVAL_FLOW_CONFIG.flowId,
      name: '默认审批流',
      config: DEFAULT_APPROVAL_FLOW_CONFIG,
    });
    expect(created.active).toBe(true);
    expect(created.config.flowId).toBe('general-approval');
    expect(Object.isFrozen(created.config)).toBe(true); // 固化快照（deepFreeze）

    await expect(
      store.create({
        tenant: t1,
        flowId: 'general-approval',
        name: '重码',
        config: DEFAULT_APPROVAL_FLOW_CONFIG,
      }),
    ).rejects.toThrow(ApprovalConfigConflictError);
    await store.create({ tenant: t2, flowId: 'general-approval', name: '他租户同码', config: DEFAULT_APPROVAL_FLOW_CONFIG }); // 他租户不冲突

    expect((await store.list(t1)).map((row) => row.flowId)).toEqual(['general-approval']);
    expect(await store.find(t1, created.id)).not.toBeNull();
    expect(await store.find(t2, created.id)).toBeNull(); // 跨租户不可见
    expect(await store.update(t1, 'ghost', { active: false })).toBeNull(); // 不存在 → null
  });

  it('update：字段级期望态 + updatedAt 推进 + config 整文档替换', async () => {
    const store = new InMemoryApprovalFlowConfigStore();
    const created = await store.create({
      tenant: t1,
      flowId: 'two-step',
      name: '两步流',
      config: validCustomFlow('two-step'),
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const updated = await store.update(t1, created.id, {
      active: false,
      // 整文档替换：终态从 submitted 改为 done（transitions 同步改指向，保持文档合法）
      config: {
        ...validCustomFlow('two-step'),
        states: [{ id: 'draft' }, { id: 'done', final: true }],
        transitions: [{ from: 'draft', event: 'SUBMIT', to: 'done' }],
      },
    });
    expect(updated?.active).toBe(false);
    expect(updated?.name).toBe('两步流'); // 未提供不变
    expect(updated?.config.states.map((s) => s.id)).toEqual(['draft', 'done']);
    expect(updated !== null && updated.updatedAt > created.updatedAt).toBe(true);
  });

  it('T1 版本历史：整文档替换压入先前快照（含当时 updatedAt）；非 config 更新不动历史', async () => {
    const store = new InMemoryApprovalFlowConfigStore();
    const created = await store.create({
      tenant: t1,
      flowId: 'hist-flow',
      name: '历史流',
      config: validCustomFlow('hist-flow'),
    });
    expect(created.history).toEqual([]); // 建行无历史

    await new Promise((resolve) => setTimeout(resolve, 2));
    const renamed = await store.update(t1, created.id, { name: '仅改名' });
    expect(renamed?.history).toEqual([]); // 非 config 更新不压历史

    await new Promise((resolve) => setTimeout(resolve, 2));
    const replaced = await store.update(t1, created.id, {
      config: {
        ...validCustomFlow('hist-flow'),
        states: [{ id: 'draft' }, { id: 'done', final: true }],
        transitions: [{ from: 'draft', event: 'SUBMIT', to: 'done' }],
      },
    });
    expect(replaced?.history).toHaveLength(1);
    // 快照时刻 = 替换前该行 updatedAt（此处 = 改名那次更新推进后的值）
    expect(replaced?.history[0]?.savedAt).toBe(renamed?.updatedAt);
    expect(replaced?.history[0]?.config.states.map((s) => s.id)).toEqual(['draft', 'submitted']);
    expect(replaced?.config.states.map((s) => s.id)).toEqual(['draft', 'done']);

    // 同一 config 重复提交（对象等价但引用不同）也压历史——引用级判等，语义保守
    const replacedConfig = replaced?.config;
    if (replacedConfig === undefined) throw new Error('替换后的 config 应存在');
    const again = await store.update(t1, created.id, { config: replacedConfig });
    expect(again?.history).toHaveLength(2);
  });

  it('T1 单启用 activate：目标置 active，租户内其余 active 行全置 false；跨租户不动', async () => {
    const store = new InMemoryApprovalFlowConfigStore();
    const first = await store.create({ tenant: t1, flowId: 'aaa', name: 'A', config: validCustomFlow('aaa') });
    const second = await store.create({ tenant: t1, flowId: 'bbb', name: 'B', config: validCustomFlow('bbb') });
    const otherTenant = await store.create({ tenant: t2, flowId: 'ccc', name: 'C', config: validCustomFlow('ccc') });

    const activated = await store.activate(t1, second.id);
    expect(activated?.active).toBe(true);
    const rows = await store.list(t1);
    expect(rows.find((row) => row.id === first.id)?.active).toBe(false);
    expect(rows.find((row) => row.id === second.id)?.active).toBe(true);
    expect((await store.find(t2, otherTenant.id))?.active).toBe(true); // 他租户不受影响
    expect(await store.activate(t1, 'ghost')).toBeNull(); // 不存在 → null
  });
});

describe('engine-flow 权威校验包装（ApprovalConfigInputError）', () => {
  it('创建：缺 config / 非法配置文档（坏 flowId、终态迁出、未知 from 状态）拒绝', async () => {
    const { service } = newService();
    await expect(service.createFlow(t1, { name: 'x' })).rejects.toThrow(ApprovalConfigInputError);
    await expect(
      service.createFlow(t1, { config: { ...validCustomFlow('Bad Upper') } }),
    ).rejects.toThrow(ApprovalConfigInputError);
    await expect(
      service.createFlow(t1, {
        config: {
          ...validCustomFlow('final-out'),
          transitions: [{ from: 'done', event: 'SUBMIT', to: 'draft' }],
        },
      }),
    ).rejects.toThrow(ApprovalConfigInputError);
    await expect(
      service.createFlow(t1, {
        config: {
          ...validCustomFlow('ghost-from'),
          transitions: [{ from: 'ghost', event: 'SUBMIT', to: 'done' }],
        },
      }),
    ).rejects.toThrow(ApprovalConfigInputError);
  });

  it('更新：flowId 不可更新；config 换 flowId 拒绝；重走校验；空更新幂等；未知 id → 404', async () => {
    const { service } = newService();
    const created = await service.createFlow(t1, { config: validCustomFlow('two-step') });
    expect(created.name).toBe('two-step'); // name 缺省 = flowId

    await expect(service.updateFlow(t1, created.id, { flowId: 'other' })).rejects.toThrow(
      ApprovalConfigInputError,
    );
    await expect(
      service.updateFlow(t1, created.id, { config: validCustomFlow('other-flow') }),
    ).rejects.toThrow(ApprovalConfigInputError);
    await expect(
      service.updateFlow(t1, created.id, { config: { ...validCustomFlow('two-step'), initial: 'ghost' } }),
    ).rejects.toThrow(ApprovalConfigInputError);
    const same = await service.updateFlow(t1, created.id, {});
    expect(same.flowId).toBe('two-step');
    await expect(service.updateFlow(t1, 'ghost', { name: 'x' })).rejects.toThrow(
      ApprovalConfigNotFoundError,
    );
    await expect(service.getFlow(t1, 'ghost')).rejects.toThrow(ApprovalConfigNotFoundError);
  });

  it('校验端点：合法文档返回 { valid, flowId }；非法抛 ApprovalConfigInputError；不落库', async () => {
    const { service, store } = newService();
    expect(await service.validateFlow(validCustomFlow('precheck'))).toEqual({
      valid: true,
      flowId: 'precheck',
    });
    await expect(service.validateFlow({ schemaVersion: 99, flowId: 'x' })).rejects.toThrow(
      ApprovalConfigInputError,
    );
    expect(await store.list(t1)).toEqual([]); // 校验不落库
  });
});

describe('控制器权限码元数据（@RequirePermission 声明面）', () => {
  type Handler = Record<string, unknown>;

  function routePermissions(controller: Function, handler: string): unknown {
    const proto = controller.prototype as Record<string, Handler>;
    return Reflect.getMetadata(PERMISSION_METADATA_KEY, proto[handler] as object);
  }

  it('approval-config 路由：list/get=approval-config:read；create/update/activate/validate=approval-config:write', () => {
    expect(routePermissions(ApprovalConfigController, 'list')).toBe('approval-config:read');
    expect(routePermissions(ApprovalConfigController, 'create')).toBe('approval-config:write');
    expect(routePermissions(ApprovalConfigController, 'get')).toBe('approval-config:read');
    expect(routePermissions(ApprovalConfigController, 'update')).toBe('approval-config:write');
    expect(routePermissions(ApprovalConfigController, 'activate')).toBe('approval-config:write');
    expect(routePermissions(ApprovalConfigController, 'validate')).toBe('approval-config:write');
  });

  it('ApprovalConfigModule.register 装配控制器，缺省回落内存存储', () => {
    const dynamic = ApprovalConfigModule.register();
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      ApprovalConfigModule.register(),
    ) as unknown[];
    expect(dynamic.module).toBe(ApprovalConfigModule);
    expect(controllers).toContain(ApprovalConfigController);
  });
});

describe('T1 接线：service 启用语义 + ApprovalService 租户级配置解析器', () => {
  it('createFlow 缺省即启用（其余 active 行置 false）；显式 active=false 建草稿不动他人', async () => {
    const store = new InMemoryApprovalFlowConfigStore();
    const service = new ApprovalConfigService(store);
    const first = await service.createFlow(t1, { config: validCustomFlow('aaa') });
    expect(first.active).toBe(true);
    const second = await service.createFlow(t1, { config: validCustomFlow('bbb') });
    expect(second.active).toBe(true);
    expect((await store.find(t1, first.id))?.active).toBe(false); // 创建即启用 = 单启用收口

    const draft = await service.createFlow(t1, { config: validCustomFlow('ccc'), active: false });
    expect(draft.active).toBe(false);
    expect((await store.find(t1, second.id))?.active).toBe(true); // 草稿不动他人

    const activated = await service.activateFlow(t1, first.id);
    expect(activated.active).toBe(true);
    expect((await store.find(t1, second.id))?.active).toBe(false);
    await expect(service.activateFlow(t1, 'ghost')).rejects.toThrow(ApprovalConfigNotFoundError);
  });

  it('解析器：active 行驱动新案（flowConfigId/状态随启用配置走）；无 active 行回落静态配置', async () => {
    const store = new InMemoryApprovalFlowConfigStore();
    const todos = new InMemoryTodoStore();
    const withResolver = new ApprovalService(
      new InMemoryApprovalCaseStore(),
      createInMemoryApprovalRecordStore(),
      createInMemoryApprovalEventStore(),
      todos,
      {
        config: DEFAULT_APPROVAL_FLOW_CONFIG,
        submitEvent: 'SUBMIT',
        reviewEvent: 'START_REVIEW',
        // 解析器 = 组合根注入形态的同一语义：租户 active 行优先
        flowConfigResolver: async (tenant) => {
          const flows = await store.list(tenant);
          return flows.find((row) => row.active)?.config ?? null;
        },
      },
    );

    const actor = UserId.create('user-1');
    const approver = UserId.create('user-2');
    const subjectRef = { type: 'demo', id: 's-1' } as const;

    // 无持久化行 → 回落默认配置（flowId=general-approval）
    const before = await withResolver.start(t1, actor, { subjectRef, approvers: [approver], reason: '发起' });
    expect(before.case.flowConfigId).toBe(DEFAULT_APPROVAL_FLOW_CONFIG.flowId);

    // 启用 draft→done 单迁移流（无 START_REVIEW 合法迁移 → 停在终态前一步不适用：
    // 该配置 SUBMIT 即终态 done，"发起后即终态"守卫会拒——换带 in_review 的两步流）
    const twoStep = {
      schemaVersion: 1 as const,
      flowId: 'two-step',
      initial: 'draft',
      states: [{ id: 'draft' }, { id: 'in_review' }, { id: 'approved', final: true }],
      transitions: [
        { from: 'draft', event: 'SUBMIT', to: 'in_review' },
        { from: 'in_review', event: 'APPROVE', to: 'approved', decision: 'approve' as const },
      ],
    };
    await store.create({ tenant: t1, flowId: 'two-step', name: '两步流', config: twoStep });

    const after = await withResolver.start(t1, actor, { subjectRef: { type: 'demo', id: 's-2' }, approvers: [approver], reason: '发起' });
    expect(after.case.flowConfigId).toBe('two-step'); // 新案按启用配置驱动
    expect(after.case.state).toBe('in_review');

    // 在途案件按同解析器决策（APPROVE 动词来自启用配置的迁移规则）
    const acted = await withResolver.act(t1, after.case.id, approver, { decision: 'approve', reason: '同意' });
    expect(acted.case.state).toBe('approved');

    // 默认配置驱动的旧案：解析器生效后 flowId 不匹配 → 状态冲突（不静默换配重放）
    await expect(
      withResolver.act(t1, before.case.id, approver, { decision: 'approve', reason: '同意' }),
    ).rejects.toThrow(/不符/);

    // 停用唯一 active 行 → 解析器回 null → 回落默认配置
    await store.update(t1, (await store.list(t1))[0]!.id, { active: false });
    const fallback = await withResolver.start(t1, actor, { subjectRef: { type: 'demo', id: 's-3' }, approvers: [approver], reason: '发起' });
    expect(fallback.case.flowConfigId).toBe(DEFAULT_APPROVAL_FLOW_CONFIG.flowId);
  });
});
