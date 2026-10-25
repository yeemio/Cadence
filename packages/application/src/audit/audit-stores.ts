/**
 * AuditLogStore —— 操作日志存储端口（S1 backfill：0920 #103）。
 *
 * 设计取舍（写明）：
 *  - **独立表 + 写操作中间件拦截**：不复用各域 append-only 事件账本——域事件
 *    是业务事实（粒度=聚合迁移），操作日志是"谁在何时对哪个资源做了写操作"
 *    的横切运维事实（粒度=HTTP 写请求）。两者口径不同，合并会让事件账本承载
 *    HTTP 形状（路径/方法），污染业务事实语义。
 *  - 只插入、不更新不删除（append-only 的运维日志）；不套证据七公共列
 *    （非业务事实账本，无修正链需求——日志记错就留错，改日志=伪造审计）。
 *  - 全表带 tenant_id（ADR-0005），RLS 补登同批（见 business-store rls/tables.ts）。
 *  - **不打载荷全文**（脱敏 + 体积双取舍）：载荷可能含口令（/auth/login）、
 *    单据大 JSON（清单导入）；只记 method/path/操作者/时间与摘要。摘要截断
 *    策略：summary = `${method} ${path}`（去查询串），超 256 字符截断到 253 +
 *    省略号标记。
 */
import type { TenantId } from '@smes/business-core';

/** 一条操作日志（写请求成功收场后落账；userId null = 公开路由上的写操作）。 */
export interface AuditLogEntry {
  readonly id: string;
  readonly tenant: TenantId;
  readonly userId: string | null;
  /** HTTP 方法（POST/PUT/PATCH/DELETE——只记写操作）。 */
  readonly method: string;
  /** 请求路径（去查询串）。 */
  readonly path: string;
  /** 目标资源摘要（method + path，截断策略见文件头）。 */
  readonly summary: string;
  /** 发生时刻（ISO 8601）。 */
  readonly occurredAt: string;
}

export interface AppendAuditInput {
  readonly tenant: TenantId;
  readonly userId: string | null;
  readonly method: string;
  readonly path: string;
  readonly occurredAt?: string;
}

/** 查询过滤：租户收口（调用方传入）+ 时间窗（含端点，ISO 8601）+ 用户（可空）。 */
export interface AuditQueryFilter {
  readonly tenant: TenantId;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly userId?: string | undefined;
  /** 返回条数上界（新→旧截取）；缺省/非法由解析层定缺省值。 */
  readonly limit?: number | undefined;
}

/** 操作日志存储端口（内存实现先行；PG 适配在 business-store `./audit`）。 */
export interface AuditLogStore {
  append(input: AppendAuditInput): Promise<AuditLogEntry>;
  query(filter: AuditQueryFilter): Promise<readonly AuditLogEntry[]>;
}
