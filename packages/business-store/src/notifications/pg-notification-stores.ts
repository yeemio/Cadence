/**
 * NotificationStore 的 PG 实现 + 组合根装配工厂（T 波 #101，经本包
 * `./notifications` 子路径导出——与 `./workbench` 同模式；子路径登记归合流）。
 *
 * 数据级过滤合同（application 端口）：一切读/标记操作按 (tenant_id,
 * recipient_id) 双键收口——非本人的行对当事人不可见（markRead 不命中 →
 * null）。时间列往返：PG 侧 timestamptz，端口侧 ISO-8601 字符串。
 */
import { PrismaClient } from '@prisma/client';
// RLS session 接线（机制见 src/rls-session.ts 文件头；M4 正式线已上提包顶层，领域中立）
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';
import { TenantId, UserId } from '@smes/business-core';
import type {
  Notification,
  NotificationStore,
  PublishNotificationInput,
} from '@smes/application';
import { uuidv7 } from '../ids/uuidv7.js';

interface NotificationDbRow {
  readonly id: string;
  readonly tenantId: string;
  readonly recipientId: string;
  readonly title: string;
  readonly body: string | null;
  readonly source: string;
  readonly refType: string | null;
  readonly refId: string | null;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

function toNotification(row: NotificationDbRow): Notification {
  return {
    id: row.id,
    tenant: TenantId.create(row.tenantId),
    recipient: UserId.create(row.recipientId),
    title: row.title,
    body: row.body,
    source: row.source,
    refType: row.refType,
    refId: row.refId,
    readAt: row.readAt === null ? null : row.readAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export class PgNotificationStore implements NotificationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: PublishNotificationInput): Promise<Notification> {
    const row = await this.prisma.notificationRecord.create({
      data: {
        id: uuidv7(), // 应用侧权威生成（本包 id 策略）
        tenantId: input.tenant,
        recipientId: input.recipient,
        title: input.title,
        body: input.body ?? null,
        source: input.source,
        refType: input.refType ?? null,
        refId: input.refId ?? null,
        readAt: null,
      },
    });
    return toNotification(row);
  }

  async listOwn(tenant: TenantId, recipient: UserId): Promise<readonly Notification[]> {
    const rows = await this.prisma.notificationRecord.findMany({
      where: { tenantId: tenant, recipientId: recipient },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // 新的在前（id tiebreak，与内存实现同序口径）
    });
    return rows.map(toNotification);
  }

  async countUnread(tenant: TenantId, recipient: UserId): Promise<number> {
    return this.prisma.notificationRecord.count({
      where: { tenantId: tenant, recipientId: recipient, readAt: null },
    });
  }

  async markRead(
    tenant: TenantId,
    recipient: UserId,
    id: string,
    readAt: string,
  ): Promise<Notification | null> {
    // 幂等：已读行 updateMany 零变更（WHERE read_at IS NULL 已滤），统一走读回。
    const at = new Date(readAt);
    const updated = await this.prisma.notificationRecord.updateMany({
      where: { tenantId: tenant, recipientId: recipient, id, readAt: null },
      data: { readAt: at },
    });
    if (updated.count === 0) {
      // 未命中：不存在 / 非本人（双键已滤）/ 已读——统一读回（已读幂等返回原行）。
      const row = await this.prisma.notificationRecord.findFirst({
        where: { tenantId: tenant, recipientId: recipient, id },
      });
      return row === null ? null : toNotification(row);
    }
    const row = await this.prisma.notificationRecord.findFirst({
      where: { tenantId: tenant, recipientId: recipient, id },
    });
    return row === null ? null : toNotification(row);
  }

  async markAllRead(tenant: TenantId, recipient: UserId, readAt: string): Promise<number> {
    const result = await this.prisma.notificationRecord.updateMany({
      where: { tenantId: tenant, recipientId: recipient, readAt: null },
      data: { readAt: new Date(readAt) },
    });
    return result.count;
  }
}

export interface NotificationStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/** 组合根装配句柄：通知端口实现 + 优雅断连。 */
export interface NotificationStoreHandle {
  readonly notificationStore: NotificationStore;
  disconnect(): Promise<void>;
}

/** 构造通知中心 PG 存储装配（惰性连接：同 `./workbench`）。 */
export function connectNotificationStore(
  options: NotificationStoreOptions = {},
): NotificationStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  const client = withRlsTenantSession(prisma, { session: rlsSessionEnabled() });
  return {
    notificationStore: new PgNotificationStore(client),
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}
