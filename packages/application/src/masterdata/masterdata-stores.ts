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
  /**
   * 初始价格（含税单价，分；可空 = 未维护——RREQ-MD-020，fix-wave-6 6b-1 S9）。
   * 语义：无历史采购成交价时成本取价以此兜底（**取价消费侧联动归 costing
   * 对账口径，本批不做，登记**）；清空保存 = 取消初始价格。Int 分口径与
   * listing unitPriceMinor / 全库 minor 列一致（源侧 BigDecimal 16 位整数
   * 形态不复刻，差异随需求登记）。
   */
  readonly initialPriceMinor: number | null;
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
  /** 初始价格（分，≥0 整数；缺省 null = 未维护）。 */
  readonly initialPriceMinor?: number | null;
}

/** 字段级期望态更新：未提供的键不变；code 不可变（唯一键稳定性）。 */
export interface UpdateItemInput {
  readonly name?: string;
  readonly spec?: string | null;
  readonly unit?: string | null;
  readonly category?: string | null;
  readonly active?: boolean;
  /** 初始价格（分）：未提供不变；null = 清空保存（取消初始价格）；整数 ≥0。 */
  readonly initialPriceMinor?: number | null;
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

// ---------------------------------------------------------------------------
// 物品价格台账（RREQ-MD-019，fix-wave-6 6b-1 S9；U9 中止版按 PRD 11 册定义重做）
//
// 口径（与 U9 旧设计的差异，依 6b-1 派发冻结）：**不建 masterdata 自有价格
// 历史表**——数据源 = 采购域订单明细（listing 的 purchase_orders.lines），
// 只读消费；listing 域禁碰，读面在 masterdata 侧自建（端口在本包定义业务
// 结果形状，PG 实现由 business-store `./masterdata` 只读查 listing 表——
// 跨域只读消费先例 = standardreports r8 事实源直读 purchase_orders 行级）。
// 成本取价兜底联动（RREQ-MD-021 批量取价 / costing 消费侧）本批不做，登记。
// ---------------------------------------------------------------------------

/** 价格台账行（采购订单明细行的成交价读面；PRD 列面 = 源文档 §2.4 表格）。 */
export interface ItemPurchasePriceEntry {
  /** 采购单号（listing 订单 id 即单号，po-<uuidv7>）。 */
  readonly purchaseOrderId: string;
  /** 订单内行号（1 起）。 */
  readonly lineNo: number;
  readonly supplierRef: string | null;
  readonly supplierName: string | null;
  /** 含税单价（分，整数精确；null = 未定价——**仍展示行**，PRD 明示）。 */
  readonly unitPriceMinor: number | null;
  /** 采购数量（订单明细订购数量）。 */
  readonly quantity: number;
  /** 订单状态（draft/submitted/approved/issued/received，listing 五态词汇）。 */
  readonly orderState: string;
  /** 下单时间（订单创建时间，ISO 8601）。 */
  readonly orderedAt: string;
  /** 审核时间（订单状态机 to='approved' 迁移时刻，ISO 8601；null = 未审核）。 */
  readonly approvedAt: string | null;
}

/** 台账分页结果（total = 该物品全部明细行数，与页内条数无关）。 */
export interface ItemPurchasePricePage {
  readonly total: number;
  readonly entries: readonly ItemPurchasePriceEntry[];
}

/** 分页请求（页基 1；limit 1..100——用例层解析收口，端口收窄后的值）。 */
export interface ItemPurchasePriceQuery {
  readonly limit: number;
  readonly offset: number;
}

/**
 * 物品价格台账读面端口（只读，无写方法）。实现方保证：
 *  - 行集 = 该物品出现在任一采购订单明细行的**全部行**（含未审核订单——
 *    状态列供消费方自行区分；源 §3.11 仅排除"已删除"，我方无删除语义）；
 *  - 排序口径（源 §3.11 同构）：occurredAt = COALESCE(approvedAt, orderedAt)
 *    **降序**（审核时间优先、回落下单时间）→ purchaseOrderId 降序（源
 *    o.id DESC 决胜）→ lineNo 升序（源 l.id ASC 决胜）；
 *  - total 为全量行数（分页前）。
 */
export interface ItemPriceLedgerStore {
  listByItem(
    tenant: TenantId,
    itemId: string,
    query: ItemPurchasePriceQuery,
  ): Promise<ItemPurchasePricePage>;
}

/** 台账物化的订单输入行（DB 无关形状：内存实现喂行 / PG 实现查表转换共用）。 */
export interface PriceLedgerOrderRow {
  readonly id: string;
  readonly supplierRef: string | null;
  readonly supplierName: string | null;
  readonly state: string;
  /** ISO 8601（PG 侧 Date → toISOString 后传入）。 */
  readonly createdAt: string;
  /** 订单明细行集（listing lines JSON 原值——防御性解析，坏行静默跳过）。 */
  readonly lines: unknown;
}

/**
 * 台账物化共享纯函数（内存 / PG 两实现同一排序口径的单点实现）：
 * 展开订单 lines（{ lineNo, itemId, quantity, unitPriceMinor } 形状）过滤
 * itemId → 组装行 → 按 `ItemPriceLedgerStore` 端口合同的排序口径排序。
 * lines 非数组 / 行形状不符的条目跳过（只读投影，不 fail-fast——坏数据
 * 不阻塞台账面，对账归 listing 域）。
 */
export function buildItemPurchasePriceEntries(
  orders: readonly PriceLedgerOrderRow[],
  approvedAtByOrder: ReadonlyMap<string, string>,
  itemId: string,
): readonly ItemPurchasePriceEntry[] {
  const entries: ItemPurchasePriceEntry[] = [];
  for (const order of orders) {
    if (!Array.isArray(order.lines)) continue;
    for (const raw of order.lines) {
      if (typeof raw !== 'object' || raw === null) continue;
      const line = raw as Record<string, unknown>;
      if (line['itemId'] !== itemId) continue;
      const lineNo = line['lineNo'];
      const quantity = line['quantity'];
      if (typeof lineNo !== 'number' || !Number.isInteger(lineNo)) continue;
      if (typeof quantity !== 'number' || !Number.isFinite(quantity)) continue;
      const unitPriceRaw = line['unitPriceMinor'];
      const unitPriceMinor =
        typeof unitPriceRaw === 'number' && Number.isInteger(unitPriceRaw)
          ? unitPriceRaw
          : null; // 缺失/非整数分 → 未定价（仍展示行）
      entries.push({
        purchaseOrderId: order.id,
        lineNo,
        supplierRef: order.supplierRef,
        supplierName: order.supplierName,
        unitPriceMinor,
        quantity,
        orderState: order.state,
        orderedAt: order.createdAt,
        approvedAt: approvedAtByOrder.get(order.id) ?? null,
      });
    }
  }
  const occurredOf = (entry: ItemPurchasePriceEntry): string =>
    entry.approvedAt ?? entry.orderedAt; // COALESCE(approved, ordered)
  entries.sort((a, b) => {
    const byOccurred = occurredOf(b).localeCompare(occurredOf(a)); // 降序（近在前）
    if (byOccurred !== 0) return byOccurred;
    const byOrder = b.purchaseOrderId.localeCompare(a.purchaseOrderId); // 订单号降序
    if (byOrder !== 0) return byOrder;
    return a.lineNo - b.lineNo; // 行号升序
  });
  return entries;
}
