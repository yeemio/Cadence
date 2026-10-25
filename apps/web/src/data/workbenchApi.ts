/**
 * 工作台薄数据层（M1 增量 4-I）：fetch 直连 server workbench 端点。
 * 读端点服务端按会话身份做数据级过滤——本层只经 apiClient 注入 Bearer，不传
 * assignee 查询参数（"仅本人"是服务端合同，不是前端约定）。
 */
import {
  buildCreateTodoPayload,
  parseTodo,
  parseTodosResponse,
  parseWorkbenchSummaryResponse,
  type TodoView,
  type WorkbenchSummaryView,
} from '@smes/product-ui';
import { request } from './apiClient';

export async function fetchWorkbenchSummary(): Promise<WorkbenchSummaryView> {
  return parseWorkbenchSummaryResponse(await request('/workbench/summary'));
}

export async function listMyTodos(): Promise<readonly TodoView[]> {
  return parseTodosResponse(await request('/workbench/todos'));
}

export async function createTodo(input: {
  readonly assignee: string;
  readonly title: string;
  readonly source: string;
  readonly refType?: string;
  readonly refId?: string;
  readonly dueAt?: string;
}): Promise<TodoView> {
  return parseTodo(
    await request('/workbench/todos', {
      method: 'POST',
      body: JSON.stringify(buildCreateTodoPayload(input)),
    }),
  );
}

export async function completeTodo(id: string): Promise<TodoView> {
  return parseTodo(
    await request(`/workbench/todos/${encodeURIComponent(id)}/done`, { method: 'POST' }),
  );
}
