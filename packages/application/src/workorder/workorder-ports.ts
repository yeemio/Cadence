/**
 * workorder 跨模块端口（M2-W1，02-workorder.md §4"依赖 M2 兄弟模块"）。
 *
 * 只定义接口（模块间互调一律经 application 层端口，ADR-0011 / 通用合同纪律
 * 6）：listing 清单需求行、inventory 可用量与配件出库、reporting/dispatch
 * 进度事实（只读订阅）、masterdata 客户目录（只读解析）。实现方：
 *  - 内存/测试：testkit 夹具 + 本模块缺省空实现（零接线 boot 语义完整）；
 *  - 真实联动：各兄弟模块在合流时提供实现，经 WorkOrderModule.register 注入。
 *
 * 端口方法一律异步（PG 实现天然异步，端口按异步定形调用方零改动——取舍同
 * engine-flow store.ts）。全部按租户收口。
 */
import type { TenantId, UserId } from '@smes/business-core';
import type { PolicyStore, PolicyRule } from '../core/auth/policy-store.js';
import type { UserStore } from '../org/org-stores.js';
import type { ListingKind } from './workorder-config.js';

// ---- listing 端口：清单需求行（齐套判定的需求侧输入） ----

/** 清单需求行（listing 模块清单行的只读投影；词汇镜像 03-listing.md §2）。 */
export interface ListingRequirementLine {
  /** 所属清单类目。 */
  readonly kind: ListingKind;
  /** 物料 id（masterdata 物品 id，opaque 字符串）。 */
  readonly itemId: string;
  /** 图号（可空——标准件/电气件常无图号）。 */
  readonly drawingNo: string | null;
  /** 需求数量（正数）。 */
  readonly requiredQty: number;
  /** 需求日期（ISO 8601，可空）。 */
  readonly neededBy: string | null;
}

/** listing 端口：按工作令读清单需求行（四类清单的行级投影）。 */
export interface ListingRequirementPort {
  requirementLines(tenant: TenantId, workOrderId: string): Promise<readonly ListingRequirementLine[]>;
}

// ---- inventory 端口：可用量（齐套判定的供给侧输入） ----

/** inventory 端口：批量读物料可用量（返回 Map：请求的 itemId → 可用量；缺项 = 0）。 */
export interface InventoryAvailabilityPort {
  availableQty(
    tenant: TenantId,
    itemIds: readonly string[],
    workOrderId?: string,
  ): Promise<ReadonlyMap<string, number>>;
}

// ---- inventory 端口：配件出库指令（parts.ship 联动） ----

/** 出库指令回执：issued=false 携拒绝原因（如可用量不足）——命令以 rejected 收场，不落账。 */
export interface PartsIssueReceipt {
  readonly issued: boolean;
  readonly refusedReason?: string;
}

/** 出库指令（幂等键 = requestId：实现方须按 requestId 去重，重试不重复扣减）。 */
export interface PartsIssueCommand {
  readonly requestId: string;
  readonly workOrderId: string;
  readonly itemId: string;
  readonly quantity: number;
}

/** inventory 端口：配件发货出库（parts.approve 后 parts.ship 的联动动作）。 */
export interface PartsIssuePort {
  issueParts(tenant: TenantId, command: PartsIssueCommand): Promise<PartsIssueReceipt>;
}

// ---- reporting/dispatch 端口：进度事实（只读订阅，三类进度视图的数据源） ----

/** 进度事实阶段：machining=机加工（图号×工序）；assembly=装配调试。 */
export type ProgressStage = 'machining' | 'assembly';

/** 进度事实（dispatch 派工 × reporting 报工的上卷投影行，只读）。 */
export interface ProgressFact {
  readonly stage: ProgressStage;
  /** 图号（机加工上卷键；装配阶段可空）。 */
  readonly drawingNo: string | null;
  /** 工序 id（opaque；装配调试的工序名）。 */
  readonly operationId: string;
  /** 完成数量。 */
  readonly doneQty: number;
  /** 总数量。 */
  readonly totalQty: number;
  /** 行状态。 */
  readonly status: 'pending' | 'in_progress' | 'done';
}

