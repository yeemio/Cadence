/**
 * costing 跨模块端口（M2-W6，09-costing.md v1.0 §4 依赖 M2）。
 *
 * 只定义接口与缺省实现（模块间互调一律经 application 层端口，ADR-0011）。
 * 三类成本事实源 + 归集主体校验端口：
 *  - 材料金额：inventory 出入库流水**不含金额**（StockMovement 无金额列——
 *    07-inventory.md 口径），金额经端口取（含采购入库金额口径由实现方声明）；
 *    缺省空实现 = 零接线（材料类归集为空，不静默估算）；
 *  - 工时量：hours 劳动条目（带符号净额——commit 正 / reverse 负）；缺省空。
 *    本文件提供 createHoursCostSource 适配器（结构化面——组合根把 HoursService
 *    实例直接注入即接通，与 listing-ports 的 MaterialValidationExecutor 取舍同）；
 *  - 外协价格：dispatch OutsourcingPriced 口径（金额 = unitPriceMinor ×
 *    quantity）；缺省空；
 *  - 归集主体：workorder 工作令存在性校验；缺省恒真（零接线不阻塞重算）。
 */
import type { TenantId } from '@smes/business-core';

// ---- inventory 端口：材料金额（出入库流水的金额口径） ----

/** 材料成本行（一次出入库流水的金额事实；workOrderId 已按流水携带）。 */
export interface MaterialCostLine {
  /** inventory 流水 id（来源单据引用 + sourceKey 锚点）。 */
  readonly movementId: string;
  readonly workOrderId: string;
  readonly itemId: string;
  /** 数量（恒正；方向语义由实现方金额符号承载——出库为正成本、退库冲减为负）。 */
  readonly quantity: number;
  /** 金额（分，带符号：成本为正、冲减为负）。 */
  readonly amountMinor: number;
  readonly occurredAt: string;
}

export interface MaterialCostSourcePort {
  /** 该工作令的材料成本行（按 occurredAt 升序）。 */
  materialLines(tenant: TenantId, workOrderId: string): Promise<readonly MaterialCostLine[]>;
}

/** 缺省空材料源（零接线：材料类归集为空——不静默估算，接入后即实）。 */
export const EMPTY_MATERIAL_COST_SOURCE: MaterialCostSourcePort = {
  materialLines: async () => [],
};

// ---- hours 端口：工时量（劳动条目净额投影） ----

/** 工时成本行（一条劳动条目的带符号投影；金额化在口径层，行不带金额）。 */
export interface LaborCostLine {
  /** hours 劳动条目 id（来源单据引用 + sourceKey 锚点）。 */
  readonly laborEntryId: string;
  readonly workOrderId: string;
  readonly workerId: string;
  /** 工种（时薪表键）。 */
  readonly trade: string;
  /** 带符号工时（commit 正 / reverse 负）。 */
  readonly hours: number;
  readonly workDate: string;
}

export interface LaborCostSourcePort {
  /** 该工作令的工时成本行（按条目插入序）。 */
  laborLines(tenant: TenantId, workOrderId: string): Promise<readonly LaborCostLine[]>;
}

/** 缺省空工时源（零接线）。 */
export const EMPTY_LABOR_COST_SOURCE: LaborCostSourcePort = {
  laborLines: async () => [],
};

/** hours 侧供消费的结构化面（HoursService.costingLines 的形状；结构化兼容注入）。 */
export interface HoursCostSourceSurface {
  costingLines(tenant: TenantId, workOrderId: string): Promise<readonly LaborCostLine[]>;
}

/** hours → costing 工时源适配器（组合根注入 HoursService 即接通，结构化兼容）。 */
export function createHoursCostSource(service: HoursCostSourceSurface): LaborCostSourcePort {
  return { laborLines: (tenant, workOrderId) => service.costingLines(tenant, workOrderId) };
}

// ---- dispatch 端口：外协价格（OutsourcingPriced 口径） ----

/**
 * 外协成本行（ OutsourcingPriced 事件口径的镜像：金额 = unitPriceMinor ×
 * quantity；dispatch 外协行与派工单联查后的当前定价投影）。
 */
export interface OutsourcingCostLine {
  /** 来源锚点：`${dispatchId}#${lineNo}`。 */
  readonly dispatchId: string;
  readonly lineNo: number;
  readonly workOrderId: string;
  readonly processCode: string;
  readonly supplierRef: string;
  readonly unitPriceMinor: number;
  readonly quantity: number;
  /** 金额（分 = unitPriceMinor × quantity）。 */
  readonly amountMinor: number;
}

export interface OutsourcingCostSourcePort {
  /** 该工作令的外协成本行（未定价行不返回——无金额不可归集）。 */
  outsourcingLines(tenant: TenantId, workOrderId: string): Promise<readonly OutsourcingCostLine[]>;
}

/** 缺省空外协源（零接线）。 */
export const EMPTY_OUTSOURCING_COST_SOURCE: OutsourcingCostSourcePort = {
  outsourcingLines: async () => [],
};

/** 外协行 sourceKey 锚点（dispatchId#lineNo）。 */
export function outsourcingSourceRef(dispatchId: string, lineNo: number): string {
  return `${dispatchId}#${lineNo}`;
}

// ---- workorder 端口：归集主体校验 ----

export interface WorkOrderSubjectPort {
  /** 工作令是否存在（false → costing.rebuild 拒绝：归集主体必须有效）。 */
  exists(tenant: TenantId, workOrderId: string): Promise<boolean>;
}

/** 缺省主体校验：恒真（零接线不阻塞重算；workorder 接线后替换为真实校验）。 */
export const ALWAYS_WORK_ORDER_SUBJECT: WorkOrderSubjectPort = {
  exists: async () => true,
};

// ---- 端口全集（CostingService 构造入参形状） ----

export interface CostingSourcePorts {
  readonly material: MaterialCostSourcePort;
  readonly labor: LaborCostSourcePort;
  readonly outsourcing: OutsourcingCostSourcePort;
  readonly workOrder: WorkOrderSubjectPort;
}

/** 全缺省端口集（零接线 boot）。 */
export function emptyCostingSourcePorts(): CostingSourcePorts {
  return {
    material: EMPTY_MATERIAL_COST_SOURCE,
    labor: EMPTY_LABOR_COST_SOURCE,
    outsourcing: EMPTY_OUTSOURCING_COST_SOURCE,
    workOrder: ALWAYS_WORK_ORDER_SUBJECT,
  };
}
