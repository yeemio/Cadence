/**
 * 语言切换器（i18n 波 1，ADR-0012 / proposal §7）：ShellLayout 顶栏与登录页
 * 各挂一个（登录前无会话，localStorage `smes.locale` 是双入口唯一共享点；
 * 同 origin 双入口天然共享，登录→主壳整页跳转后语言延续）。
 * 切换即持久化 + i18next 换语言（useTranslation 订阅 languageChanged 自动重渲染，
 * html lang 经 i18n/index.ts 的监听同步）。
 */
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/select';
import { changeLocale, getLocale, LOCALES, type Locale } from './index';

export function LanguageSwitch() {
  const { t } = useTranslation();
  return (
    <Select
      aria-label={t('common:language.label')}
      className="h-8 w-auto text-xs"
      value={getLocale()}
      onChange={(event) => {
        const next = event.target.value;
        if ((LOCALES as readonly string[]).includes(next)) {
          void changeLocale(next as Locale);
        }
      }}
    >
      {LOCALES.map((locale) => (
        <option key={locale} value={locale}>
          {t(`common:language.${locale}`)}
        </option>
      ))}
    </Select>
  );
}
