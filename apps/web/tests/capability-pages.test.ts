/**
 * T1 能力子集装配与数据层接缝测试（0920 #98/99/#101/#102）：
 * 1. 四新页（overview/system-menus/system-approval-config/notifications）挂进
 *    PAGE_BY_CODE 且菜单路由存在（与 module-pages 漂移断言互补——本组另钉
 *    权限码形状）；
 * 2. menuConfigApi/notificationsApi/approvalConfigApi → 后端控制器实态端点的
 *    确切 HTTP 形状（路径 + 方法 + envelope 键；fetch-stub 钉死）。
 * 真实落库/待办桥由容器 e2e（scripts/e2e-capability.mjs）与 server
 * capability-modules.e2e 覆盖，不在本文件。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOKEN_SESSION_STORAGE_KEY, createBrowserTokenSessionStore, permissionCode } from '@smes/product-ui';

const storageBacking = new Map<string, string>();
const localStorageStub: Storage = {
  getItem: (key) => storageBacking.get(key) ?? null,
  setItem: (key, value) => void storageBacking.set(key, value),
  removeItem: (key) => void storageBacking.delete(key),
  clear: () => void storageBacking.clear(),
  key: () => null,
  get length() {
    return storageBacking.size;
  },
};
vi.stubGlobal('window', {
  localStorage: localStorageStub,
  location: { pathname: '/', assign: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
});

const { PAGE_BY_CODE } = await import('../src/pages/assembly.js');
const { menuRoutes } = await import('../src/menu.js');
const menuConfigApi = await import('../src/data/menuConfigApi.js');
const notificationsApi = await import('../src/data/notificationsApi.js');
const approvalConfigApi = await import('../src/data/approvalConfigApi.js');

let calls: Array<{ url: string; init: RequestInit | undefined }> = [];
let responder: (() => Promise<unknown>) | null = null;

function respond(body: unknown, status = 200): void {
  responder = async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

beforeEach(() => {
  calls = [];
  responder = null;
  storageBacking.clear();
  createBrowserTokenSessionStore(localStorageStub, TOKEN_SESSION_STORAGE_KEY).write({
    userId: 'user-ops' as never,
    tenantId: 'tenant-ops' as never,
    displayName: 'ops',
    permissions: [],
    token: 'token-ops-abc',
    expiresAt: '2026-10-26T12:00:00.000Z',
  });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (responder === null) throw new TypeError('fetch not stubbed');
    return responder();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('T1 装配：四新页挂接与权限码形状', () => {
  it('#1/#98+99/#101/#102 页面码全部有真实页面 + 菜单路由 + 控制器同码权限', () => {
    const expected = new Map<string, string>([
      ['overview', 'workbench:read'], // 工作台组入口码（页面四源码见 overviewApi 头注取舍）
      ['system-menus', 'menu:read'],
      ['system-approval-config', 'approval-config:read'],
      ['notifications', 'notification:read'], // hideInMenu——铃铛入口，路由保留
    ]);
    for (const [code, permission] of expected) {
      expect(typeof PAGE_BY_CODE[code], `装配表缺 '${code}'`).toBe('function');
      const route = menuRoutes.find((candidate) => candidate.code === code);
      expect(route, `菜单缺 '${code}' 路由`).toBeDefined();
      expect(route?.permission).toBe(permissionCode(permission));
    }
  });
});

describe('menuConfigApi：菜单配置端点形状（menu-config 控制器实态）', () => {
  it('GET /menu-config/configs → configs envelope；行形状归一（坏形状抛错）', async () => {
    respond({ configs: [{ id: 'mc-1', code: 'default', name: 'Web 菜单', nodes: [{ code: 'workbench', title: '工作台' }], active: true, createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z' }] });
    const configs = await menuConfigApi.fetchMenuConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0]?.nodes[0]?.title).toBe('工作台');
    expect(calls[0]?.url).toBe('/menu-config/configs');

    respond({ configs: [{ id: 'mc-1', code: 'default' }] }); // 坏行（缺 name/active）
    await expect(menuConfigApi.fetchMenuConfigs()).rejects.toThrow(/缺/);
  });

  it('POST/PUT 走 REST JSON 体（非命令信封）；permission-codes envelope', async () => {
    respond({ id: 'mc-2', code: 'mobile', name: '移动', nodes: [], active: true, createdAt: 't', updatedAt: 't' });
    await menuConfigApi.createMenuConfig({ code: 'mobile', name: '移动', nodes: [] });
    expect(calls[0]?.url).toBe('/menu-config/configs');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ code: 'mobile', name: '移动', nodes: [] });

    respond({ id: 'mc-2', code: 'mobile', name: '移动菜单', nodes: [], active: false, createdAt: 't', updatedAt: 't2' });
    await menuConfigApi.updateMenuConfig('mc-2', { active: false });
    expect(calls[1]?.url).toBe('/menu-config/configs/mc-2');
    expect(calls[1]?.init?.method).toBe('PUT');

    respond({ codes: ['menu:read', 'menu:write'] });
    expect(await menuConfigApi.fetchMenuPermissionCodes()).toEqual(['menu:read', 'menu:write']);
    expect(calls[2]?.url).toBe('/menu-config/permission-codes');
  });
});

describe('notificationsApi：通知中心端点形状（notifications 控制器实态）', () => {
  it('GET /notifications + unread-count；POST :id/read 与 read-all（幂等面）', async () => {
    respond({ notifications: [{ id: 'ntf-1', title: '审批待办', body: null, source: 'approval', refType: 'approval-case', refId: 'case-1', readAt: null, createdAt: '2026-10-26T00:00:00.000Z' }] });
    const rows = await notificationsApi.fetchNotifications();
    expect(rows[0]?.source).toBe('approval');
    expect(calls[0]?.url).toBe('/notifications');

    respond({ count: 2 });
    expect(await notificationsApi.fetchUnreadCount()).toBe(2);
    expect(calls[1]?.url).toBe('/notifications/unread-count');

    respond({ id: 'ntf-1', title: '审批待办', body: null, source: 'approval', refType: null, refId: null, readAt: '2026-10-26T00:01:00.000Z', createdAt: 't' });
    await notificationsApi.markNotificationRead('ntf-1');
    expect(calls[2]?.url).toBe('/notifications/ntf-1/read');
    expect(calls[2]?.init?.method).toBe('POST');

    respond({ updated: 1 });
    expect(await notificationsApi.markAllNotificationsRead()).toBe(1);
    expect(calls[3]?.url).toBe('/notifications/read-all');
    expect(calls[3]?.init?.method).toBe('POST');
  });
});

describe('approvalConfigApi：审批配置端点形状（approval-config 控制器实态）', () => {
  const FLOW = {
    schemaVersion: 1,
    flowId: 'two-step',
    initial: 'draft',
    states: [{ id: 'draft' }, { id: 'approved', final: true }],
    transitions: [{ from: 'draft', event: 'SUBMIT', to: 'approved' }],
  };
  const ROW = {
    id: 'ac-1',
    flowId: 'two-step',
    name: '两步流',
    config: FLOW,
    active: true,
    history: [{ config: FLOW, savedAt: '2026-10-25T00:00:00.000Z' }],
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
  };

  it('GET flows → flows envelope + history 行形状归一', async () => {
    respond({ flows: [ROW] });
    const flows = await approvalConfigApi.fetchApprovalFlows();
    expect(flows[0]?.history).toHaveLength(1);
    expect(flows[0]?.history[0]?.config.flowId).toBe('two-step');
    expect(calls[0]?.url).toBe('/approval-config/flows');
  });

  it('POST validate / PUT 更新 / POST activate：方法与体形状', async () => {
    respond({ valid: true, flowId: 'two-step' });
    expect(await approvalConfigApi.validateFlowConfig(FLOW)).toEqual({ valid: true, flowId: 'two-step' });
    expect(calls[0]?.url).toBe('/approval-config/validate');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(FLOW);

    respond(ROW);
    await approvalConfigApi.updateApprovalFlow('ac-1', { active: false });
    expect(calls[1]?.url).toBe('/approval-config/flows/ac-1');
    expect(calls[1]?.init?.method).toBe('PUT');

    await approvalConfigApi.activateApprovalFlow('ac-1');
    expect(calls[2]?.url).toBe('/approval-config/flows/ac-1/activate');
    expect(calls[2]?.init?.method).toBe('POST');

    await approvalConfigApi.createApprovalFlow({ name: '两步流', config: FLOW });
    expect(calls[3]?.url).toBe('/approval-config/flows');
    expect(calls[3]?.init?.method).toBe('POST');
  });
});
