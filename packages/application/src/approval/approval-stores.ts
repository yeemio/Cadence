/**
 * ApprovalCaseStore —— 审批案件存储端口（M1 收尾波-①）。
 *
 * 与 UserStore/TodoStore 同一模式：端口在本包定义（业务形状），内存实现先行，
 * PG adapter 由 business-store 按 `./approval` 子路径接入（组合根经
 * connectApprovalStore 装配）。词汇纪律（ADR-0010）：case/approval/subject/
 * decision/submitter 全部为跨离散制造行业通用词。
 *
 * 版本与事实源取舍（与 engine-flow 的分工）：
 *  - 案件行是**投影**：state/objectVersion 是事件账本（engine-flow
 *    ApprovalEventStore）重放结果的快照，供列表/过滤的低成本读；
 *  - 事件账本是**事实源**：act() 先重放事件重建运行时，再提交决策——
 *    案件行经 advance 做乐观推进（expectedObjectVersion 不符即冲突）。
 *  - 表形态：案件是运营状态（state 可 UPDATE），不是业务事实——不套证据
 *    公共列、不套 append-only 触发器（取舍同 todos，见 business-store README）。
 */
import { TenantId, UserId } from '@smes/business-core';

/** 被审批对象引用（通用聚合引用：type/id 两段，语义由调用方领域定义）。 */
export interface ApprovalSubjectRefView {
  /** 聚合类型（单段小写形状，如 item/resource——通用词）。 */
  readonly type: string;
  /** 聚合 id（ opaque 字符串，由被引用系统生成）。 */
  readonly id: string;
}

/** 审批案件（案件行视图；决策记录与迁移事件在 engine-flow 存储端口）。 */
export interface ApprovalCase {
  /** 案件 id（opaque 字符串，服务端生成）。 */
  readonly id: string;
  readonly tenant: TenantId;
  /** 审批流配置标识（engine-flow config.flowId）。 */
  readonly flowConfigId: string;
  /** 当前状态 id（配置状态集内的通用词）。 */
  readonly state: string;
  /** 当前对象版本（初始 1，每次成功迁移 +1；乐观锁口径）。 */
  readonly objectVersion: number;
  /** 被审批对象引用（通用聚合引用）。 */
  readonly subjectRef: ApprovalSubjectRefView;
  /** 发起人（品牌化 UserId）。 */
  readonly submitter: UserId;
  /** ISO 8601，创建时刻。 */
  readonly createdAt: string;
}

export interface CreateApprovalCaseInput {
  readonly tenant: TenantId;
  readonly id: string;
  readonly flowConfigId: string;
  readonly state: string;
  readonly objectVersion: number;
  readonly subjectRef: ApprovalSubjectRefView;
  readonly submitter: UserId;
}

export interface ListApprovalCasesFilter {
  /** 状态精确过滤（可选；缺省 = 全部状态）。 */
  readonly state?: string | undefined;
}

/**
 * 案件存储端口。实现方保证：
 *  - create/list/find 一律按租户收口（跨租户不可见）；
 *  - advance 为乐观推进：仅当当前 objectVersion === expectedObjectVersion 时
 *    写入 next.state 与 next.objectVersion（实现自定：+1，由调用方传终值），
 *    未命中（不存在或版本不符）抛 ApprovalConflictError；
 *  - list 按 createdAt 降序（新的在前，与既有列表端点同序）。
 */
export interface ApprovalCaseStore {
  create(input: CreateApprovalCaseInput): Promise<ApprovalCase>;
  find(tenant: TenantId, id: string): Promise<ApprovalCase | null>;
  list(tenant: TenantId, filter?: ListApprovalCasesFilter): Promise<readonly ApprovalCase[]>;
  /** 乐观状态推进：版本不符或不存在 → ApprovalConflictError（404 语义由用例层前置 find 翻译）。 */
  advance(
    tenant: TenantId,
    id: string,
    expectedObjectVersion: number,
    nextState: string,
    nextObjectVersion: number,
  ): Promise<ApprovalCase>;
}
