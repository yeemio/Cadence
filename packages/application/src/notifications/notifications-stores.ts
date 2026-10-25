/**
 * NotificationStore / NotificationSource —— 站内通知中心存储端口与发布端口
 * （T 波 #101，109 口径能力子集）。
 *
 * 与 TodoStore 同一模式：端口在本包定义（业务形状），内存实现先行，PG adapter
 * 由 business-store 按 `./notifications` 子路径接入（子路径导出登记归合流）。
 *
 * 词汇纪律（ADR-0010 判定三问自证）：notification（通知）/ inbox（收件箱）/
 * recipient（收件人）/ source（来源模块码）均为跨行业通用词；行业语义只可能
 * 出现在数据行（title/refType），不进代码词汇。
 *
 * 数据级过滤合同（同 todos）：一切读/标记操作都以 (tenant, recipient) 双键
 * 收口——非本人的通知对当事人表现为"不存在"（null → 用例层翻 404），不泄漏
 * 存在性。
 *
 * 取舍（表形态）：notifications 是轻量运营状态（未读→已读单向标记），不是
 * 业务事实——不套证据公共列、不套 append-only/supersedes（纪律只约束事实表，
 * 见 business-store 包 README）。通知的**事实源**是各业务域自己的事件账本，
 * 收件箱行只是面向人的投影视图；本波不做事件→通知的自动投影（发布钩子接线
 * 归合流单行）。
 *
 * 分工（与待办的边界）：todo 是"要处理的事"（有完成语义），notification 是
 * "要知道的事"（有已读语义）——两端口同形态不同生命周期动词，不合并。
 */
import { TenantId, UserId } from '@smes/business-core';

/**
 * 通知来源模块码：单段小写形状（如 inspection/dispatch/im），语义由发布方
 * 领域定义（合流接线时点名/派修/IM 各自占一个码）。形状校验在输入解析层。
 */
export type NotificationSource = string;

/** 收件箱通知行（createdAt/readAt 为 ISO-8601 字符串；readAt=null 即未读）。 */
export interface Notification {
  readonly id: string;
  readonly tenant: TenantId;
  /** 收件人（品牌化 UserId——通知归属人）。 */
  readonly recipient: UserId;
  readonly title: string;
  /** 正文（可空——短通知可只投标题）。 */
  readonly body: string | null;
  /** 来源模块码（NotificationSource；跨模块聚合的分组键）。 */
  readonly source: NotificationSource;
  /** 引用对象类型/id（可空——带业务指向时前端可跳转）。 */
  readonly refType: string | null;
  readonly refId: string | null;
  /** 已读时刻（null = 未读）。 */
  readonly readAt: string | null;
  readonly createdAt: string;
}

export interface PublishNotificationInput {
  readonly tenant: TenantId;
  readonly recipient: UserId;
  readonly title: string;
  readonly body?: string | null;
  readonly source: NotificationSource;
  readonly refType?: string | null;
  readonly refId?: string | null;
}

/**
 * 通知存储端口（收件箱）。实现方保证：
 *  - create 后 readAt=null、createdAt 为服务端时间；
 *  - listOwn/countUnread/markRead/markAllRead 一律按 (tenant, recipient)
 *    双键收口（跨租户/跨本人不可见）；
 *  - listOwn 按 createdAt 降序（新的在前，与既有列表端点同序）；
 *  - markRead 幂等：已读行原样返回，不重复迁移；
 *  - markRead 对不存在/非本人的 id 返回 null（404 语义由用例层翻译）；
 *  - markAllRead 只迁移未读行，返回本次置读条数（0 = 本无未读，幂等）。
 */
export interface NotificationStore {
  create(input: PublishNotificationInput): Promise<Notification>;
  listOwn(tenant: TenantId, recipient: UserId): Promise<readonly Notification[]>;
  countUnread(tenant: TenantId, recipient: UserId): Promise<number>;
  markRead(
    tenant: TenantId,
    recipient: UserId,
    id: string,
    readAt: string,
  ): Promise<Notification | null>;
  markAllRead(tenant: TenantId, recipient: UserId, readAt: string): Promise<number>;
}

/**
 * NotificationSource 端口 —— 既有事件点（点名/派修/IM）投递站内通知的发布面。
 *
 * 依赖倒置取舍：事件点模块依赖本端口（而非 NotificationStore 全量收件箱
 * 读写面），发布钩子 = 合流在各事件点单行注入 `source.publish({...})`。
 * 本波只定义端口与最小实现（service 即端口实现，见 notifications.service.ts），
 * 不动既有事件点源码。
 */
export interface NotificationSourcePort {
  publish(input: PublishNotificationInput): Promise<Notification>;
}
