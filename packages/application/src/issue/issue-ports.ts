/**
 * issue 跨模块端口（U1）。依赖倒置取舍（合同 U1：库存/预占联动经
 * IssueMaterialPort 端口注入，dispatch→issue 自动生成钩子不做、端口留好）：
 *  - IssueDemandSourcePort：任务生成/四数量读取的**清单需求行源**（listing 侧
 *    合流时实现——行含设备维、类别、origin 双源与 equipment 利用库存字段；
 *    Cadence 现 listing 行无设备维/双源标记，端口按本模块口径定义，缺省空实现）；
 *  - IssueMaterialPort：确认发料的**库存/预占联动**与四数量的供给侧输入
 *    （inventory 侧合流时实现：库位扣减 + 预占核销/回滚 + 可用量/预占查询；
 *    本波零接线 boot 用 NOOP 缺省——语义完整、数据为空）；
 *  - IssueSyncPort：dispatch 派工成功 → 发料任务生成/补全的**发布面**（本模块
 *    IssueService 即实现；dispatch 侧合流时注入单行钩子调用）。
 *
 * 端口方法一律异步；全部按租户收口（ADR-0011 / 通用合同纪律 6：模块间互调
 * 一律经 application 层端口）。
 */
import type { TenantId } from '@smes/business-core';
import type { IssueDispatchKind, IssueLineKind } from './issue-config.js';
import type { IssueTask } from './issue-stores.js';

// ---- 清单需求行源（sync 生成 + equipment 四数量读取） ----

/**
 * 清单需求行（生成发料任务子行的源数据；词汇镜像 listing ListingLine +
 * 设备维/双源 origin 扩展）。equipment 行额外携带利用库存/采购入库完成量
 * （已预占口径 = 两者之和——文档 2.3.2 外购设备 Tab）。
 */
export interface IssueDemandLine {
  /** 来源清单行 id（listing 行 opaque id）。 */
  readonly listingLineId: string;
  /** 设备维（opaque；equipment 清单行自身为 null）。 */
  readonly equipmentRef: string | null;
  readonly kind: IssueLineKind;
  readonly moduleName: string | null;
  readonly name: string | null;
  readonly drawingNo: string | null;
  /** 确认物料 id（可空——未解析物料的非标行）。 */
  readonly itemId: string | null;
  readonly requiredQty: number;
  /** 双源：production=生产（本模块消费）/ aftermarket=配件申请入清单（生产发料排除）。 */
  readonly origin: 'production' | 'aftermarket';
  /** equipment 行：利用库存数量。 */
  readonly useInventoryQty: number;
  /** equipment 行：采购入库完成数量。 */
  readonly inboundCompletedQty: number;
}

/** 清单需求行源端口：按工作令读全量需求行（四类清单合一；含 equipment 行）。 */
export interface IssueDemandSourcePort {
  demandLines(tenant: TenantId, workOrderId: string): Promise<readonly IssueDemandLine[]>;
}

/** 缺省空实现（零接线 boot：无 listing 接线时同步不生成任何行）。 */
export const EMPTY_ISSUE_DEMAND_PORT: IssueDemandSourcePort = {
  demandLines: async () => [],
};

// ---- 库存/预占联动（依赖倒置；inventory 侧合流时实现） ----

/** 库位出库指令行。 */
export interface IssueStockAllocationCommand {
  readonly locationId: string;
  readonly quantity: number;
}

/** 单库位扣减回执（撤销原路回滚的快照依据）。 */
export interface IssueStockAllocationReceipt {
  readonly locationId: string;
  readonly quantity: number;
  readonly reservedConsumedQty: number;
  readonly availableConsumedQty: number;
}

/** 出库指令（幂等键 = issueKey：实现方须按 issueKey 去重，重试不重复扣减）。 */
export interface IssueStockCommand {
  readonly equipmentRef?: string | null;
  readonly issueKey: string;
  readonly workOrderId: string;
  readonly itemId: string;
  readonly allocations: readonly IssueStockAllocationCommand[];
}

/** 出库回执：issued=false 携拒绝原因（库位结存不足/可用量不足等）。 */
export interface IssueStockReceipt {
  readonly issued: boolean;
  readonly refusedReason?: string;
  /** 幂等命中回首次结果。 */
  readonly duplicate?: boolean;
  readonly allocations?: readonly IssueStockAllocationReceipt[];
}

