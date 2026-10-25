/**
 * NotificationService —— 通知中心用例（T 波 #101）。
 *
 * 零框架业务类（不 import @nestjs/*）：实现 NotificationSourcePort（发布面，
 * 供合流后的事件点注入）+ 收件箱读/标用例。权限门禁不在用例层（路由
 * @RequirePermission + AuthGuard 已收口）；本人身份一律从 AuthGuard 写入的
 * 请求身份进（ADR-0005：身份不从查询串进），仅发布端点接受显式 recipient
 * （事件点代发语义，同 todos create 的 assignee 口径）。readAt 由服务端取
 * 当前时刻（ISO-8601），不从请求进——已读时刻是服务端事实。
 */
import { UserId, type TenantId } from '@smes/business-core';
import { NotificationNotFoundError } from './notifications-errors.js';
import { parseNotificationIdParam, parsePublishNotificationInput } from './notifications-input.js';
import type {
  Notification,
  NotificationSourcePort,
  NotificationStore,
  PublishNotificationInput,
} from './notifications-stores.js';

export class NotificationService implements NotificationSourcePort {
  constructor(private readonly store: NotificationStore) {}

  /** NotificationSourcePort.publish：既有事件点（点名/派修/IM）的发布钩子面（接线归合流）。 */
  async publish(input: PublishNotificationInput): Promise<Notification> {
    return this.store.create(input);
  }

  /** 发布端点用例：POST /notifications（运维补发/联调；解析层校验 recipient/title/source）。 */
  async create(tenant: TenantId, input: unknown): Promise<Notification> {
    const payload = parsePublishNotificationInput(input);
    return this.store.create({
      tenant,
      recipient: UserId.create(payload.recipient),
      title: payload.title,
      ...(payload.body === undefined ? {} : { body: payload.body }),
      source: payload.source,
      ...(payload.refType === undefined ? {} : { refType: payload.refType }),
      ...(payload.refId === undefined ? {} : { refId: payload.refId }),
    });
  }

  /** 本人收件箱（新的在前；数据级过滤在存储端口）。 */
  async listOwn(tenant: TenantId, recipient: UserId): Promise<readonly Notification[]> {
    return this.store.listOwn(tenant, recipient);
  }

  /** 本人未读计数。 */
  async countUnread(tenant: TenantId, recipient: UserId): Promise<number> {
    return this.store.countUnread(tenant, recipient);
  }

  /** 标记单条已读（幂等）；不存在/非本人 → 404 语义。 */
  async markRead(tenant: TenantId, recipient: UserId, idParam: string): Promise<Notification> {
    const id = parseNotificationIdParam(idParam);
    const marked = await this.store.markRead(tenant, recipient, id, new Date().toISOString());
    if (marked === null) {
      throw new NotificationNotFoundError(`租户 '${tenant}' 内不存在本人通知 '${id}'`);
    }
    return marked;
  }

  /** 全部置读：返回本次置读条数（0 = 本无未读，幂等）。 */
  async markAllRead(tenant: TenantId, recipient: UserId): Promise<number> {
    return this.store.markAllRead(tenant, recipient, new Date().toISOString());
  }
}
