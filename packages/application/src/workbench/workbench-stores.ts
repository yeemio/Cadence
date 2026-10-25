/**
 * TodoStore —— 工作台待办存储端口（M1 增量 4-I，core 基础层章程）。
 *
 * 词汇纪律（ADR-0010 判定三问自证）：Todo（待办）/ workbench（工作台）/
 * source（来源模块码）/ assignee（经办人）均为跨行业通用词——待办是
 * "某人要处理的事"这一上位概念，不绑定任何制造场景；行业语义只可能出现在
 * 数据行（title/refType），不进代码词汇。
 *
 * 数据级过滤合同：一切读操作都以 (tenant, assignee) 双键收口——实现方
 * 只返回/只更新当前用户自己的行。非本人的待办对当事人表现为"不存在"
 * （null → 用例层翻 404），不泄漏存在性（比 403 更保守）。
 *
 * 取舍（表形态）：todos 是轻量运营状态（open→done 单向迁移），不是业务
 * 事实——不套证据公共列、不套 append-only/supersedes（纪律只约束事实表，
 * 见 business-store 包 README）。业务事件→待办的自动投影是 M2+ 非目标，
 * 本端口先服务手动创建 + API 创建。
 */
import { TenantId, UserId } from '@smes/business-core';

export type TodoStatus = 'open' | 'done';

/** 待办行（工作台聚合的原子单元）。createdAt/dueAt 为 ISO-8601 字符串。 */
export interface TodoItem {
  readonly id: string;
  readonly tenant: TenantId;
  /** 经办人（品牌化 UserId——待办归属人）。 */
  readonly assignee: UserId;
  readonly title: string;
  /** 来源模块码（单段小写形状，如 masterdata/workorder；跨模块聚合的分组键）。 */
  readonly source: string;
  /** 引用对象类型/ id（可空——投影或手动创建时可带业务指向）。 */
  readonly refType: string | null;
  readonly refId: string | null;
  readonly status: TodoStatus;
  readonly createdAt: string;
  readonly dueAt: string | null;
}

export interface CreateTodoInput {
  readonly tenant: TenantId;
  readonly assignee: UserId;
  readonly title: string;
  readonly source: string;
  readonly refType?: string | null;
  readonly refId?: string | null;
  readonly dueAt?: string | null;
}

/**
 * 待办存储端口。实现方保证：
 *  - create 后 status='open'、createdAt 为服务端时间；
 *  - listOwn/findOwn/complete 一律按 (tenant, assignee) 双键收口；
 *  - complete 幂等：已 done 的行原样返回，不重复迁移；
 *  - complete 对不存在/非本人的 id 返回 null（404 语义由用例层翻译）。
 */
export interface TodoStore {
  create(input: CreateTodoInput): Promise<TodoItem>;
  listOwn(tenant: TenantId, assignee: UserId): Promise<readonly TodoItem[]>;
  findOwn(tenant: TenantId, assignee: UserId, id: string): Promise<TodoItem | null>;
  complete(tenant: TenantId, assignee: UserId, id: string): Promise<TodoItem | null>;
}
