/**
 * 通知中心输入解析（HTTP body → 业务输入；T 波 #101）。
 *
 * 与 masterdata-input 同一纪律：违规抛 NotificationInputError（组合根映射
 * 400），绝不静默丢弃。发布端点主要服务合流后的事件点联调与运维补发，
 * 消费端（list/unread-count/mark-read）无请求体。
 */
import { NotificationInputError } from './notifications-errors.js';

/** 来源模块码形状：单段小写（同 TodoStore.source 的 'approval' 形状）。 */
const SOURCE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new NotificationInputError(`${what}必须是对象：${JSON.stringify(input)}`);
  }
  return input as Record<string, unknown>;
}

function requireTitle(value: unknown): string {
  if (typeof value !== 'string') {
    throw new NotificationInputError(`标题必须是字符串：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    throw new NotificationInputError(`标题须为 1~128 个非空白字符：${JSON.stringify(value)}`);
  }
  return trimmed;
}

function requireSource(value: unknown): string {
  if (typeof value !== 'string' || !SOURCE_PATTERN.test(value)) {
    throw new NotificationInputError(
      `来源码 '${JSON.stringify(value)}' 非法：须为单段小写形状（小写字母开头，仅小写字母/数字/连字符，1~32 字符）`,
    );
  }
  return value;
}

/** 可选自由文本：undefined → 缺省不动；null → 显式清空；字符串 trim 后 1~上限。 */
function optionalText(value: unknown, field: string, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new NotificationInputError(`字段 '${field}' 须为字符串或 null：${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null; // 纯空白视为清空
  if (trimmed.length > maxLength) {
    throw new NotificationInputError(`字段 '${field}' 超长（>${maxLength}）：${JSON.stringify(value)}`);
  }
  return trimmed;
}

/** 引用对象类型/id：单段小写/中划线形状（同 source；跨模块引用键的通用形状）。 */
function optionalRef(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || !SOURCE_PATTERN.test(value)) {
    throw new NotificationInputError(
      `字段 '${field}' '${JSON.stringify(value)}' 非法：须为单段小写形状或 null`,
    );
  }
  return value;
}

/** 收件人（UserId 串）形状：非空、无空白的不透明串。 */
function requireRefCode(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128 || /\s/.test(value)) {
    throw new NotificationInputError(`${what} id 非法：${JSON.stringify(value)}`);
  }
  return value.trim();
}

export interface PublishNotificationPayload {
  /** 收件人（品牌化 UserId 字符串；发布端点为受信调用面，收件人从请求体进——与 todos create 的 assignee 同口径）。 */
  readonly recipient: string;
  readonly title: string;
  readonly body?: string | null;
  readonly source: string;
  readonly refType?: string | null;
  readonly refId?: string | null;
}

/** 解析 POST /notifications 请求体（发布一条站内通知）。 */
export function parsePublishNotificationInput(input: unknown): PublishNotificationPayload {
  const record = requireObject(input, '发布通知请求体');
  const payload: {
    recipient: string;
    title: string;
    body?: string | null;
    source: string;
    refType?: string | null;
    refId?: string | null;
  } = {
    recipient: requireRefCode(record['recipient'], '收件人'),
    title: requireTitle(record['title']),
    source: requireSource(record['source']),
  };
  const body = optionalText(record['body'], 'body', 1024);
  if (body !== undefined) payload.body = body;
  const refType = optionalRef(record['refType'], 'refType');
  if (refType !== undefined) payload.refType = refType;
  const refId = optionalText(record['refId'], 'refId', 128);
  if (refId !== undefined) payload.refId = refId;
  return payload;
}

/** 路径参数 id 解析（非空、无空白即收——id 是存储侧生成的不透明串）。 */
export function parseNotificationIdParam(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || /\s/.test(trimmed)) {
    throw new NotificationInputError(`通知 id 非法：${JSON.stringify(value)}`);
  }
  return trimmed;
}
