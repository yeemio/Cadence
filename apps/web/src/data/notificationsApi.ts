/**
 * 通知中心薄数据层（T1 #101：notifications 模块控制器实态）：
 *   GET  /notifications               notification:read   → { notifications: [...] }（本人收件箱，新→旧）
 *   GET  /notifications/unread-count  notification:read   → { count }
 *   POST /notifications/:id/read      notification:write  → 通知行（幂等）
 *   POST /notifications/read-all      notification:write  → { updated }（本次置读条数）
 *
 * 本人身份由会话令牌携带（apiClient request 注入），不从查询串进——数据级
 * (tenant, recipient) 双键过滤在后端存储端口收口。
 */
import { request } from './apiClient';
import { ModuleApiError } from './commandClient';

/** 收件箱通知行（notifications-stores.ts Notification 的视图形状）。 */
export interface NotificationView {
  readonly id: string;
  readonly title: string;
  readonly body: string | null;
  readonly source: string;
  readonly refType: string | null;
  readonly refId: string | null;
  readonly readAt: string | null;
  readonly createdAt: string;
}

function parseNotification(row: unknown, index: number): NotificationView {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new ModuleApiError(undefined, `通知行[${index}]非对象`);
  }
  const record = row as Record<string, unknown>;
  for (const field of ['id', 'title', 'source', 'createdAt'] as const) {
    if (typeof record[field] !== 'string') {
      throw new ModuleApiError(undefined, `通知行[${index}]缺 '${field}' 字符串字段`);
    }
  }
  if (record['readAt'] !== null && typeof record['readAt'] !== 'string') {
    throw new ModuleApiError(undefined, `通知行[${index}]readAt 须为字符串或 null`);
  }
  return {
    id: record['id'] as string,
    title: record['title'] as string,
    body: typeof record['body'] === 'string' ? record['body'] : null,
    source: record['source'] as string,
    refType: typeof record['refType'] === 'string' ? record['refType'] : null,
    refId: typeof record['refId'] === 'string' ? record['refId'] : null,
    readAt: record['readAt'] as string | null,
    createdAt: record['createdAt'] as string,
  };
}

/**
 * 响应体守卫（R2-NOTIF-01）：request 在非 JSON 体（SPA HTML/空体等）时回落
 * null——此前 `(body as Record)['notifications']` 对 null 取属性抛 TypeError
 * 直出页面（`Cannot read properties of null (reading 'notifications')`）。
 * 此处统一收口：非对象体抛人话 ModuleApiError（不露路径/技术细节）。
 */
function requireObjectBody(body: unknown, what: string): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ModuleApiError(undefined, `${what}响应无效，请稍后重试`);
  }
  return body as Record<string, unknown>;
}

/** 本人收件箱（notification:read；新→旧）。 */
export async function fetchNotifications(): Promise<readonly NotificationView[]> {
  const body = requireObjectBody(await request('/notifications'), '通知列表');
  const rows = body['notifications'];
  if (!Array.isArray(rows)) {
    throw new ModuleApiError(undefined, '通知列表响应无效，请稍后重试');
  }
  return rows.map(parseNotification);
}

/** 本人未读计数（notification:read；顶栏铃铛轮询入口）。 */
export async function fetchUnreadCount(): Promise<number> {
  const body = requireObjectBody(await request('/notifications/unread-count'), '未读计数');
  const count = body['count'];
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    throw new ModuleApiError(undefined, '未读计数响应无效，请稍后重试');
  }
  return count;
}

/** 标记单条已读（notification:write；幂等——已读行原样返回）。 */
export async function markNotificationRead(id: string): Promise<NotificationView> {
  const body: unknown = await request(`/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
  return parseNotification(body, 0);
}

/** 全部置读（notification:write；返回本次置读条数，0 = 本无未读）。 */
export async function markAllNotificationsRead(): Promise<number> {
  // method POST 不可省（控制器实态 POST /notifications/read-all；工作树回归修复）。
  const body = requireObjectBody(await request('/notifications/read-all', { method: 'POST' }), '全部置读');
  const updated = body['updated'];
  if (typeof updated !== 'number' || !Number.isInteger(updated) || updated < 0) {
    throw new ModuleApiError(undefined, '全部置读响应无效，请稍后重试');
  }
  return updated;
}
