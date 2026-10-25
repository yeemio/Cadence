/**
 * AuditService —— 操作日志用例（S1 backfill：0920 #103）。
 *
 * 零框架业务类：record 由 AuditWriteInterceptor 调用（横切面），query 由
 * AuditController 调用（audit:read 门禁在路由层）。查询租户收口：tenant
 * 一律取 TenantContext 当前值（ADR-0005），不接受请求自报租户。
 */
import type { TenantId } from '@smes/business-core';
import type {
  AppendAuditInput,
  AuditLogEntry,
  AuditLogStore,
  AuditQueryFilter,
} from './audit-stores.js';

export class AuditService {
  constructor(private readonly logs: AuditLogStore) {}

  /** 落一条写操作日志（拦截器调用；失败由调用方隔离——本类不吞错）。 */
  async record(input: AppendAuditInput): Promise<AuditLogEntry> {
    return this.logs.append(input);
  }

  /** 按租户 + 时间窗（含端点）+ 用户（可选）查询，新→旧，limit 截取。 */
  async query(filter: AuditQueryFilter): Promise<readonly AuditLogEntry[]> {
    return this.logs.query(filter);
  }
}
