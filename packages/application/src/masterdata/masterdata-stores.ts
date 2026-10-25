/**
 * ItemStore / ResourceStore —— 基础数据存储端口（M1 增量 4-I，core 基础层章程）。
 *
 * 与 UserStore/RoleStore 同一模式：端口在本包定义（业务形状），内存实现先行，
 * PG adapter 由 business-store 按 `./masterdata` 子路径接入。
 *
 * 词汇纪律（ADR-0010 判定三问自证）：Item（物品）/ Resource（资源）/
 * category（分类）/ spec（规格）/ unit（单位）均为跨离散制造行业通用词——
 * 不绑定机加工（无"物料=钢件"之类行业语义），M2 的 BOM/版本化物料是非目标。
 *
 * 取舍（表形态）：items / resources 是**主数据/配置数据，不是业务事实**——
 * 不套证据公共列、不套 append-only/supersedes 修正链（修正 = 直接改行；
 * 纪律只约束事实表，见 business-store 包 README）。无 delete：主数据将被
 * M2 事务表引用，硬删引入悬挂引用；停用路径 = active=false（软停用）。
 * 端口因此是 create/list/find/update 最小集。
 */
import { TenantId } from '@smes/business-core';

/** 物品主数据（通用"物"概念：原料/半成品/成品/辅料……分类由 category 自由描述）。 */
export interface ItemMaster {
  readonly id: string;
  readonly tenant: TenantId;
  /** 租户内唯一业务键（人读稳定码，如 P-1001）。 */
  readonly code: string;
  readonly name: string;
  /** 规格（自由文本，可空）。 */
  readonly spec: string | null;
  /** 计量单位（自由文本，可空）。 */
  readonly unit: string | null;
  /** 分类（自由文本，可空；行业词只进数据不进代码）。 */
  readonly category: string | null;
  readonly active: boolean;
}

export interface CreateItemInput {
  readonly tenant: TenantId;
  readonly code: string;
  readonly name: string;
  readonly spec?: string | null;
  readonly unit?: string | null;
  readonly category?: string | null;
  /** 缺省 true。 */
  readonly active?: boolean;
}

/** 字段级期望态更新：未提供的键不变；code 不可变（唯一键稳定性）。 */
export interface UpdateItemInput {
  readonly name?: string;
  readonly spec?: string | null;
  readonly unit?: string | null;
  readonly category?: string | null;
  readonly active?: boolean;
}

/**
 * 物品主数据存储端口。实现方保证：
 * create 在租户内 code 冲突时抛 MasterdataConflictError；
 * update 对不存在的 id 返回 null（404 语义由用例层翻译）。
 */
export interface ItemStore {
  create(input: CreateItemInput): Promise<ItemMaster>;
  list(tenant: TenantId): Promise<readonly ItemMaster[]>;
  find(tenant: TenantId, id: string): Promise<ItemMaster | null>;
  update(tenant: TenantId, id: string, input: UpdateItemInput): Promise<ItemMaster | null>;
}

/** 资源主数据（通用"产能资源"概念：设备/工位/人员组……类型由 type 自由描述）。 */
export interface ResourceMaster {
  readonly id: string;
  readonly tenant: TenantId;
  readonly code: string;
  readonly name: string;
  /** 资源类型（自由文本，可空；行业词只进数据不进代码）。 */
  readonly type: string | null;
  readonly active: boolean;
}

export interface CreateResourceInput {
  readonly tenant: TenantId;
  readonly code: string;
  readonly name: string;
  readonly type?: string | null;
  readonly active?: boolean;
}

export interface UpdateResourceInput {
  readonly name?: string;
  readonly type?: string | null;
  readonly active?: boolean;
}

/** 资源主数据存储端口（合同同 ItemStore，唯一键为租户内 code）。 */
export interface ResourceStore {
  create(input: CreateResourceInput): Promise<ResourceMaster>;
  list(tenant: TenantId): Promise<readonly ResourceMaster[]>;
  find(tenant: TenantId, id: string): Promise<ResourceMaster | null>;
  update(tenant: TenantId, id: string, input: UpdateResourceInput): Promise<ResourceMaster | null>;
}

