/**
 * T1 能力子集三模块组合态 e2e（0920 #98/99 菜单管理 / #101 通知中心 /
 * #102 审批配置）：零 DB 真实起服（Nest 组合根 → express HTTP → fetch 读回），
 * 覆盖注册表接线面——
 *   ① #98/99：menu-config CRUD + 权限码聚合 + 门禁/冲突（403/409）；
 *   ② #101：notifications 发布/收件箱/未读计数/已读 + **待办桥 #27**（approval
 *      发起派待办 → 收件箱出现同源通知——组合根共享实例裁决的机器断言）；
 *   ③ #102：approval-config 校验/创建即启用（单激活收口）/版本历史/启用历史
 *      版本 + **运行时解析器**（active 配置驱动新案 flowConfigId/state）。
 * docker 活库形态（迁移/重启存活/RLS）由 scripts/e2e-capability.mjs 覆盖。
 */
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { TenantContext } from '@smes/application';
import { buildAppModule, parseModulesEnabled } from '../src/app-registry.js';
import { ApprovalErrorFilter } from '../src/approval-error.filter.js';
import { AuthErrorFilter } from '../src/auth-error.filter.js';
import { CapabilityErrorFilter } from '../src/capability-error.filter.js';
import { DomainErrorFilter } from '../src/domain-error.filter.js';
import { OrgErrorFilter } from '../src/org-error.filter.js';
import { WorkOrderErrorFilter } from '../src/workorder-error.filter.js';

/** dev 身份（grant admin 角色 → 全权限码 bypass）；VIEWER 无策略 = 403 证据身份。 */
const OPERATOR = 'u-op-capability';
const VIEWER = 'u-viewer-capability';
const AUTH_HEADERS = { 'content-type': 'application/json', 'x-smes-user': OPERATOR };
const VIEWER_HEADERS = { 'content-type': 'application/json', 'x-smes-user': VIEWER };

/** 合法自定义两步流（engine-flow 权威校验可过；发起后落 in_review）。 */
const TWO_STEP_FLOW = {
  schemaVersion: 1,
  flowId: 'two-step',
  initial: 'draft',
  states: [{ id: 'draft' }, { id: 'in_review' }, { id: 'approved', final: true }],
  transitions: [
    { from: 'draft', event: 'SUBMIT', to: 'in_review' },
    { from: 'in_review', event: 'APPROVE', to: 'approved', decision: 'approve' },
  ],
};

