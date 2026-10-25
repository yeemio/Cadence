/**
 * Outbox 行形状与构造（outbox_records 表；核心形状见 business-core OutboxRecord）。
 *
 * 差异点（存储侧多出的列，均有依据）：
 *   - tenantId：ADR-0005 全表纪律（核心 OutboxRecord 形状未含，经 eventId 关联
 *     可推出租户；列落地是 M4 RLS 的前提，且免去投递器按租户轮询时的连表）。
 *   - 时间列用 Date（Prisma 口径），toOutboxRecord 换算回 ISO 字符串（领域口径）。
 */
import type { OutboxRecord, TenantId } from '@smes/business-core';

/** Outbox 表行形状。 */
export interface OutboxRow {
  readonly eventId: string;
  readonly tenantId: TenantId;
  readonly createdAt: Date;
  readonly attempts: number;
  readonly lastAttemptAt?: Date;
  readonly nextAttemptAt?: Date;
  /** null = 尚未送达 */
  readonly deliveredAt: Date | null;
}

/**
 * 事件落库时同事务构造的初始 Outbox 行（冻结）：attempts=0、未送达。
 * 与 toBusinessEventRow 的输出一起，在同一事务内写入（Outbox 模式）。
 */
export function initialOutboxRow(eventId: string, tenantId: TenantId, now: Date = new Date()): OutboxRow {
  if (typeof eventId !== 'string' || eventId.trim().length === 0 || eventId.length > 128) {
    throw new Error(`invalid eventId: expected a non-empty string of 1~128 chars`);
  }
  return Object.freeze({
    eventId,
    tenantId,
    createdAt: now,
    attempts: 0,
    deliveredAt: null,
  });
}

/** DB 行 → 领域形状 OutboxRecord（ISO 字符串）。 */
export function toOutboxRecord(row: OutboxRow): OutboxRecord {
  return Object.freeze({
    eventId: row.eventId,
    createdAt: row.createdAt.toISOString(),
    attempts: row.attempts,
    ...(row.lastAttemptAt === undefined || row.lastAttemptAt === null
      ? {}
      : { lastAttemptAt: row.lastAttemptAt.toISOString() }),
    ...(row.nextAttemptAt === undefined || row.nextAttemptAt === null
      ? {}
      : { nextAttemptAt: row.nextAttemptAt.toISOString() }),
    deliveredAt: row.deliveredAt === null ? null : row.deliveredAt.toISOString(),
  });
}
