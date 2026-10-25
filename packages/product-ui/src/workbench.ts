/**
 * 工作台/待办视图模型（M1 增量 4-I）：类型 / 解析器 / 权限码。
 *
 * 与 org.ts 同一取舍：纯函数视图模型（测试钉死），fetch 与 URL 在
 * apps/web 装配层。权限码与后端 workbench 端点一一对应
 * （ADR-0010 通用词：workbench/todo）。
 */
import { permissionCode } from './permissions.js';
import type { PermissionCode } from './permissions.js';

/** 工作台权限码（与 apps/server workbench 端点一一对应）。 */
export const WORKBENCH_READ: PermissionCode = permissionCode('workbench:read');
export const TODO_WRITE: PermissionCode = permissionCode('todo:write');

/** 待办行视图（服务端 TodoItem 的 UI 投影：不透出租户）。 */
export interface TodoView {
  readonly id: string;
  readonly assignee: string;
  readonly title: string;
  readonly source: string;
  readonly refType: string | null;
  readonly refId: string | null;
  readonly status: 'open' | 'done';
  readonly createdAt: string;
  readonly dueAt: string | null;
}

/** 按 source 分组的 open 计数行（计数卡片）。 */
export interface TodoSourceCountView {
  readonly source: string;
  readonly open: number;
}

export interface WorkbenchSummaryView {
  readonly user: string;
  readonly openTotal: number;
  readonly bySource: readonly TodoSourceCountView[];
}

export class WorkbenchViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkbenchViewError';
  }
}

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new WorkbenchViewError(`${what} 形状非法：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new WorkbenchViewError(`字段 '${field}' 须为非空字符串`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new WorkbenchViewError(`字段 '${field}' 须为字符串或 null`);
  }
  return value.length === 0 ? null : value;
}

/** 解析单个待办视图。 */
export function parseTodo(input: unknown): TodoView {
  const record = requireObject(input, '待办对象');
  const status = record['status'];
  if (status !== 'open' && status !== 'done') {
    throw new WorkbenchViewError(`字段 'status' 须为 'open'|'done'：${JSON.stringify(status)}`);
  }
  return {
    id: requireString(record['id'], 'id'),
    assignee: requireString(record['assignee'], 'assignee'),
    title: requireString(record['title'], 'title'),
    source: requireString(record['source'], 'source'),
    refType: optionalString(record['refType'], 'refType'),
    refId: optionalString(record['refId'], 'refId'),
    status,
    createdAt: requireString(record['createdAt'], 'createdAt'),
    dueAt: optionalString(record['dueAt'], 'dueAt'),
  };
}

/** 解析 GET /workbench/todos 响应 { todos: [...] }。 */
export function parseTodosResponse(input: unknown): readonly TodoView[] {
  const record = requireObject(input, '待办列表响应');
  const todos = record['todos'];
  if (!Array.isArray(todos)) {
    throw new WorkbenchViewError("待办列表响应缺 'todos' 数组");
  }
  return todos.map(parseTodo);
}

/** 解析 GET /workbench/summary 响应。 */
export function parseWorkbenchSummaryResponse(input: unknown): WorkbenchSummaryView {
  const record = requireObject(input, '工作台汇总响应');
  const openTotal = record['openTotal'];
  if (typeof openTotal !== 'number') {
    throw new WorkbenchViewError("汇总响应缺 'openTotal' 数值");
  }
  const bySource = record['bySource'];
  if (!Array.isArray(bySource)) {
    throw new WorkbenchViewError("汇总响应缺 'bySource' 数组");
  }
  return {
    user: requireString(record['user'], 'user'),
    openTotal,
    bySource: bySource.map((row) => {
      const item = requireObject(row, 'bySource 行');
      const open = item['open'];
      if (typeof open !== 'number') {
        throw new WorkbenchViewError("bySource 行缺 'open' 数值");
      }
      return { source: requireString(item['source'], 'source'), open };
    }),
  };
}

/** 构造 POST /workbench/todos 载荷（title/assignee/source 必填；dueAt 可选）。 */
export function buildCreateTodoPayload(input: {
  readonly assignee: string;
  readonly title: string;
  readonly source: string;
  readonly refType?: string;
  readonly refId?: string;
  readonly dueAt?: string;
}): { assignee: string; title: string; source: string } & Record<string, unknown> {
  const payload: Record<string, unknown> = {
    assignee: requireString(input.assignee.trim(), 'assignee'),
    title: requireString(input.title.trim(), 'title'),
    source: requireString(input.source.trim(), 'source'),
  };
  const refType = input.refType?.trim();
  if (refType) payload.refType = refType;
  const refId = input.refId?.trim();
  if (refId) payload.refId = refId;
  const dueAt = input.dueAt?.trim();
  if (dueAt) payload.dueAt = dueAt;
  return payload as { assignee: string; title: string; source: string } & Record<string, unknown>;
}