// ---------------------------------------------------------------------------
// 客户/供应商/计量单位（S1 backfill：0920 #8/#9/#100）。与 items/resources
// 同一取舍：主数据/配置数据——普通 CRUD、无 delete、code 租户内唯一且不可变。
// 客户/供应商设 active 软停用（交易对手方被工作令/外协/采购引用，硬删悬挂）；
// 计量单位为纯字典（被 ItemMaster.unit 文本引用，无外键完整性要保护）——
// 最小集 code/name/symbol、不设 active（取舍：改错单位 = 直接改名，无停用语义）。
// ---------------------------------------------------------------------------

/** 客户主数据（工作令创建时选用——0920 #8）。 */
export interface CustomerMaster {
  readonly id: string;
  readonly tenant: TenantId;
  readonly code: string;
  readonly name: string;
  /** 联系方式（自由文本，可空——电话/邮箱/地址合一，实施口径）。 */
  readonly contact: string | null;
  readonly active: boolean;
}

export interface CreateCustomerInput {
  readonly tenant: TenantId;
  readonly code: string;
  readonly name: string;
  readonly contact?: string | null;
  readonly active?: boolean;
}

export interface UpdateCustomerInput {
  readonly name?: string;
  readonly contact?: string | null;
  readonly active?: boolean;
}

/** 客户存储端口（实现方保证：租户内 code 冲突抛 MasterdataConflictError；不存在 id 更新返回 null）。 */
export interface CustomerStore {
  create(input: CreateCustomerInput): Promise<CustomerMaster>;
  list(tenant: TenantId): Promise<readonly CustomerMaster[]>;
  find(tenant: TenantId, id: string): Promise<CustomerMaster | null>;
  update(tenant: TenantId, id: string, input: UpdateCustomerInput): Promise<CustomerMaster | null>;
}

/** 供应商主数据（外协厂家与供货商——0920 #9，供外协派工及采购引用）。 */
export interface SupplierMaster {
  readonly id: string;
  readonly tenant: TenantId;
  readonly code: string;
  readonly name: string;
  readonly active: boolean;
}

export interface CreateSupplierInput {
  readonly tenant: TenantId;
  readonly code: string;
  readonly name: string;
  readonly active?: boolean;
}

export interface UpdateSupplierInput {
  readonly name?: string;
  readonly active?: boolean;
}

/** 供应商存储端口（合同同 CustomerStore，无 contact 字段）。 */
export interface SupplierStore {
  create(input: CreateSupplierInput): Promise<SupplierMaster>;
  list(tenant: TenantId): Promise<readonly SupplierMaster[]>;
  find(tenant: TenantId, id: string): Promise<SupplierMaster | null>;
  update(tenant: TenantId, id: string, input: UpdateSupplierInput): Promise<SupplierMaster | null>;
}

/** 计量单位字典项（0920 #100；symbol 如 PCS/KG）。 */
export interface UnitMaster {
  readonly id: string;
  readonly tenant: TenantId;
  readonly code: string;
  readonly name: string;
  /** 单位符号（可空——部分单位以名称即符号）。 */
  readonly symbol: string | null;
}

export interface CreateUnitInput {
  readonly tenant: TenantId;
  readonly code: string;
  readonly name: string;
  readonly symbol?: string | null;
}

export interface UpdateUnitInput {
  readonly name?: string;
  readonly symbol?: string | null;
}

/** 计量单位存储端口（合同同 CustomerStore；字典无 active，改错=直接改名）。 */
export interface UnitStore {
  create(input: CreateUnitInput): Promise<UnitMaster>;
  list(tenant: TenantId): Promise<readonly UnitMaster[]>;
  find(tenant: TenantId, id: string): Promise<UnitMaster | null>;
  update(tenant: TenantId, id: string, input: UpdateUnitInput): Promise<UnitMaster | null>;
}