describe('T1 能力子集三模块组合态（零 DB 全装配）', () => {
  let baseUrl = '';
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  const savedEnv = new Map<string, string | undefined>();

  function setEnv(name: string, value: string | undefined): void {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  beforeAll(async () => {
    setEnv('MODULES_ENABLED', 'core,workbench,approval,menu-config,notifications,approval-config');
    setEnv('DATABASE_URL', undefined); // 零 DB：组合根裁决共享内存实例（通知桥/审批解析器同源）
    setEnv('SMES_DEV_AUTH', 'on'); // dev 身份回落（测试钩子）
    setEnv('SMES_DEV_POLICY_ENDPOINT', 'on'); // 策略注入钩子（grant admin）

    const enabled = parseModulesEnabled(process.env['MODULES_ENABLED']);
    app = await NestFactory.create(buildAppModule(enabled, { devPolicyEndpoint: true }), {
      logger: ['error', 'warn'],
    });
    app.useGlobalFilters(
      new OrgErrorFilter(),
      new AuthErrorFilter(),
      new DomainErrorFilter(),
      new ApprovalErrorFilter(),
      new WorkOrderErrorFilter(),
      new CapabilityErrorFilter(),
    );
    const tenantContext = app.get(TenantContext);
    app.use((request: unknown, _response: unknown, next: () => void) => {
      tenantContext.run(tenantContext.resolve(request), () => next());
    });
    await app.listen(0);
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    const granted = await post('/dev/policies', {
      rules: [{ kind: 'grant-role', tenant: 'default', user: OPERATOR, role: 'admin' }],
    });
    expect(granted.status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  async function post(path: string, body?: unknown, headers = AUTH_HEADERS) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  }
  async function put(path: string, body: unknown, headers = AUTH_HEADERS) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  }
  async function get(path: string, headers = AUTH_HEADERS) {
    const response = await fetch(`${baseUrl}${path}`, { headers });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  }

  it('#98/99 菜单管理：CRUD 门禁/冲突 + 权限码读实态聚合', async () => {
    // 门禁：无策略身份 403
    const denied = await get('/menu-config/configs', VIEWER_HEADERS);
    expect(denied.status).toBe(403);

    // 创建 web 配置集（default）与移动配置集（mobile）——#98/#99 两面同端点
    const web = await post('/menu-config/configs', {
      code: 'default',
      name: 'Web 菜单',
      nodes: [
        { code: 'workbench', title: '工作台', routePath: '/', permission: 'workbench:read' },
        {
          code: 'system',
          title: '系统管理',
          children: [
            { code: 'system-user', title: '用户', routePath: '/system/users', permission: 'user:read' },
          ],
        },
      ],
    });
    expect(web.status).toBe(201);
    expect(web.body.code).toBe('default');
    expect(web.body.active).toBe(true);

    const mobile = await post('/menu-config/configs', {
      code: 'mobile',
      name: '移动菜单',
      nodes: [{ code: 'm.workbench', title: '工作台', routePath: '/m', permission: 'workbench:read' }],
    });
    expect(mobile.status).toBe(201);

    // 唯一键冲突 409（CapabilityErrorFilter 映射）
    const dup = await post('/menu-config/configs', { code: 'default', name: '重码', nodes: [] });
    expect(dup.status).toBe(409);

    // 列表含两面；读实态权限码聚合（去重排序）
    const list = await get('/menu-config/configs');
    expect(list.status).toBe(200);
    expect(list.body.configs.map((c: any) => c.code)).toEqual(['default', 'mobile']);
    const codes = await get('/menu-config/permission-codes');
    expect(codes.status).toBe(200);
    expect(codes.body.codes).toEqual(['user:read', 'workbench:read']);

    // 期望态更新：改 title（前端合并只叠 title/hideInMenu 等呈现字段）
    const renamed = await put(`/menu-config/configs/${web.body.id}`, {
      nodes: [
        { code: 'workbench', title: '我的工作台', routePath: '/', permission: 'workbench:read' },
      ],
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.nodes[0].title).toBe('我的工作台');
  });

  it('#101 通知中心：发布/收件箱/未读/已读 + 待办桥（审批派待办 → 站内通知）', async () => {
    // 显式发布（运维补发面）
    const published = await post('/notifications', {
      recipient: OPERATOR,
      title: '联调补发通知',
      source: 'ops',
    });
    expect(published.status).toBe(201);
    expect(published.body.readAt).toBeNull();

    const unreadBefore = await get('/notifications/unread-count');
    expect(unreadBefore.body.count).toBe(1);

    // 待办桥 #27：审批发起（approver=OPERATOR）→ 待办创建 → 收件箱同源通知。
    // 此刻尚未建任何流配置 → 解析器回落静态默认配置（flowId=general-approval，
    // 回落路径的组合态断言；切换/驱动断言在 #102 用例）。
    const started = await post('/approval/cases', {
      subjectRef: { type: 'capability-e2e', id: 'cap-1' },
      approvers: [OPERATOR],
      reason: '组合态验证',
    });
    expect(started.status).toBe(201);
    expect(started.body.case.flowConfigId).toBe('general-approval'); // 无 active 配置 → 回落默认
    expect(started.body.case.state).toBe('in_review');

    const unreadAfter = await get('/notifications/unread-count');
    expect(unreadAfter.body.count).toBe(2); // 补发 1 + 审批待办桥 1

    const inbox = await get('/notifications');
    expect(inbox.body.notifications).toHaveLength(2);
    const bridgeRow = inbox.body.notifications.find((n: any) => n.source === 'approval');
    expect(bridgeRow).toBeDefined();
    expect(bridgeRow.title).toContain('capability-e2e'); // 待办标题透传（含 subjectRef）
    expect(bridgeRow.refType).toBe('approval-case');

    // 单条已读（幂等）+ 全部置读
    const marked = await post(`/notifications/${bridgeRow.id}/read`);
    expect(marked.status).toBe(201);
    expect(marked.body.readAt).not.toBeNull();
    const again = await post(`/notifications/${bridgeRow.id}/read`);
    expect(again.body.readAt).toBe(marked.body.readAt); // 幂等：同一时刻
    const sweep = await post('/notifications/read-all');
    expect(sweep.body.updated).toBe(1); // 剩余未读仅补发那条
    expect((await get('/notifications/unread-count')).body.count).toBe(0);
  });

  it('#102 审批配置：试写/创建即启用（单激活）/版本历史/启用历史版本/运行时驱动', async () => {
    // 试写预检（不落库）
    const valid = await post('/approval-config/validate', TWO_STEP_FLOW);
    expect(valid.status).toBe(201);
    expect(valid.body).toEqual({ valid: true, flowId: 'two-step' });

    // 创建即启用：second 创建后 first 被单激活收口置 false
    const first = await post('/approval-config/flows', {
      name: '两步流',
      config: TWO_STEP_FLOW,
    });
    expect(first.status).toBe(201);
    expect(first.body.active).toBe(true);
    const draft = await post('/approval-config/flows', {
      name: '草稿流',
      config: { ...TWO_STEP_FLOW, flowId: 'draft-flow' },
      active: false,
    });
    expect(draft.body.active).toBe(false);

    const flowsAfterDraft = await get('/approval-config/flows');
    expect(flowsAfterDraft.body.flows.find((f: any) => f.id === first.body.id).active).toBe(true); // 草稿不动他人

    const second = await post('/approval-config/flows', {
      name: '替换流',
      config: { ...TWO_STEP_FLOW, flowId: 'replacement-flow' },
    });
    expect(second.body.active).toBe(true);
    const flows = await get('/approval-config/flows');
    expect(flows.body.flows.find((f: any) => f.id === first.body.id).active).toBe(false); // 单激活收口
    expect(flows.body.flows.find((f: any) => f.id === draft.body.id).active).toBe(false);

    // 版本历史：整文档替换压入先前快照；启用历史版本 = PUT config=快照
    // （替换文档 flowId 必须与行 flowId 一致——'replacement-flow'，守卫语义）
    const renamedStates = {
      ...TWO_STEP_FLOW,
      flowId: 'replacement-flow',
      states: [{ id: 'draft' }, { id: 'reviewing' }, { id: 'approved', final: true }],
      transitions: [
        { from: 'draft', event: 'SUBMIT', to: 'reviewing' },
        { from: 'reviewing', event: 'APPROVE', to: 'approved', decision: 'approve' },
      ],
    };
    const replaced = await put(`/approval-config/flows/${second.body.id}`, { config: renamedStates });
    expect(replaced.status).toBe(200);
    expect(replaced.body.history).toHaveLength(1);
    expect(replaced.body.history[0].config.flowId).toBe('replacement-flow');

    const restored = await put(`/approval-config/flows/${second.body.id}`, {
      config: replaced.body.history[0].config,
    });
    expect(restored.body.history).toHaveLength(2); // 启用历史版本：当前配置再入历史
    expect(restored.body.config.states.map((s: any) => s.id)).toContain('in_review');

    // 运行时解析器：激活 two-step（first 行）→ 新案 flowConfigId 切换
    const activated = await post(`/approval-config/flows/${first.body.id}/activate`);
    expect(activated.status).toBe(201);
    const started = await post('/approval/cases', {
      subjectRef: { type: 'capability-e2e', id: 'cap-2' },
      approvers: [OPERATOR],
      reason: '切换后驱动',
    });
    expect(started.status).toBe(201);
    expect(started.body.case.flowConfigId).toBe('two-step'); // active 行驱动新案

    // 停用唯一 active 行 → 新案回落静态默认配置（general-approval）
    const deactivated = await put(`/approval-config/flows/${first.body.id}`, { active: false });
    expect(deactivated.body.active).toBe(false);
    const fallback = await post('/approval/cases', {
      subjectRef: { type: 'capability-e2e', id: 'cap-3' },
      approvers: [OPERATOR],
      reason: '回落默认',
    });
    expect(fallback.body.case.flowConfigId).toBe('general-approval');
  });
});
