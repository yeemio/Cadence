/**
 * 工作台/待办视图模型测试（M1 增量 4-I）：响应解析、载荷构造、权限码常量。
 */
import { describe, expect, it } from 'vitest';
import {
  buildCreateTodoPayload,
  parseTodosResponse,
  parseTodo,
  parseWorkbenchSummaryResponse,
  TODO_WRITE,
  WORKBENCH_READ,
  WorkbenchViewError,
} from '../src/index.js';

const todoRow = {
  id: 't-1',
  assignee: 'user-1',
  title: '盘点物品主数据',
  source: 'masterdata',
  refType: 'item',
  refId: 'i-1',
  status: 'open',
  createdAt: '2026-10-25T01:00:00.000Z',
  dueAt: '2026-11-01T09:00:00Z',
};

describe('工作台响应解析', () => {
  it('待办列表：合法行解析；非法 status 拒绝；缺 todos 抛错', () => {
    const todos = parseTodosResponse({ todos: [todoRow] });
    expect(todos[0]?.status).toBe('open');
    expect(todos[0]?.dueAt).toBe('2026-11-01T09:00:00Z');
    expect(() => parseTodosResponse({})).toThrow(WorkbenchViewError);
    expect(() =>
      parseTodo({ ...todoRow, status: 'paused' }),
    ).toThrow(WorkbenchViewError);
  });

  it('汇总：openTotal 数值 + bySource 行形状校验', () => {
    const summary = parseWorkbenchSummaryResponse({
      user: 'user-1',
      openTotal: 3,
      bySource: [
        { source: 'masterdata', open: 2 },
        { source: 'org', open: 1 },
      ],
    });
    expect(summary.openTotal).toBe(3);
    expect(summary.bySource[0]).toEqual({ source: 'masterdata', open: 2 });
    expect(() => parseWorkbenchSummaryResponse({ user: 'u', bySource: [] })).toThrow(
      WorkbenchViewError,
    );
    expect(() =>
      parseWorkbenchSummaryResponse({ user: 'u', openTotal: 1, bySource: [{ source: 'x' }] }),
    ).toThrow(WorkbenchViewError);
  });
});

describe('工作台请求载荷构造', () => {
  it('创建待办：必填 trim；可选字段空白剔除；空必填拒绝', () => {
    expect(
      buildCreateTodoPayload({ assignee: ' user-1 ', title: ' 盘点 ', source: 'masterdata' }),
    ).toEqual({ assignee: 'user-1', title: '盘点', source: 'masterdata' });
    expect(
      buildCreateTodoPayload({ assignee: 'user-1', title: '盘点', source: 'masterdata', refType: ' ', dueAt: '2026-11-01T09:00:00Z' }),
    ).toEqual({ assignee: 'user-1', title: '盘点', source: 'masterdata', dueAt: '2026-11-01T09:00:00Z' });
    expect(() => buildCreateTodoPayload({ assignee: '', title: 'x', source: 'org' })).toThrow(
      WorkbenchViewError,
    );
  });
});

describe('工作台权限码常量（与后端端点一一对应）', () => {
  it('两码：workbench:read / todo:write', () => {
    expect(WORKBENCH_READ).toBe('workbench:read');
    expect(TODO_WRITE).toBe('todo:write');
  });
});
