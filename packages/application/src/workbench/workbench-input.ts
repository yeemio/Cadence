/**
 * 工作台输入解析（HTTP body → 业务输入；M1 增量 4-I）。
 *
 * 与 org-input 同一纪律：违规抛 WorkbenchInputError（组合根映射 400），
 * 绝不静默丢弃。source 形状复用 PERMISSION_SEGMENT_PATTERN（单段小写——
 * 模块码与权限码资源段同形状，ADR-0010 通用词）。dueAt 校验 ISO-8601
 * 可解析且往返无损（时区显式），存取一律 ISO 字符串。
 */
import { UserId } from '@smes/business-core';
import { PERMISSION_SEGMENT_PATTERN } from '../core/auth/permission-code.js';
import { WorkbenchInputError } from './workbench-errors.js';

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new WorkbenchInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireTitle(value: unknown): string {
  if (typeof value !== 'string') {
    throw new WorkbenchInputError(`待办标题必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    throw new WorkbenchInputError(`待办标题须为 1~200 个非空白字符：${JSON.stringify(value)}`);
  }
  return trimmed;
}

function requireSource(value: unknown): string {
  if (typeof value !== 'string' || !PERMISSION_SEGMENT_PATTERN.test(value)) {
    throw new WorkbenchInputError(
      `来源模块码 '${JSON.stringify(value)}' 非法：须为单段小写形状（小写字母/数字/连字符，如 masterdata）`,
    );
  }
  return value;
}

function requireAssignee(value: unknown): UserId {
  try {
    return UserId.create(typeof value === 'string' ? value : '');
  } catch {
    throw new WorkbenchInputError(`经办人 id 非法：${JSON.stringify(value)}`);
  }
}

/** 可选引用：undefined → 缺省不动；null → 显式置空；字符串 trim 后 1~128。 */
function optionalRef(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new WorkbenchInputError(`字段 '${field}' 须为字符串或 null：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 128) {
    throw new WorkbenchInputError(`字段 '${field}' 超长（>128）：${JSON.stringify(value)}`);
  }
  return trimmed;
}

function optionalDueAt(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new WorkbenchInputError(`dueAt 须为 ISO-8601 字符串或 null：${JSON.stringify(value)}`);
  }
  // 带时区设计（Z 或 ±hh:mm）的 ISO-8601 且真实可解析；存取一律原样字符串。
  const isoWithZone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
  if (!isoWithZone.test(value) || Number.isNaN(new Date(value).getTime())) {
    throw new WorkbenchInputError(
      `dueAt '${value}' 非法：须为带时区的 ISO-8601 字符串（如 2026-11-01T09:00:00Z）`,
    );
  }
  return value;
}

export interface CreateTodoPayload {
  readonly assignee: UserId;
  readonly title: string;
  readonly source: string;
  readonly refType?: string | null;
  readonly refId?: string | null;
  readonly dueAt?: string | null;
}

/** 解析 POST /workbench/todos 请求体（assignee 由创建方指定——派发语义）。 */
export function parseCreateTodoInput(input: unknown): CreateTodoPayload {
  const record = requireObject(input, '创建待办请求体');
  const payload: {
    assignee: UserId;
    title: string;
    source: string;
    refType?: string | null;
    refId?: string | null;
    dueAt?: string | null;
  } = {
    assignee: requireAssignee(record['assignee']),
    title: requireTitle(record['title']),
    source: requireSource(record['source']),
  };
  const refType = optionalRef(record['refType'], 'refType');
  if (refType !== undefined) payload.refType = refType;
  const refId = optionalRef(record['refId'], 'refId');
  if (refId !== undefined) payload.refId = refId;
  const dueAt = optionalDueAt(record['dueAt']);
  if (dueAt !== undefined) payload.dueAt = dueAt;
  return payload;
}

/** 路径参数待办 id 解析（非空、无空白即收——存储侧生成的不透明串）。 */
export function parseTodoIdParam(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || /\s/.test(trimmed)) {
    throw new WorkbenchInputError(`待办 id 非法：${JSON.stringify(value)}`);
  }
  return trimmed;
}
