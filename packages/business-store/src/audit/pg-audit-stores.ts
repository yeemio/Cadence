/**
 * AuditLogStore 的 PG 实现 + 组合根装配工厂（S1 backfill：0920 #103，经本包
 * `./audit` 子路径导出——与 `./org` 同模式：主入口保持零 @prisma/client 依赖）。
 *
 * 表形态（prisma/schema.prisma AuditLogRecord）：append-only 只插入；查询
 * 按租户 + 时间窗（含端点）+ 用户（可空）过滤，新→旧，limit 截取——
 * (tenant_id, occurred_at DESC) 前导索引即查询热路径。启动零 DB 依赖：
 * connectAuditStore 只构造 PrismaClient（惰性连接），无 DATABASE_URL 时
 * 组合根不调用本工厂（回落 application 内存实现）。
 */
import { PrismaClient } from '@prisma/client';
import { TenantId } from '@smes/business-core';
import type {
  AppendAuditInput,
  AuditLogEntry,
  AuditLogStore,
  AuditQueryFilter,
} from '@smes/application';
import { uuidv7 } from '../ids/uuidv7.js';
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';

/** 与内存实现同策略（application audit-stores.ts 文件头口径）。 */
export function pgAuditSummaryOf(method: string, path: string): string {
  const combined = `${method} ${path}`;
  return combined.length > 256 ? `${combined.slice(0, 253)}...` : combined;
}

function toEntry(row: {
  id: string;
  tenantId: string;
  userId: string | null;
  method: string;
  path: string;
  summary: string;
  occurredAt: Date;
}): AuditLogEntry {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    userId: row.userId,
    method: row.method,
    path: row.path,
    summary: row.summary,
    occurredAt: row.occurredAt.toISOString(),
  };
}

export class PgAuditLogStore implements AuditLogStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(input: AppendAuditInput): Promise<AuditLogEntry> {
    const row = await this.prisma.auditLogRecord.create({
      data: {
        id: uuidv7(),
        tenantId: input.tenant,
        userId: input.userId,
        method: input.method,
        path: input.path,
        summary: pgAuditSummaryOf(input.method, input.path),
        occurredAt: new Date(input.occurredAt ?? new Date().toISOString()),
      },
    });
    return toEntry(row);
  }

  async query(filter: AuditQueryFilter): Promise<readonly AuditLogEntry[]> {
    // from/to 由解析层保证 ISO 合法；无限值（undefined）即开窗
    const from = filter.from === undefined ? undefined : new Date(filter.from);
    const to = filter.to === undefined ? undefined : new Date(filter.to);
    const occurredAt = {
      ...(from !== undefined && !Number.isNaN(from.getTime()) ? { gte: from } : {}),
      ...(to !== undefined && !Number.isNaN(to.getTime()) ? { lte: to } : {}),
    };
    const rows = await this.prisma.auditLogRecord.findMany({
      where: {
        tenantId: filter.tenant,
        ...(filter.userId === undefined ? {} : { userId: filter.userId }),
        ...(Object.keys(occurredAt).length === 0 ? {} : { occurredAt }),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: Math.max(0, Math.floor(filter.limit ?? 100)),
    });
    return rows.map(toEntry);
  }
}

export interface AuditStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/** 组合根装配句柄：操作日志端口实现 + 优雅断连。 */
export interface AuditStoreHandle {
  readonly logStore: AuditLogStore;
  disconnect(): Promise<void>;
}

/** 构造操作日志 PG 存储装配（惰性连接：见文件头）。 */
export function connectAuditStore(options: AuditStoreOptions = {}): AuditStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  const client = withRlsTenantSession(prisma, { session: rlsSessionEnabled() });
  return {
    logStore: new PgAuditLogStore(client),
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}
