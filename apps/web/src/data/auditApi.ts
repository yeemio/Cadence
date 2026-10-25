/**
 * 操作日志薄数据层（S3-a：0920 #103 查询页；audit.controller.ts 实态）：
 * GET /audit/logs?from=&to=&userId=&limit= → { logs: [...] }。
 *
 * 口径（audit-input.ts 实态）：from/to 为 ISO 8601 时刻（含端点）；userId 精确
 * 匹配；limit 1~1000（缺省 100，新→旧）。空参数不进查询串（queryString 跳空值）。
 * 页面输入 datetime-local，本层不做时刻换算——调用方送 ISO 串（页面 util 负责）。
 */
import { request } from './apiClient';
import { fetchRows, queryString } from './commandClient';

/** 审计日志过滤参数（全部可选；limit 为 1~1000 整数）。 */
export interface AuditLogQuery {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly userId?: string | undefined;
  readonly limit?: number | undefined;
}

/** 查询操作日志（audit:read 门禁；envelope=logs）。 */
export async function queryAuditLogs(
  params: AuditLogQuery = {},
): Promise<readonly Record<string, unknown>[]> {
  const limit =
    params.limit !== undefined && Number.isInteger(params.limit) && params.limit > 0
      ? String(params.limit)
      : undefined;
  return fetchRows(
    `/audit/logs${queryString([
      ['from', params.from],
      ['to', params.to],
      ['userId', params.userId],
      ['limit', limit],
    ])}`,
    'logs',
  );
}
