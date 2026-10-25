/**
 * ApprovalFlowConfigStore —— 审批流配置存储端口（T 波 #102，approval 域）。
 *
 * 与 ItemStore 同一模式：端口在本包定义（业务形状），内存实现先行，PG adapter
 * 由 business-store 按 `./approval-config` 子路径接入（子路径导出登记归合流）。
 *
 * 定位（配置与运行时的分工）：engine-flow 的 ApprovalFlowConfig 是纯数据
 * （可序列化、可版本化、可整体替换，见 engine-flow config.ts）；现状
 * ApprovalService 在装配期以注入的静态配置驱动（DEFAULT_APPROVAL_FLOW_CONFIG
 * 或组合根替换）。#102 把配置升级为**租户级可管理数据**——状态机配置文档
 * 整体持久化（一行 = 一份流配置），案件行 approval_cases.flow_config_id 引用
 * 的 flowId 即本表业务键。运行时如何按租户装载持久化配置（装配选择策略）
 * 属接线，归合流。
 *
 * 词汇纪律（ADR-0010）：flow/config/state/transition 全为 engine-flow 既有
 * 通用词，本端口不引入新词汇。
 *
 * 取舍（表形态）：approval_flow_configs 是配置数据，不是业务事实——不套证据
 * 公共列、不套 append-only/supersedes（修正 = 直接改行；纪律只约束事实表，
 * 见 business-store 包 README）。无 delete：案件行按 flowId 引用配置，硬删
 * 引入悬挂引用；停用路径 = active=false（软停用：存量案件可继续审结，新案
 * 不再发起——装载策略归合流）。配置换代不做行内版本链：配置文档自身带
 * schemaVersion，引擎重放守卫（案件重放与配置不符即状态冲突）已兜底换代
 * 风险，不叠加 supersedes 链。
 */
import { TenantId } from '@smes/business-core';
import type { ApprovalFlowConfig } from '@smes/engine-flow';

/** 审批流配置行（一行 = 一份完整状态机配置文档）。createdAt/updatedAt 为 ISO-8601 字符串。 */
export interface ApprovalFlowConfigRecord {
  readonly id: string;
  readonly tenant: TenantId;
  /** 流标识（= config.flowId；案件行 flowConfigId 引用的业务键）。 */
  readonly flowId: string;
  /** 人读名（管理页列表标题）。 */
  readonly name: string;
  /** 引擎配置全文（defineApprovalFlowConfig 固化形状；存储 JSON、读出经固化复核）。 */
  readonly config: ApprovalFlowConfig;
  /** 软停用（false = 不再可发起新案；存量案件审结归运行时装载策略）。 */
  readonly active: boolean;
  /**
   * 历史版本快照（新的在后；末位之前每被整文档替换一次压入一份先前快照——
   * T1 接线补 #102"版本历史+启用指定版本"：启用历史版本 = PUT config=该快照，
   * 走与手工编辑完全相同的校验/替换路径，当前 config 再入历史。封顶 20 条
   * （超出丢最旧）。只读事实，不参与 update 输入。
   */
  readonly history: readonly ApprovalFlowConfigVersion[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 历史版本条目：一份先前生效的配置快照 + 其生效截止时刻（= 当时的 updatedAt）。 */
export interface ApprovalFlowConfigVersion {
  readonly config: ApprovalFlowConfig;
  readonly savedAt: string;
}

export interface CreateApprovalFlowConfigInput {
  readonly tenant: TenantId;
  readonly flowId: string;
  readonly name: string;
  readonly config: ApprovalFlowConfig;
  readonly active?: boolean;
}

/** 字段级期望态更新：未提供的键不变；flowId 不可变（案件行引用稳定性）；config 提供即整文档替换。 */
export interface UpdateApprovalFlowConfigInput {
  readonly name?: string;
  readonly config?: ApprovalFlowConfig;
  readonly active?: boolean;
}

/**
 * 审批流配置存储端口。实现方保证：
 *  - create 在租户内 flowId 冲突时抛 ApprovalConfigConflictError；
 *  - update 对不存在的 id 返回 null（404 语义由用例层翻译）；
 *  - history 由实现维护：config 整文档替换时把先前 config 快照（含当时
 *    updatedAt）压入行尾，封顶丢弃最旧；非 config 更新不动 history；
 *  - JSON 列读出后经 defineApprovalFlowConfig 固化复核（损坏配置 fail-fast
 *    抛 ApprovalConfigInputError，不带病返回）——history 内快照同复核；
 *  - list 按 flowId 升序；updatedAt 随每次成功 update 推进。
 */
export interface ApprovalFlowConfigStore {
  create(input: CreateApprovalFlowConfigInput): Promise<ApprovalFlowConfigRecord>;
  list(tenant: TenantId): Promise<readonly ApprovalFlowConfigRecord[]>;
  find(tenant: TenantId, id: string): Promise<ApprovalFlowConfigRecord | null>;
  update(
    tenant: TenantId,
    id: string,
    input: UpdateApprovalFlowConfigInput,
  ): Promise<ApprovalFlowConfigRecord | null>;
  /**
   * 租户内单启用收口（T1 接线 #102"启用指定版本"的服务端语义）：把 id 行置
   * active=true 的同时，把租户内其余 active 行全部置 false。对不存在的 id
   * 返回 null；无并发原子性承诺（管理面低频操作，竞窗内可能出现双 active，
   * 读取侧取 flowId 升序首行，行为仍确定）。
   */
  activate(tenant: TenantId, id: string): Promise<ApprovalFlowConfigRecord | null>;
}
