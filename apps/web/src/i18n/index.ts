/**
 * i18n 基础设施（i18n 波 1，ADR-0012 / proposal §2 §3 §7）：
 * react-i18next 运行时 + zh-CN 权威源 + en-US 骨架（缺 key 回落 zh-CN → key 本身）。
 *
 * 双入口 MPA 各自装配（proposal §7）：
 * - 登录入口 initI18n(['login', 'common'])——menu 等主壳 namespace 不进登录 bundle 图
 *   （locale 文件按 import.meta.glob 惰性分块，登录入口只加载所选 namespace 的语言块）；
 * - 主壳入口 initI18n(['common', 'menu'])——页面 namespace 波 2 再挂。
 *
 * 持久化：localStorage `smes.locale`（缺省 zh-CN；同 origin 双入口天然共享，
 * 登录前无会话，localStorage 是唯一跨入口共享点——proposal §7）。
 * html lang：init 与每次切换后同步 document.documentElement.lang
 * （index.html / login.html 初始值 zh-CN 保留为缺省；offline.html 静态 zh，波 3）。
 *
 * key 约定（ADR-0012）：`<namespace>:<域内路径>.<语义>`，全小写 kebab/dot，
 * 禁止中文原文作 key。资源文件 locales/<locale>/<namespace>.json。
 */
import { createInstance, type i18n as I18nInstance, type Resource } from 'i18next';
import { initReactI18next } from 'react-i18next';

/** 语言偏好持久化键（proposal §7 建议 `smes.locale`；先例=token 会话同 localStorage 方案）。 */
export const LOCALE_STORAGE_KEY = 'smes.locale';

/** 支持语言：zh-CN 权威源（完整）+ en-US 骨架（proposal §6）。 */
export const LOCALES = ['zh-CN', 'en-US'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'zh-CN';

/** 波 1 namespace 集（proposal §8）；波 2 增补五个高频模块 namespace（workorder/
 * dispatch/inspection/inventory/reporting——高频页 chrome 文案，列表+表单+详情）。 */
export type Namespace =
  | 'common'
  | 'login'
  | 'menu'
  | 'workorder'
  | 'dispatch'
  | 'inspection'
  | 'inventory'
  | 'reporting';

/**
 * locale 资源按 <locale>/<namespace>.json 惰性加载（import.meta.glob）——
 * 每文件独立 chunk，登录入口的加载图不含 menu 语言块（Done-when ② 的机制保证）。
 */
const localeFiles = import.meta.glob('./locales/*/*.json');

function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** 读持久化语言：非法/缺失/存储不可用回落 zh-CN。 */
export function readLocale(): Locale {
  try {
    if (typeof window === 'undefined') return DEFAULT_LOCALE;
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored !== null && isLocale(stored)) return stored;
  } catch {
    // localStorage 不可用（隐私模式等）→ 缺省语言
  }
  return DEFAULT_LOCALE;
}

function writeLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // 存储不可用即不持久化（本页内切换仍生效）
  }
}

async function loadResources(namespaces: readonly Namespace[]): Promise<Resource> {
  const resources: Resource = {};
  await Promise.all(
    LOCALES.flatMap((locale) =>
      namespaces.map(async (namespace) => {
        const loader = localeFiles[`./locales/${locale}/${namespace}.json`];
        if (loader === undefined) {
          throw new Error(`i18n: locale resource missing: locales/${locale}/${namespace}.json`);
        }
        const mod = (await loader()) as { default: Resource[string][string] };
        resources[locale] = { ...resources[locale], [namespace]: mod.default };
      }),
    ),
  );
  return resources;
}

function syncHtmlLang(language: string | undefined): void {
  if (typeof document === 'undefined' || language === undefined) return;
  document.documentElement.lang = language;
}

/** 当前活动实例（initI18n 装配；changeLocale/getLocale 经它操作）。 */
let active: I18nInstance | undefined;

/**
 * 双入口共用的 i18n 装配（ADR-0012）：namespace 按入口声明，资源只含所选
 * namespace；回落链 en-US 缺 key → zh-CN → key 本身（fallbackLng=zh-CN +
 * i18next 缺译返回 key）；dev 模式开 missingKeyHandler console 警告
 * （proposal §3 回落链 / dev 警告）。common 为 defaultNS，两入口必含。
 */
export async function initI18n(namespaces: readonly Namespace[]): Promise<I18nInstance> {
  if (!namespaces.includes('common')) {
    throw new Error('i18n: initI18n requires the common namespace (defaultNS)');
  }
  const instance = createInstance();
  await instance
    .use(initReactI18next)
    .init({
      lng: readLocale(),
      fallbackLng: DEFAULT_LOCALE,
      supportedLngs: [...LOCALES],
      ns: [...namespaces],
      defaultNS: 'common',
      resources: await loadResources(namespaces),
      // React 已做 XSS 转义，插值不再转义（react-i18next 官方口径）
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
      ...(import.meta.env.DEV
        ? {
            saveMissing: true,
            missingKeyHandler: (_lngs: readonly string[], ns: string, key: string) => {
              console.warn(`[i18n] missing key: ${ns}:${key}`);
            },
          }
        : {}),
    });
  instance.on('languageChanged', syncHtmlLang);
  syncHtmlLang(instance.language);
  active = instance;
  return instance;
}

/** 切换语言：先写 localStorage（跨入口/刷新保持），再切实例语言（触发 html lang 同步）。 */
export async function changeLocale(locale: Locale): Promise<void> {
  writeLocale(locale);
  if (active === undefined) return;
  await active.changeLanguage(locale);
}

/** 当前语言（实例已装配时取实例语言，否则读持久化值）。 */
export function getLocale(): Locale {
  const language = active?.language;
  return language !== undefined && isLocale(language) ? language : readLocale();
}
