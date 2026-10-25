/**
 * InMemoryNotificationStore —— 通知端口先行实现（T 波 #101）。
 *
 * 重启即失；PG 实现在 business-store（`./notifications` 子路径，导出登记归
 * 合流）。与 InMemoryTodoStore 同一形态：无 DATABASE_URL / 未注入存储时组合根
 * 回落到这里，保证零 DB boot 语义完整。全部读/标记操作按 (tenant, recipient)
 * 双键收口（数据级过滤合同，见 notifications-stores.ts）。
 */
import { randomUUID } from 'node:crypto';
import { TenantId, UserId } from '@smes/business-core';
import type {
  Notification,
  NotificationStore,
  PublishNotificationInput,
} from './notifications-stores.js';

interface NotificationRow {
  readonly tenant: string;
  readonly id: string;
  readonly recipient: string;
  title: string;
  body: string | null;
  source: string;
  refType: string | null;
  refId: string | null;
  readAt: string | null;
  readonly createdAt: string;
  /** 内存形态插入序号：同毫秒并列时的稳定 tiebreak（PG 形态 timestamptz(6) 微秒精度，冲突概率低）。 */
  readonly seq: number;
}

let memoryCounter = 0;

export class InMemoryNotificationStore implements NotificationStore {
  private readonly rows = new Map<string, NotificationRow>(); // key: `${tenant}|${recipient}|${id}`

  async create(input: PublishNotificationInput): Promise<Notification> {
    memoryCounter += 1;
    const row: NotificationRow = {
      tenant: input.tenant,
      id: `ntf-${randomUUID()}`,
      recipient: input.recipient,
      title: input.title,
      body: input.body ?? null,
      source: input.source,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      readAt: null,
      createdAt: new Date().toISOString(),
      seq: memoryCounter,
    };
    this.rows.set(`${row.tenant}|${row.recipient}|${row.id}`, row);
    return toNotification(row);
  }

  async listOwn(tenant: TenantId, recipient: UserId): Promise<readonly Notification[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenant === tenant && row.recipient === recipient)
      // 新的在前；同毫秒并列时按插入序稳定（seq tiebreak，见 NotificationRow.seq 注释）
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.seq - a.seq)
      .map(toNotification);
  }

  async countUnread(tenant: TenantId, recipient: UserId): Promise<number> {
    return [...this.rows.values()].filter(
      (row) => row.tenant === tenant && row.recipient === recipient && row.readAt === null,
    ).length;
  }

  async markRead(
    tenant: TenantId,
    recipient: UserId,
    id: string,
    readAt: string,
  ): Promise<Notification | null> {
    const row = this.rows.get(`${tenant}|${recipient}|${id}`);
    if (row === undefined) return null;
    if (row.readAt === null) row.readAt = readAt; // 幂等：已读原样返回
    return toNotification(row);
  }

  async markAllRead(tenant: TenantId, recipient: UserId, readAt: string): Promise<number> {
    let updated = 0;
    for (const row of this.rows.values()) {
      if (row.tenant === tenant && row.recipient === recipient && row.readAt === null) {
        row.readAt = readAt;
        updated += 1;
      }
    }
    return updated;
  }
}

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenant),
    recipient: UserId.create(row.recipient),
    title: row.title,
    body: row.body,
    source: row.source,
    refType: row.refType,
    refId: row.refId,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}
