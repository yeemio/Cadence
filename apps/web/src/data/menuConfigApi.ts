/**
 * 菜单管理薄数据层（T1 #98/99：menu-config 模块控制器实态）：
 *   GET  /menu-config/configs            menu:read   → { configs: [...] }
 *   POST /menu-config/configs            menu:write  → 配置集行（REST 直返，非命令信封）
 *   GET  /menu-config/configs/:id        menu:read   → 配置集行
 *   PUT  /menu-config/configs/:id        menu:write  → 配置集行（期望态更新）
 *   GET  /menu-config/permission-codes   menu:read   → { codes: [...] }
 *
 * 配置集行经 parseMenuConfigSet 行级校验（坏形状抛错不静默——行来自配置面，
 * 节点树深校验在后端输入解析层，前端读取面只做形状归一）。
 */
import { request } from './apiClient';
import { ModuleApiError } from './commandClient';
import type { MenuConfigNodeView, MenuConfigSetView } from '@smes/product-ui';

function parseNodes(value: unknown, what: string): readonly MenuConfigNodeView[] {
  if (!Array.isArray(value)) {
    throw new ModuleApiError(undefined, `${what} 缺 nodes 数组`);
  }
  return value.map((node, index) => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      throw new ModuleApiError(undefined, `${what} nodes[${index}] 非对象`);
    }
    const record = node as Record<string, unknown>;
    if (typeof record['code'] !== 'string' || typeof record['title'] !== 'string') {
      throw new ModuleApiError(undefined, `${what} nodes[${index}] 缺 code/title`);
    }
    const parsed: {
      code: string;
      title: string;
      routePath?: string;
      icon?: string;
      permission?: string;
      hideInMenu?: boolean;
      children?: readonly MenuConfigNodeView[];
    } = { code: record['code'], title: record['title'] };
    if (typeof record['routePath'] === 'string') parsed.routePath = record['routePath'];
    if (typeof record['icon'] === 'string') parsed.icon = record['icon'];
    if (typeof record['permission'] === 'string') parsed.permission = record['permission'];
    if (record['hideInMenu'] === true) parsed.hideInMenu = true;
    if (Array.isArray(record['children'])) parsed.children = parseNodes(record['children'], `${what} nodes[${index}]`);
    return parsed;
  });
}

function parseMenuConfigSet(row: unknown): MenuConfigSetView {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new ModuleApiError(undefined, '菜单配置集行非对象');
  }
  const record = row as Record<string, unknown>;
  for (const field of ['id', 'code', 'name', 'createdAt', 'updatedAt'] as const) {
    if (typeof record[field] !== 'string') {
      throw new ModuleApiError(undefined, `菜单配置集行缺 '${field}' 字符串字段`);
    }
  }
  if (typeof record['active'] !== 'boolean') {
    throw new ModuleApiError(undefined, '菜单配置集行缺 active 布尔字段');
  }
  return {
    id: record['id'] as string,
    code: record['code'] as string,
    name: record['name'] as string,
    nodes: parseNodes(record['nodes'], '菜单配置集行'),
    active: record['active'] as boolean,
    createdAt: record['createdAt'] as string,
    updatedAt: record['updatedAt'] as string,
  };
}

/** 列出配置集（menu:read；按 code 升序——后端 store 实态）。 */
export async function fetchMenuConfigs(): Promise<readonly MenuConfigSetView[]> {
  const body: unknown = await request('/menu-config/configs');
  if (typeof body !== 'object' || body === null || !Array.isArray((body as Record<string, unknown>)['configs'])) {
    throw new ModuleApiError(undefined, "菜单配置列表响应缺 'configs' 数组");
  }
  return ((body as Record<string, unknown>)['configs'] as unknown[]).map(parseMenuConfigSet);
}

/** 读实态权限码聚合（menu:read；active 配置树声明码去重排序）。 */
export async function fetchMenuPermissionCodes(): Promise<readonly string[]> {
  const body: unknown = await request('/menu-config/permission-codes');
  const codes = (body as Record<string, unknown>)['codes'];
  if (!Array.isArray(codes) || codes.some((code) => typeof code !== 'string')) {
    throw new ModuleApiError(undefined, "权限码响应缺 'codes' 字符串数组");
  }
  return codes as readonly string[];
}

/** 创建配置集（menu:write；code 租户内唯一，冲突 409）。 */
export async function createMenuConfig(input: {
  code: string;
  name: string;
  nodes: readonly MenuConfigNodeView[];
  active?: boolean;
}): Promise<MenuConfigSetView> {
  const body: unknown = await request('/menu-config/configs', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return parseMenuConfigSet(body);
}

/** 期望态更新（menu:write；未提供的键不变，nodes 提供即整树替换）。 */
export async function updateMenuConfig(
  id: string,
  input: { name?: string; nodes?: readonly MenuConfigNodeView[]; active?: boolean },
): Promise<MenuConfigSetView> {
  const body: unknown = await request(`/menu-config/configs/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
  return parseMenuConfigSet(body);
}
