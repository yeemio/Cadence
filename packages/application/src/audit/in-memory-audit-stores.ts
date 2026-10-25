/**
 * InMemoryAuditLogStore —— 操作日志端口先行实现（S1 backfill：0920 #103）。
 *
 * 重启即失；PG 实现在 business-store（`./audit` 子路径）。与 InMemoryItemStore
 * 同一形态：零 DB boot 回落点。
 */
import { randomUUID } from 'node:crypto';
import type {
  AppendAuditInput,
  AuditLogEntry,
  AuditLogStore,
  AuditQueryFilter,
} from './audit-stores.js';

let auditCounter = 0;

function nextAuditId(): string {
  auditCounter += 1;
  return `audit-${randomUUID()}-${auditCounter.toString(36)}`;
}

/** 摘要截断（与 PG 实现同策略：253 + '...'，见 audit-stores.ts 文件头）。 */
export function auditSummaryOf(method: string, path: string): string {
  const combined = `${method} ${path}`;
  return combined.length > 256 ? `${combined.slice(0, 253)}...` : combined;
}

export class InMemoryAuditLogStore implements AuditLogStore {
  private readonly entries: AuditLogEntry[] = [];

  async append(input: AppendAuditInput): Promise<AuditLogEntry> {
    const entry: AuditLogEntry = {
      id: nextAuditId(),
      tenant: input.tenant,
      userId: input.userId,
      method: input.method,
      path: input.path,
      summary: auditSummaryOf(input.method, input.path),
      occurredAt: input.occurredAt ?? new Date().toISOString(),
    };
    this.entries.push(entry);
    return entry;
  }

  async query(filter: AuditQueryFilter): Promise<readonly AuditLogEntry[]> {
    const fromMs = filter.from === undefined ? undefined : new Date(filter.from).getTime();
    const toMs = filter.to === undefined ? undefined : new Date(filter.to).getTime();
    const matched = this.entries.filter((entry) => {
      if (entry.tenant !== filter.tenant) return false;
      if (filter.userId !== undefined && entry.userId !== filter.userId) return false;
      const ms = new Date(entry.occurredAt).getTime();
      if (fromMs !== undefined && Number.isFinite(fromMs) && ms < fromMs) return false;
      if (toMs !== undefined && Number.isFinite(toMs) && ms > toMs) return false;
      return true;
    });
    // 新 → 旧（同刻按插入序倒排），截取 limit
    const limit = filter.limit ?? 100;
    return matched
      .slice()
      .reverse()
      .slice(0, Math.max(0, Math.floor(limit)));
  }
}
