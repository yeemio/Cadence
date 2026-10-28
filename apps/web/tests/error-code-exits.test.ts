/**
 * 已知错误码 → 页面错误出口接通测试（i18n 波 2 接通，PM 2026-10-28 §10）：
 * 两条页面错误出口在 en-US 下对白名单内 ApiError code 出 common:error.codes
 * 同码英文文案；zh-CN 与白名单外 code 回落各自现状拼接（逐字符一致）。
 * 一并钉住：errorOutcomeOf 的 code 透传合同、ApiErrorHint 改用共享件后行为
 * 零变化。渲染走 react-dom/server 静态标记（无 DOM 依赖），i18n 装配体例
 * 同 i18n.test.ts（initI18n(['common']) + changeLanguage）。
 * node 环境：window/localStorage/document stub（apiClient 模块加载即读
 * window.localStorage，stub 先于动态 import——体例先例=module-pages.test.ts）。
 */
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---- window / localStorage / document stub（模块加载序要求：顶层先 stub） ----
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
vi.stubGlobal('window', { localStorage: localStorageStub });
vi.stubGlobal('document', { documentElement: { lang: 'zh-CN' } });

// stub 之后动态 import（apiClient 模块级 window.localStorage 读取发生在加载时）
const { initI18n } = await import('../src/i18n/index.js');
const { ApiError } = await import('../src/data/apiClient.js');
const { errorOutcomeOf } = await import('../src/data/commandClient.js');
const { QueryState, CommandOutcomeHint } = await import('../src/components/ModuleTable.js');
const { ApiErrorHint } = await import('../src/components/ApiErrorHint.js');

beforeEach(() => {
  storageBacking.clear();
});

/** 以指定语言渲染组件 → 静态标记（I18nextProvider 注入装配好的实例）。 */
async function renderAt(
  locale: 'zh-CN' | 'en-US',
  element: ReturnType<typeof h>,
): Promise<string> {
  const instance = await initI18n(['common']);
  await instance.changeLanguage(locale);
  return renderToStaticMarkup(h(I18nextProvider, { i18n: instance }, element));
}

describe('errorOutcomeOf：code 透传合同（PM §10 出口 2 的合成点助手）', () => {
  it('ApiError 携带 code → 透传；reason = message（现状提取逐字一致）', () => {
    const outcome = errorOutcomeOf(new ApiError(404, '工作令不存在', 'workorder.not_found'));
    expect(outcome).toEqual({
      committed: false,
      status: 'error',
      reason: '工作令不存在',
      code: 'workorder.not_found',
    });
  });

  it('ApiError 缺 code / 普通 Error / 非 Error → 不落 code 键，reason 提取与现状一致', () => {
    const noCode = errorOutcomeOf(new ApiError(500, '服务端错误'));
    expect('code' in noCode).toBe(false);
    expect(noCode.reason).toBe('服务端错误');

    const plain = errorOutcomeOf(new Error('普通错误'));
    expect('code' in plain).toBe(false);
    expect(plain.reason).toBe('普通错误');

    const nonError = errorOutcomeOf('裸字符串错误');
    expect('code' in nonError).toBe(false);
    expect(nonError.reason).toBe('裸字符串错误');
  });
});

describe('QueryState：查询错误出口（PM §10 出口 1）', () => {
  const notFound = new ApiError(404, '工作令不存在', 'workorder.not_found');
  const unknownCode = new ApiError(404, '工作令不存在', 'totally.unknown_code');
  const view = (error: unknown) =>
    h(QueryState, { isPending: false, error, isEmpty: false, children: h('table') });

  it('en-US + 白名单内 code → 同码英文文案（与 ApiErrorHint 同形，不拼 message）', async () => {
    const markup = await renderAt('en-US', view(notFound));
    expect(markup).toBe('<p role="alert" class="text-sm text-destructive">Work order not found</p>');
  });

  it('zh-CN → 现状逐字符一致（前缀句 + message 原文拼接，不取用码文案）', async () => {
    const markup = await renderAt('zh-CN', view(notFound));
    expect(markup).toBe('<p role="alert" class="text-sm text-destructive">请求失败：工作令不存在</p>');
  });

  it('en-US + 白名单外 code → 回落现状拼接', async () => {
    const markup = await renderAt('en-US', view(unknownCode));
    expect(markup).toBe(
      '<p role="alert" class="text-sm text-destructive">Request failed: 工作令不存在</p>',
    );
  });
});

describe('CommandOutcomeHint：命令结果失败出口（PM §10 出口 2 的呈现端）', () => {
  it('en-US + 白名单内 code → 同码英文文案（与 ApiErrorHint 同形）；第二域抽查', async () => {
    const workorder = await renderAt(
      'en-US',
      h(CommandOutcomeHint, { outcome: errorOutcomeOf(new ApiError(404, '工作令不存在', 'workorder.not_found')) }),
    );
    expect(workorder).toBe('<p role="alert" class="text-sm text-destructive">Work order not found</p>');

    const inventory = await renderAt(
      'en-US',
      h(CommandOutcomeHint, { outcome: errorOutcomeOf(new ApiError(409, '库存状态冲突', 'inventory.state_conflict')) }),
    );
    expect(inventory).toBe(
      '<p role="alert" class="text-sm text-destructive">Inventory state does not allow this operation</p>',
    );
  });

  it('zh-CN → 现状逐字符一致（lead＋「：」＋reason 原样）', async () => {
    const markup = await renderAt(
      'zh-CN',
      h(CommandOutcomeHint, { outcome: errorOutcomeOf(new ApiError(404, '工作令不存在', 'workorder.not_found')) }),
    );
    expect(markup).toBe('<p role="alert" class="text-sm text-destructive">操作失败：工作令不存在</p>');
  });

  it('en-US + 白名单外 code / 无 code → 回落现状 lead＋「：」＋reason（全角冒号原样）', async () => {
    const unknownCode = await renderAt(
      'en-US',
      h(CommandOutcomeHint, { outcome: errorOutcomeOf(new ApiError(404, '工作令不存在', 'totally.unknown_code')) }),
    );
    expect(unknownCode).toBe(
      '<p role="alert" class="text-sm text-destructive">Operation failed：工作令不存在</p>',
    );
  });

  it('非 error 形态不受影响：committed / rejected 现状原样', async () => {
    const committed = await renderAt(
      'en-US',
      h(CommandOutcomeHint, { outcome: { committed: true, status: 'committed', reason: null } }),
    );
    expect(committed).toBe('<p class="text-sm text-emerald-600 dark:text-emerald-400">Operation applied.</p>');

    const rejected = await renderAt(
      'zh-CN',
      h(CommandOutcomeHint, { outcome: { committed: false, status: 'rejected', reason: '数量不足' } }),
    );
    expect(rejected).toBe('<p role="alert" class="text-sm text-destructive">操作未生效：数量不足</p>');
  });
});

describe('ApiErrorHint：改用共享件后行为零变化', () => {
  it('en-US + 白名单内 code → 同码英文文案；zh-CN → 现状前缀句拼接', async () => {
    const notFound = new ApiError(404, '工作令不存在', 'workorder.not_found');
    const en = await renderAt('en-US', h(ApiErrorHint, { error: notFound }));
    expect(en).toBe('<p role="alert" class="text-sm text-destructive">Work order not found</p>');

    const zh = await renderAt('zh-CN', h(ApiErrorHint, { error: notFound }));
    expect(zh).toBe(
      '<p role="alert" class="text-sm text-destructive">请求失败（404）：工作令不存在</p>',
    );
  });
});
