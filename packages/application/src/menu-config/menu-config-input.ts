/**
 * 菜单配置输入解析（HTTP body → 业务输入；T 波 #98/99）。
 *
 * 与 masterdata-input 同一纪律：违规抛 MenuConfigInputError（组合根映射
 * 400），绝不静默丢弃。节点树校验在解析层完成（形状 + 树约束：code 全局
 * 唯一/深度上限/总量上限）——端口与存储只收已校验文档。
 */
import { isPermissionCode } from '../core/auth/permission-code.js';
import { MenuConfigInputError } from './menu-config-errors.js';
import type { MenuConfigNode } from './menu-config-stores.js';

/** 配置集/节点 code 形状（同 masterdata CODE_PATTERN：稳定人读键的通用形状）。 */
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 树防御上限（写入面防御：挡失控树炸存储/前端；正常菜单树远低于此）。 */
const MAX_NODE_COUNT = 512;
const MAX_DEPTH = 8;

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new MenuConfigInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new MenuConfigInputError(`名称必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    throw new MenuConfigInputError(`名称须为 1~128 个非空白字符：${JSON.stringify(value)}`);
  }
  return trimmed;
}

function requireCode(value: unknown, what: string): string {
  if (typeof value !== 'string' || !CODE_PATTERN.test(value)) {
    throw new MenuConfigInputError(
      `${what} '${JSON.stringify(value)}' 非法：须为字母/数字开头，仅含字母/数字/点/下划线/连字符（1~64 字符）`,
    );
  }
  return value;
}

function optionalActive(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new MenuConfigInputError(`active 须为布尔：${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * 解析并校验节点树（形状 + 树约束）。防御性取舍：
 *  - code 树内全局唯一（跨层重复 = 路由/菜单键冲突，fail-fast）；
 *  - 深度 ≤8、总节点 ≤512（挡失控树）；
 *  - children 空数组合法（原样保留，语义 = "声明过子菜单但当前为空"，
 *    与 product-ui 空壳隐藏语义衔接）。
 */
export function parseMenuConfigNodes(value: unknown, what: string): readonly MenuConfigNode[] {
  if (!Array.isArray(value)) {
    throw new MenuConfigInputError(`${what}必须是节点数组：${JSON.stringify(value)}`);
  }
  const seenCodes = new Set<string>();
  const parsed = value.map((node, index) => parseNode(node, `${what}[${index}]`, seenCodes, 1));
  if (parsed.length > MAX_NODE_COUNT) {
    throw new MenuConfigInputError(`${what}节点总数超上限（>${MAX_NODE_COUNT}）`);
  }
  countNodes(parsed); // 总量含子层，超限即抛
  return parsed;
}

function countNodes(nodes: readonly MenuConfigNode[]): number {
  let total = 0;
  for (const node of nodes) {
    total += 1;
    if (node.children !== undefined) total += countNodes(node.children);
  }
  if (total > MAX_NODE_COUNT) {
    throw new MenuConfigInputError(`节点树总节点数超上限（>${MAX_NODE_COUNT}）`);
  }
  return total;
}

function parseNode(
  input: unknown,
  what: string,
  seenCodes: Set<string>,
  depth: number,
): MenuConfigNode {
  const record = requireObject(input, `${what} 节点`);
  if (depth > MAX_DEPTH) {
    throw new MenuConfigInputError(`节点树深度超上限（>${MAX_DEPTH} 层）：'${what}'`);
  }
  const code = requireCode(record['code'], `${what} 节点 code`);
  if (seenCodes.has(code)) {
    throw new MenuConfigInputError(`节点 code '${code}' 在树内重复（code 树内全局唯一）`);
  }
  seenCodes.add(code);

  const node: {
    code: string;
    title: string;
    routePath?: string;
    icon?: string;
    permission?: string;
    hideInMenu?: boolean;
    children?: readonly MenuConfigNode[];
  } = { code, title: requireName(record['title']) };

  const routePath = record['routePath'];
  if (routePath !== undefined) {
    if (typeof routePath !== 'string' || !routePath.startsWith('/') || routePath.length > 256) {
      throw new MenuConfigInputError(
        `${what} 节点 routePath '${JSON.stringify(routePath)}' 非法：须为 '/' 开头且 ≤256 字符`,
      );
    }
    node.routePath = routePath;
  }
  const icon = record['icon'];
  if (icon !== undefined) {
    if (typeof icon !== 'string' || icon.trim().length === 0 || icon.length > 64) {
      throw new MenuConfigInputError(
        `${what} 节点 icon '${JSON.stringify(icon)}' 非法：须为 1~64 字符`,
      );
    }
    node.icon = icon;
  }
  const permission = record['permission'];
  if (permission !== undefined) {
    if (typeof permission !== 'string' || !isPermissionCode(permission)) {
      throw new MenuConfigInputError(
        `${what} 节点 permission '${JSON.stringify(permission)}' 非法：须为 <环节>:<动作> 两段小写形状权限码`,
      );
    }
    node.permission = permission;
  }
  const hideInMenu = record['hideInMenu'];
  if (hideInMenu !== undefined) {
    if (typeof hideInMenu !== 'boolean') {
      throw new MenuConfigInputError(`${what} 节点 hideInMenu 须为布尔：${JSON.stringify(hideInMenu)}`);
    }
    node.hideInMenu = hideInMenu;
  }
  if (record['children'] !== undefined) {
    node.children = (record['children'] as unknown[]).map((child, index) =>
      parseNode(child, `${what}[${index}].children`, seenCodes, depth + 1),
    );
  }
  return node;
}

export interface CreateMenuConfigPayload {
  readonly code: string;
  readonly name: string;
  readonly nodes: readonly MenuConfigNode[];
  readonly active?: boolean;
}

/** 解析 POST /menu-config/configs 请求体。 */
export function parseCreateMenuConfigInput(input: unknown): CreateMenuConfigPayload {
  const record = requireObject(input, '创建菜单配置集请求体');
  const payload: {
    code: string;
    name: string;
    nodes: readonly MenuConfigNode[];
    active?: boolean;
  } = {
    code: requireCode(record['code'], '配置集 code'),
    name: requireName(record['name']),
    nodes: parseMenuConfigNodes(record['nodes'] ?? [], 'nodes'),
  };
  const active = optionalActive(record['active']);
  if (active !== undefined) payload.active = active;
  return payload;
}

export interface UpdateMenuConfigPayload {
  readonly name?: string;
  readonly nodes?: readonly MenuConfigNode[];
  readonly active?: boolean;
}

/** 解析 PUT /menu-config/configs/:id 请求体（字段级期望态：未提供即不变；nodes 提供即整树替换）。 */
export function parseUpdateMenuConfigInput(input: unknown): UpdateMenuConfigPayload {
  const record = requireObject(input, '更新菜单配置集请求体');
  if (record['code'] !== undefined) {
    throw new MenuConfigInputError('配置集 code 不可更新（租户内唯一键，创建后稳定）');
  }
  const payload: { name?: string; nodes?: readonly MenuConfigNode[]; active?: boolean } = {};
  if (record['name'] !== undefined) payload.name = requireName(record['name']);
  if (record['nodes'] !== undefined) {
    payload.nodes = parseMenuConfigNodes(record['nodes'], 'nodes');
  }
  const active = optionalActive(record['active']);
  if (active !== undefined) payload.active = active;
  return payload;
}

/** 路径参数 id 解析（非空、无空白即收——id 是存储侧生成的不透明串）。 */
export function parseMenuConfigIdParam(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || /\s/.test(trimmed)) {
    throw new MenuConfigInputError(`配置集 id 非法：${JSON.stringify(value)}`);
  }
  return trimmed;
}
