/**
 * WorkbenchService —— 工作台待办用例（M1 增量 4-I，core 基础层章程）。
 *
 * 零框架业务类（不 import @nestjs/*）。本人视角聚合：读操作一律以
 * (tenant, 当前用户) 收口——"仅本人"是数据级过滤（端口合同），不是查询后
 * 再筛。summary 是本人 open 待办按 source 模块码的分组计数（工作台首页
 * 计数卡片的唯一事实源）。创建可指定任意 assignee（派发语义：todo:write
 * 持有者可为他人建待办）；完成仅限本人（completeOwn）。
 */
import type { TenantId, UserId } from '@smes/business-core';
import { WorkbenchNotFoundError } from './workbench-errors.js';
import { parseCreateTodoInput, parseTodoIdParam } from './workbench-input.js';
import type { TodoItem, TodoStore } from './workbench-stores.js';

/** 按 source 分组的 open 计数行。 */
export interface TodoSourceCount {
  readonly source: string;
  readonly open: number;
}

export interface WorkbenchSummary {
  readonly user: UserId;
  readonly openTotal: number;
  readonly bySource: readonly TodoSourceCount[];
}

export class WorkbenchService {
  constructor(private readonly todos: TodoStore) {}

  /** 为指定用户创建待办（assignee 在请求体内，由路由层 todo:write 门禁收口）。 */
  async createTodo(tenant: TenantId, input: unknown): Promise<TodoItem> {
    return this.todos.create({ tenant, ...parseCreateTodoInput(input) });
  }

  /** 当前用户自己的待办列表（数据级过滤：assignee = 当前用户）。 */
  async listOwnTodos(tenant: TenantId, user: UserId): Promise<readonly TodoItem[]> {
    return this.todos.listOwn(tenant, user);
  }

  /** 当前用户 open 待办按 source 分组计数。 */
  async summary(tenant: TenantId, user: UserId): Promise<WorkbenchSummary> {
    const own = await this.todos.listOwn(tenant, user);
    const counts = new Map<string, number>();
    for (const todo of own) {
      if (todo.status === 'open') {
        counts.set(todo.source, (counts.get(todo.source) ?? 0) + 1);
      }
    }
    const bySource = [...counts.entries()]
      .map(([source, open]) => ({ source, open }))
      .sort((a, b) => b.open - a.open || a.source.localeCompare(b.source));
    return {
      user,
      openTotal: bySource.reduce((sum, row) => sum + row.open, 0),
      bySource,
    };
  }

  /** 完成自己的待办（幂等；不存在/非本人 → WorkbenchNotFoundError 404）。 */
  async completeOwn(tenant: TenantId, user: UserId, idParam: string): Promise<TodoItem> {
    const id = parseTodoIdParam(idParam);
    const completed = await this.todos.complete(tenant, user, id);
    if (completed === null) {
      throw new WorkbenchNotFoundError(`待办 '${id}' 不存在或不属于当前用户`);
    }
    return completed;
  }
}
