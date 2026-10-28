/**
 * 菜单节点显示名解析（i18n 波 1，ADR-0012）：静态树 title 中文原文保留不动
 * （zh-CN 权威源 + 回落值），key 映射由 menu.ts / mobile.ts 以
 * `<code>::<静态 title>` 复合键派生导出。
 *
 * 解析规则（proposal §5 b 类口径）：
 * - title 仍是静态树原文（复合键命中）→ 走 key→t()（en-US 缺 key 回落
 *   zh-CN，资源全缺回落 defaultValue=title 原文）；
 * - title 已被 menu_configs 配置集覆盖（管理员录入语言）→ 复合键失配，
 *   原样显示不翻译；
 * - 未知码（波 2 页面 namespace 未挂前）→ 同理回落 title 原文。
 */
import type { TFunction } from 'i18next';
import type { MenuNode } from '@smes/product-ui';

export function menuNodeTitle(
  node: MenuNode,
  titleKeys: Readonly<Record<string, string>>,
  t: TFunction,
): string {
  const key = titleKeys[`${node.code}::${node.title}`];
  return key !== undefined ? t(key, { defaultValue: node.title }) : node.title;
}