/** reporting/dispatch 端口：按工作令读进度事实（只读订阅，不反写）。 */
export interface ProgressFactPort {
  progressFacts(tenant: TenantId, workOrderId: string): Promise<readonly ProgressFact[]>;
}

// ---- masterdata 端口：客户目录（主单据客户引用的只读解析） ----

/** 客户目录条目（展示用最小投影）。 */
export interface CustomerDirectoryEntry {
  readonly id: string;
  readonly name: string;
}

/** masterdata 端口：按引用解析客户（未知引用返回 null——不阻塞建单，展示层降级）。 */
export interface CustomerDirectoryPort {
  findCustomer(tenant: TenantId, customerRef: string): Promise<CustomerDirectoryEntry | null>;
}

// ---- org 端口：配件审批链角色解析（S6 / RREQ-IS-037：待审批人实时按角色解析不落库） ----

/**
 * 配件二/三级审批的角色或签名单解析端口。实现方按租户读 org 域角色绑定与
 * 活动用户（见 createOrgPartsApproverDirectory）；「实时」是合同口径——
 * 名单绝不落库，每次审批/详情读时现解析，角色成员变化即时生效。
 */
export interface PartsApproverDirectoryPort {
  /**
   * 解析租户内角色下的活动审批人（或签名单）。角色未配置/角色下无活动用户/
   * 端口未接线 → 空数组（调用方按「未配置或无审批人」提示，不静默放行）。
   */
  roleApprovers(tenant: TenantId, role: string): Promise<readonly UserId[]>;
}

/** 缺省角色解析端口：恒空名单（零接线 boot；多级链在该级审批时明确拒绝）。 */
export const EMPTY_PARTS_APPROVER_DIRECTORY: PartsApproverDirectoryPort = {
  roleApprovers: async () => [],
};

/**
 * org 域实现工厂（组合根接线用）：角色名单 = PolicyStore grant-role 绑定 ∩
 * UserStore 活动用户（停用用户即时退出或签名单——实时解析语义）。任一存储
 * 未装配（undefined）返回缺省空端口（模块禁用时配件二/三级审批明确拒绝，
 * 不静默换人）。
 */
export function createOrgPartsApproverDirectory(
  policy: PolicyStore | undefined,
  users: UserStore | undefined,
): PartsApproverDirectoryPort {
  if (policy === undefined || users === undefined) {
    return EMPTY_PARTS_APPROVER_DIRECTORY;
  }
  const isGrant = (rule: PolicyRule, tenant: TenantId, role: string): rule is Extract<PolicyRule, { kind: 'grant-role' }> =>
    rule.kind === 'grant-role' && rule.tenant === tenant && rule.role === role;
  return {
    roleApprovers: async (tenant, role) => {
      const rules = await policy.load();
      const bound = new Set<string>(rules.filter((rule) => isGrant(rule, tenant, role)).map((rule) => rule.user));
      if (bound.size === 0) return [];
      const accounts = await users.list(tenant);
      return accounts.filter((account) => account.active && bound.has(account.id)).map((account) => account.id);
    },
  };
}

// ---- 缺省空实现（零接线 boot：语义完整、数据为空） ----

export const EMPTY_LISTING_PORT: ListingRequirementPort = {
  requirementLines: async () => [],
};

export const EMPTY_INVENTORY_PORT: InventoryAvailabilityPort = {
  availableQty: async () => new Map<string, number>(),
};

/** 缺省出库端口：恒放行（无 inventory 接线时配件发货不阻塞；合流时替换为真实端口）。 */
export const NOOP_PARTS_ISSUE_PORT: PartsIssuePort = {
  issueParts: async () => ({ issued: true }),
};

export const EMPTY_PROGRESS_PORT: ProgressFactPort = {
  progressFacts: async () => [],
};

export const EMPTY_CUSTOMER_PORT: CustomerDirectoryPort = {
  findCustomer: async () => null,
};

/** 待办联动来源码（workbench TodoStore 的 source 口径；refType = 聚合类型）。 */
export const WORKORDER_TODO_SOURCE = 'workorder';
