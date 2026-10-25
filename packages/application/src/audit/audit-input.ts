/**
 * 操作日志查询入参解析（S1 backfill：0920 #103）。
 *
 * GET /audit/logs?from=&to=&userId=&limit= 的查询串解析（控制器把
 * URLSearchParams 传入）；违规抛 AuditInputError（组合根映射 400）。
 * from/to 为 ISO 8601 时刻（含端点）；userId 为精确匹配；limit 缺省 100、
 * 上界 1000（防全表拖库）。
 */
import { AuditInputError } from './audit-errors.js';
import type { AuditQueryFilter } from './audit-stores.js';

export const AUDIT_QUERY_DEFAULT_LIMIT = 100;
export const AUDIT_QUERY_MAX_LIMIT = 1000;

function optionalIso(value: string | null, field: string): string | undefined {
  if (value === null || value.trim() === '') return undefined;
  const trimmed = value.trim();
  const ms = new Date(trimmed).getTime();
  if (Number.isNaN(ms)) {
    throw new AuditInputError(`字段 '${field}' 须为 ISO 8601 时刻：${JSON.stringify(value)}`);
  }
  return trimmed;
}

function optionalUserId(value: string | null): string | undefined {
  if (value === null || value.trim() === '') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || /\s/.test(trimmed)) {
    throw new AuditInputError(`字段 'userId' 引用 id 非法：${JSON.stringify(value)}`);
  }
  return trimmed;
}

function optionalLimit(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > AUDIT_QUERY_MAX_LIMIT) {
    throw new AuditInputError(
      `字段 'limit' 须为 1~${AUDIT_QUERY_MAX_LIMIT} 的整数：${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

/** 解析 GET /audit/logs 查询串（未知参数忽略——查询面宽松，写面严格）。 */
export function parseAuditQueryInput(
  params: URLSearchParams | Record<string, string | undefined>,
): Omit<AuditQueryFilter, 'tenant'> {
  const read = (name: string): string | null => {
    if (params instanceof URLSearchParams) return params.get(name);
    const value = params[name];
    return value === undefined ? null : value;
  };
  const from = optionalIso(read('from'), 'from');
  const to = optionalIso(read('to'), 'to');
  if (from !== undefined && to !== undefined && new Date(from).getTime() > new Date(to).getTime()) {
    throw new AuditInputError(`时间窗颠倒：from '${from}' 晚于 to '${to}'`);
  }
  return {
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(optionalUserId(read('userId')) !== undefined ? { userId: optionalUserId(read('userId')) } : {}),
    limit: optionalLimit(read('limit')) ?? AUDIT_QUERY_DEFAULT_LIMIT,
  };
}
