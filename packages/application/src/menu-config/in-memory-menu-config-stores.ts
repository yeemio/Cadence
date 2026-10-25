/**
 * InMemoryMenuConfigStore —— 菜单配置端口先行实现（T 波 #98/99）。
 *
 * 重启即失；PG 实现在 business-store（`./menu-config` 子路径，导出登记归
 * 合流）。与 InMemoryItemStore 同一形态：无 DATABASE_URL / 未注入存储时组合根
 * 回落到这里，保证零 DB boot 语义完整。
 */
import { randomUUID } from 'node:crypto';
import { TenantId } from '@smes/business-core';
import { MenuConfigConflictError } from './menu-config-errors.js';
import type {
  CreateMenuConfigInput,
  MenuConfig,
  MenuConfigNode,
  MenuConfigStore,
  UpdateMenuConfigInput,
} from './menu-config-stores.js';

interface MenuConfigRow {
  readonly tenant: string;
  readonly id: string;
  readonly code: string;
  name: string;
  nodes: readonly MenuConfigNode[];
  active: boolean;
  readonly createdAt: string;
  updatedAt: string;
}

let memoryCounter = 0;

/** 内存形态 id：非 uuid 也可（端口合同只要求租户内唯一、创建后稳定）。 */
function nextMemoryId(): string {
  memoryCounter += 1;
  return `mc-${randomUUID()}-${memoryCounter.toString(36)}`;
}

export class InMemoryMenuConfigStore implements MenuConfigStore {
  private readonly rows = new Map<string, MenuConfigRow>(); // key: `${tenant}|${id}`

  async create(input: CreateMenuConfigInput): Promise<MenuConfig> {
    const conflict = [...this.rows.values()].find(
      (row) => row.tenant === input.tenant && row.code === input.code,
    );
    if (conflict !== undefined) {
      throw new MenuConfigConflictError(
        `配置集 code '${input.code}' 在租户 '${input.tenant}' 内已存在`,
      );
    }
    const now = new Date().toISOString();
    const row: MenuConfigRow = {
      tenant: input.tenant,
      id: nextMemoryId(),
      code: input.code,
      name: input.name,
      nodes: input.nodes,
      active: input.active ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(`${row.tenant}|${row.id}`, row);
    return toMenuConfig(row);
  }

  async list(tenant: TenantId): Promise<readonly MenuConfig[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenant === tenant)
      .sort((a, b) => a.code.localeCompare(b.code))
      .map(toMenuConfig);
  }

  async find(tenant: TenantId, id: string): Promise<MenuConfig | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    return row === undefined ? null : toMenuConfig(row);
  }

  async update(
    tenant: TenantId,
    id: string,
    input: UpdateMenuConfigInput,
  ): Promise<MenuConfig | null> {
    const row = this.rows.get(`${tenant}|${id}`);
    if (row === undefined) return null;
    if (input.name !== undefined) row.name = input.name;
    if (input.nodes !== undefined) row.nodes = input.nodes;
    if (input.active !== undefined) row.active = input.active;
    row.updatedAt = new Date().toISOString();
    return toMenuConfig(row);
  }
}

function toMenuConfig(row: MenuConfigRow): MenuConfig {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    code: row.code,
    name: row.name,
    nodes: row.nodes,
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
