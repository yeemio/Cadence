/**
 * InMemoryTodoStore —— 待办端口先行实现（M1 增量 4-I）。
 *
 * 重启即失；PG 实现在 business-store（`./workbench` 子路径）。与
 * InMemoryUserStore 同一形态：无 DATABASE_URL / 未注入存储时组合根回落
 * 到这里，保证零 DB boot 语义完整。全部读操作按 (tenant, assignee)
 * 双键收口（数据级过滤合同，见 workbench-stores.ts）。
 */
import { randomUUID } from 'node:crypto';
import { TenantId, UserId } from '@smes/business-core';
import type {
  CreateTodoInput,
  TodoItem,
  TodoStore,
} from './workbench-stores.js';

interface TodoRow {
  readonly tenant: string;
  readonly id: string;
  readonly assignee: string;
  title: string;
  source: string;
  refType: string | null;
  refId: string | null;
  status: 'open' | 'done';
  readonly createdAt: string;
  dueAt: string | null;
}

export class InMemoryTodoStore implements TodoStore {
  private readonly todos = new Map<string, TodoRow>(); // key: `${tenant}|${assignee}|${id}`

  async create(input: CreateTodoInput): Promise<TodoItem> {
    const row: TodoRow = {
      tenant: input.tenant,
      id: `todo-${randomUUID()}`,
      assignee: input.assignee,
      title: input.title,
      source: input.source,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      status: 'open',
      createdAt: new Date().toISOString(),
      dueAt: input.dueAt ?? null,
    };
    this.todos.set(`${row.tenant}|${row.assignee}|${row.id}`, row);
    return toItem(row);
  }

  async listOwn(tenant: TenantId, assignee: UserId): Promise<readonly TodoItem[]> {
    return [...this.todos.values()]
      .filter((row) => row.tenant === tenant && row.assignee === assignee)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) // 新的在前
      .map(toItem);
  }

  async findOwn(tenant: TenantId, assignee: UserId, id: string): Promise<TodoItem | null> {
    const row = this.todos.get(`${tenant}|${assignee}|${id}`);
    return row === undefined ? null : toItem(row);
  }

  async complete(tenant: TenantId, assignee: UserId, id: string): Promise<TodoItem | null> {
    const row = this.todos.get(`${tenant}|${assignee}|${id}`);
    if (row === undefined) return null;
    if (row.status === 'open') row.status = 'done'; // 幂等：已 done 原样返回
    return toItem(row);
  }
}

function toItem(row: TodoRow): TodoItem {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    assignee: UserId.create(row.assignee),
    title: row.title,
    source: row.source,
    refType: row.refType,
    refId: row.refId,
    status: row.status,
    createdAt: row.createdAt,
    dueAt: row.dueAt,
  };
}
