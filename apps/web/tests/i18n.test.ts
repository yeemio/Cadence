/**
 * i18n 波 1 行为测试（ADR-0012 / proposal §3 §7）：init 装配与 namespace 隔离、
 * 回落链（en-US 缺 key → zh-CN → key 本身）、localStorage 持久化与缺省回落、
 * html lang 同步、菜单静态树 key 全覆盖（zh-CN 权威源 = 现有 title 原文、
 * en-US 同 key 骨架）与 menuNodeTitle 回落语义。
 * node 环境：window/localStorage/document 均 stub（体例先例=ShellLayout.test.ts）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuNode } from '@smes/product-ui';
import { menuTree, MENU_TITLE_KEYS } from '../src/menu.js';
import { MOBILE_MENU, MOBILE_SUBPAGES, MOBILE_TITLE_KEYS } from '../src/mobile.js';

// ---- window / localStorage / document stub（i18n init 与切换的运行时依赖） ----
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
const documentStub = { documentElement: { lang: 'zh-CN' } };

beforeEach(() => {
  storageBacking.clear();
  vi.stubGlobal('window', { localStorage: localStorageStub });
  vi.stubGlobal('document', documentStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// stub 之后动态 import（保持与 ShellLayout.test.ts 相同的加载纪律）
const { changeLocale, getLocale, initI18n, LOCALE_STORAGE_KEY } = await import(
  '../src/i18n/index.js'
);
const { menuNodeTitle } = await import('../src/shell/menuTitle.js');

/** 收集菜单树全量节点（含分组与 hideInMenu 项）。 */
function collectNodes(nodes: readonly MenuNode[]): MenuNode[] {
  const out: MenuNode[] = [];
  const walk = (list: readonly MenuNode[]): void => {
    for (const node of list) {
      out.push(node);
      if (node.children !== undefined) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** 资源包叶路径全集（点路径扁平化——骨架同 key 断言用）。 */
function leafPaths(bundle: unknown, prefix = ''): string[] {
  if (typeof bundle !== 'object' || bundle === null) return [prefix];
  return Object.entries(bundle).flatMap(([key, value]) => leafPaths(value, prefix === '' ? key : `${prefix}.${key}`));
}

describe('initI18n：namespace 装配与双入口隔离', () => {
  it('登录入口装配（login+common）：menu 不进实例（登录 bundle 不挂主壳 namespace）', async () => {
    const instance = await initI18n(['login', 'common']);
    expect(instance.hasResourceBundle('zh-CN', 'login')).toBe(true);
    expect(instance.hasResourceBundle('zh-CN', 'common')).toBe(true);
    expect(instance.hasResourceBundle('en-US', 'login')).toBe(true);
    expect(instance.hasResourceBundle('zh-CN', 'menu')).toBe(false);
    expect(instance.hasResourceBundle('en-US', 'menu')).toBe(false);
  });

  it('主壳入口装配（common+menu）：menu 双语 bundle 就位', async () => {
    const instance = await initI18n(['common', 'menu']);
    expect(instance.hasResourceBundle('zh-CN', 'menu')).toBe(true);
    expect(instance.hasResourceBundle('en-US', 'menu')).toBe(true);
    expect(instance.hasResourceBundle('zh-CN', 'login')).toBe(false);
  });

  it('缺 common namespace 拒绝装配（defaultNS 合同）', async () => {
    await expect(initI18n(['menu'])).rejects.toThrow(/common/);
  });
});

describe('回落链：en-US 缺 key → zh-CN → key 本身（proposal §3）', () => {
  it('zh-CN 权威源：zh 下文案即原文（语义零变化）', async () => {
    const instance = await initI18n(['login', 'common']);
    expect(instance.t('login:action.signIn')).toBe('登录');
    expect(instance.t('login:form.username')).toBe('用户名');
    expect(instance.t('common:brand.subtitle')).toBe('离散制造运营平台');
  });

  it('en 骨架文案就位；en 缺 key 回落 zh-CN 原文', async () => {
    const instance = await initI18n(['login', 'common']);
    await instance.changeLanguage('en-US');
    expect(instance.language).toBe('en-US');
    expect(instance.t('login:action.signIn')).toBe('Sign in');
    // 探针：仅 zh 侧存在的 key（en-US 骨架缺）→ 回落 zh-CN
    instance.addResourceBundle('zh-CN', 'common', { probe: '探针-zh原文' }, true, true);
    expect(instance.t('common:probe')).toBe('探针-zh原文');
  });

  it('双语全缺 → 返回 key 本身（链末端不空串）', async () => {
    const instance = await initI18n(['login', 'common']);
    expect(instance.t('common:no-such-key-xyz')).toContain('no-such-key-xyz');
  });

  it('en 错误前缀句：插值形态与 zh 等价（status 段 + 后端 message 原样拼接）', async () => {
    const instance = await initI18n(['common']);
    expect(instance.t('common:error.requestFailed', { status: '（404）', message: '单据不存在' })).toBe(
      '请求失败（404）：单据不存在',
    );
    expect(instance.t('common:error.requestFailed', { status: '', message: '单据不存在' })).toBe(
      '请求失败：单据不存在',
    );
    await instance.changeLanguage('en-US');
    expect(instance.t('common:error.requestFailed', { status: '（404）', message: '单据不存在' })).toBe(
      'Request failed（404）: 单据不存在',
    );
  });
});

describe('持久化与 html lang 同步（proposal §7）', () => {
  it('localStorage smes.locale 驱动 init 语言；changeLocale 写回存储（刷新/跨入口保持）', async () => {
    storageBacking.set(LOCALE_STORAGE_KEY, 'en-US');
    const instance = await initI18n(['common']);
    expect(instance.language).toBe('en-US');
    expect(getLocale()).toBe('en-US');

    await changeLocale('zh-CN');
    expect(storageBacking.get(LOCALE_STORAGE_KEY)).toBe('zh-CN');
    expect(getLocale()).toBe('zh-CN');

    // 模拟整页重载：新 init 读持久化值 → 语言保持
    const reloaded = await initI18n(['common']);
    expect(reloaded.language).toBe('zh-CN');
  });

  it('非法/缺失存储值回落 zh-CN 缺省', async () => {
    storageBacking.set(LOCALE_STORAGE_KEY, 'fr-FR');
    expect((await initI18n(['common'])).language).toBe('zh-CN');
    storageBacking.delete(LOCALE_STORAGE_KEY);
    expect((await initI18n(['common'])).language).toBe('zh-CN');
  });

  it('html lang 跟随：init 与切换后同步 documentElement.lang', async () => {
    storageBacking.set(LOCALE_STORAGE_KEY, 'en-US');
    const instance = await initI18n(['common']);
    expect(instance.language).toBe('en-US');
    expect(documentStub.documentElement.lang).toBe('en-US');
    await changeLocale('zh-CN');
    expect(documentStub.documentElement.lang).toBe('zh-CN');
  });
});

describe('菜单静态树 key 迁移（title 原文不动，menu.test 断言零触碰）', () => {
  it('桌面树全覆盖：每节点复合键有 key；zh-CN t(key) === 静态 title 原文（权威源）', async () => {
    const instance = await initI18n(['common', 'menu']);
    const nodes = collectNodes(menuTree);
    expect(nodes.length).toBeGreaterThan(40);
    for (const node of nodes) {
      const key = MENU_TITLE_KEYS[`${node.code}::${node.title}`];
      expect(key, `菜单码 ${node.code}（${node.title}）应有 titleKey`).toBeDefined();
      expect(instance.t(key as string)).toBe(node.title);
    }
    // 撞键回归锚：costing 分组（成本与工时）与同名叶子（成本核算）复合键互异、各自命中
    expect(MENU_TITLE_KEYS['costing::成本与工时']).toBe('menu:costing.title');
    expect(MENU_TITLE_KEYS['costing::成本核算']).toBe('menu:costing.costing');
    await instance.changeLanguage('en-US');
    expect(instance.t('menu:costing.title')).toBe('Cost & Hours');
    expect(instance.t('menu:costing.costing')).toBe('Costing');
  });

  it('移动注册表全覆盖：MOBILE_MENU + MOBILE_SUBPAGES 每节点复合键命中原文', async () => {
    const instance = await initI18n(['common', 'menu']);
    for (const node of [...MOBILE_MENU, ...MOBILE_SUBPAGES]) {
      const key = MOBILE_TITLE_KEYS[`${node.code}::${node.title}`];
      expect(key, `移动码 ${node.code}（${node.title}）应有 titleKey`).toBeDefined();
      expect(instance.t(key as string)).toBe(node.title);
    }
  });

  it('en-US menu 骨架与 zh-CN 同 key 集（骨架完整性，R4 范围内的骨架不缺键）', async () => {
    const instance = await initI18n(['common', 'menu']);
    const zhBundle = instance.getResourceBundle('zh-CN', 'menu');
    const enBundle = instance.getResourceBundle('en-US', 'menu');
    expect(leafPaths(enBundle).sort()).toEqual(leafPaths(zhBundle).sort());
    // en 值抽查（骨架译文而非回落）
    await instance.changeLanguage('en-US');
    expect(instance.t('menu:manufacturing.workorder')).toBe('Work Orders');
    expect(instance.t('menu:m.report')).toBe('Report');
  });

  it('menuNodeTitle 回落语义：静态 title 走 t()；配置集覆盖/未知码回落 title 原文', async () => {
    const instance = await initI18n(['common', 'menu']);
    const staticNode = { code: 'workorder', title: '工作令' } as MenuNode;
    // zh：t(key) 即原文
    expect(menuNodeTitle(staticNode, MENU_TITLE_KEYS, instance.t)).toBe('工作令');
    await instance.changeLanguage('en-US');
    expect(menuNodeTitle(staticNode, MENU_TITLE_KEYS, instance.t)).toBe('Work Orders');
    // menu_configs 覆盖 title（管理员语言业务数据）→ 复合键失配，原样显示不翻译
    const configured = { code: 'workorder', title: '车间令单' } as MenuNode;
    expect(menuNodeTitle(configured, MENU_TITLE_KEYS, instance.t)).toBe('车间令单');
    // 未知码（波 2 页面 namespace 未挂前）→ title 原文
    const unknown = { code: 'future-page', title: '未来页面' } as MenuNode;
    expect(menuNodeTitle(unknown, MENU_TITLE_KEYS, instance.t)).toBe('未来页面');
  });
});