/**
 * 库存/预占联动端口（合同命名 IssueMaterialPort）：
 *  - availableQtyOf：料品可用库存（跨仓 Σ max(0, 总量−预占)——四数量输入）；
 *  - reservedQtyOf：按锚点（工作令 + 设备 + 物料）汇总预占数量（四数量输入；
 *    锚定维度与 legacy 预占明细一致，equipmentRef 空值收敛）；
 *  - issueStock：确认发料（standard/electrical）库位扣减 + 预占核销——回执携带
 *    各库位预占/可用拆分（YZ/KY 口径），撤销按回执快照原路回滚；
 *  - rollbackIssue：整单原路回滚（按 issueKey 幂等；库位结存回补 + 预占恢复）。
 */
export interface IssueMaterialPort {
  availableQtyOf(tenant: TenantId, itemIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
  reservedQtyOf(
    tenant: TenantId,
    query: {
      readonly workOrderId: string;
      readonly equipmentRef: string | null;
      readonly itemIds: readonly string[];
    },
  ): Promise<ReadonlyMap<string, number>>;
  issueStock(tenant: TenantId, command: IssueStockCommand): Promise<IssueStockReceipt>;
  rollbackIssue(tenant: TenantId, command: { readonly issueKey: string }): Promise<{ readonly rolled: boolean; readonly refusedReason?: string }>;
}

/**
 * 缺省 NOOP 实现（零接线 boot）：恒放行、扣减全走可用量（预占核销 0）。
 * 语义完整、数据为空——真实库存联动由 inventory 侧合流注入替换；测试用
 * 可控 fake 注入（见 tests/issue）。
 */
export const NOOP_ISSUE_MATERIAL_PORT: IssueMaterialPort = {
  availableQtyOf: async (_tenant, itemIds) => new Map(itemIds.map((itemId) => [itemId, 0])),
  reservedQtyOf: async (_tenant, query) => new Map(query.itemIds.map((itemId) => [itemId, 0])),
  issueStock: async (_tenant, command) => ({
    issued: true,
    allocations: command.allocations.map((allocation) => ({
      locationId: allocation.locationId,
      quantity: allocation.quantity,
      reservedConsumedQty: 0,
      availableConsumedQty: allocation.quantity,
    })),
  }),
  rollbackIssue: async () => ({ rolled: true }),
};

// ---- 派工触发生成面（dispatch 侧合流时的单行钩子） ----

/** 派工触发（装配/电气派工"派工"成功后的生成/补全指令）。 */
export interface IssueSyncTrigger {
  readonly workOrderId: string;
  readonly dispatchKind: IssueDispatchKind;
  /** 本次触发命中的自制设备集合（调用方解析：勾选设备则仅该设备，未选则全令自制）。 */
  readonly equipmentRefs?: readonly string[] | undefined;
  /** 整线装配外购归拢（装配派工触发；全令外购设备各一行）。 */
  readonly rollup?: boolean | undefined;
  readonly workOrderLabel?: string | null | undefined;
  readonly plannedStartAt?: string | null | undefined;
  readonly plannedEndAt?: string | null | undefined;
  readonly operators?: readonly string[] | undefined;
  /** 触发派工单锚点（关联展示）。 */
  readonly triggerRef?: { readonly type: string; readonly id: string } | null | undefined;
}

/** 生成/补全回执（幂等：重触发只补缺失子行，不重复建主表）。 */
export interface IssueSyncReceipt {
  /** 命中/新建的任务集。 */
  readonly tasks: readonly IssueTask[];
  /** 各任务本次补全新行数（taskId → appended count）。 */
  readonly appendedCountByTask: ReadonlyMap<string, number>;
}

/**
 * 派工触发生成面：dispatch 模块在"派工成功"事件点调 syncFromDispatch（本模块
 * IssueService 实现本接口）。撤销派工清理面对应 issue.cleanup.v1 命令（同由
 * dispatch 撤销事件点调用——接线归合流）。
 */
export interface IssueSyncPort {
  syncFromDispatch(tenant: TenantId, trigger: IssueSyncTrigger): Promise<IssueSyncReceipt>;
}
