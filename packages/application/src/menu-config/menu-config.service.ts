/**
 * MenuConfigService —— 菜单配置用例（T 波 #98/99）。
 *
 * 零框架业务类（不 import @nestjs/*）：输入解析、端口委托、404 翻译与
 * "读实态定权限码"聚合（从实存配置树提取全部声明的权限码——管理页据此
 * 核对/登记权限码表，不再维护静态清单）。列表全量返回（M1 体例：不做
 * 分页/搜索）。
 */
import type { TenantId } from '@smes/business-core';
import { MenuConfigNotFoundError } from './menu-config-errors.js';
import {
  parseCreateMenuConfigInput,
  parseMenuConfigIdParam,
  parseUpdateMenuConfigInput,
} from './menu-config-input.js';
import type { MenuConfig, MenuConfigNode, MenuConfigStore } from './menu-config-stores.js';

export class MenuConfigService {
  constructor(private readonly store: MenuConfigStore) {}

  async createConfig(tenant: TenantId, input: unknown): Promise<MenuConfig> {
    return this.store.create({ tenant, ...parseCreateMenuConfigInput(input) });
  }

  async listConfigs(tenant: TenantId): Promise<readonly MenuConfig[]> {
    return this.store.list(tenant);
  }

  async getConfig(tenant: TenantId, idParam: string): Promise<MenuConfig> {
    const id = parseMenuConfigIdParam(idParam);
    const found = await this.store.find(tenant, id);
    if (found === null) {
      throw new MenuConfigNotFoundError(`租户 '${tenant}' 内不存在菜单配置集 '${id}'`);
    }
    return found;
  }

  /** 期望态更新：未提供的键不变；nodes 提供即整树替换（重走树校验）。 */
  async updateConfig(tenant: TenantId, idParam: string, input: unknown): Promise<MenuConfig> {
    const id = parseMenuConfigIdParam(idParam);
    const updated = await this.store.update(tenant, id, parseUpdateMenuConfigInput(input));
    if (updated === null) {
      throw new MenuConfigNotFoundError(`租户 '${tenant}' 内不存在菜单配置集 '${id}'`);
    }
    return updated;
  }

  /**
   * 读实态定权限码：聚合全部 active 配置树中声明的权限码，去重排序。
   * 口径：只看 active 配置集（停用配置集不参与菜单渲染，其权限码不再进表）；
   * 无码节点跳过（无码 = 全员可见，不产生权限码）。
   */
  async listPermissionCodes(tenant: TenantId): Promise<readonly string[]> {
    const configs = await this.store.list(tenant);
    const codes = new Set<string>();
    for (const config of configs) {
      if (!config.active) continue;
      collectPermissionCodes(config.nodes, codes);
    }
    return [...codes].sort();
  }
}

function collectPermissionCodes(nodes: readonly MenuConfigNode[], out: Set<string>): void {
  for (const node of nodes) {
    if (node.permission !== undefined) out.add(node.permission);
    if (node.children !== undefined) collectPermissionCodes(node.children, out);
  }
}
