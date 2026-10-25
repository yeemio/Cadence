/**
 * U7 项目成本六块取数源端口（A5，09-costing 之上的扩展面）。体例同 costing-ports：
 * 端口在本包定义业务形状 + 缺省空实现（零接线 = 对应块归集为空，不静默估算），
 * 组合根（apps/server cross-module-wiring）注入真实适配器；issue/listing/dispatch
 * 既有源码零改动（依赖铁律：模块间互调一律经 application 层端口，ADR-0011）。
 *
 * 三族新源 + 复用既有三源（labor/outsourcing/workOrder，见 CostingSourcePorts）：
 *  - issue 发料行段事实（②材料四类两段 + ⑥设备利库段的数量事实；金额解析分工
 *    见 project-cost-model 头注——part/equipment 利库段金额由 costing 录入价格表
 *    覆盖，端口行金额只作缺省对照）；
 *  - listing 外购设备采购行（⑥采购段；PO receivedQty×单价 = listing 既定金额
 *    汇总口径，适配器按 equipment 清单行匹配）；
 *  - dispatch 售后报销（⑤报销段；四费合计 + 工作令归属由适配器联查派工单——
 *    无工作令归属的报销不入项目成本，差异登记）。
 */
import type { TenantId } from '@smes/business-core';
import {
  ALWAYS_WORK_ORDER_SUBJECT,
  EMPTY_LABOR_COST_SOURCE,
  EMPTY_OUTSOURCING_COST_SOURCE,
  type LaborCostSourcePort,
  type OutsourcingCostSourcePort,
  type WorkOrderSubjectPort,
} from './costing-ports.js';

// ---- issue 端口：发料行段事实（两段拆分的数量来源） ----

/** 发料行段（一次发料明细行 × 一个段的量价事实）。 */
export interface ProjectIssueSegmentLine {
  /** 发料记录 id（未撤销记录——适配器只投影 active）。 */
  readonly recordId: string;
  /** 任务明细行 id（行身份锚点）。 */
  readonly taskLineId: string;
  readonly workOrderId: string;
  /** 行类别（镜像 issue 四类清单 kind）。 */
  readonly kind: 'part' | 'standard' | 'electrical' | 'equipment';
  /** 段：reserved=利库（预占核销）/ purchase=采购（可用扣减）/ raw=原材料（自制净发料）。 */
  readonly segment: 'reserved' | 'purchase' | 'raw';
  /** 来源清单行（同零件联动键；可空 = 无清单锚）。 */
  readonly sourceLineId: string | null;
  readonly itemId: string | null;
  readonly drawingNo: string | null;
  /** 段数量（part/equipment reserved = 预占核销；std/elec 两段 = 库位分配回执分列；raw = 自制净发料）。撤销记录的清零行 = 数量 0（该锚点当前净贡献 0——已发累计退出口径，costing 经 delta 对齐）。 */
  readonly quantity: number;
  /**
   * 段金额（分；适配器解析——std/elec 两段与非标采购段 × 本令 PO 加权含税单价、
   * raw 段 × 工序原材料关联行；null = 无价不计；清零行 = 0）。part/equipment
   * reserved 段金额由 costing 录入价格表覆盖（未录入按 0；清零行定向 0），本
   * 字段在该段仅为缺省对照。
   */
  readonly amountMinor: number | null;
  /** 工作令设备维（②按设备拆分 / ⑥设备归属；归拢为 null）。 */
  readonly equipmentRef: string | null;
  readonly issuedAt: string;
}

export interface ProjectIssueCostSourcePort {
  /** 该工作令发料行段集（按 issuedAt 升序、recordId/taskLineId/segment 稳定排序）。 */
  issueSegments(tenant: TenantId, workOrderId: string): Promise<readonly ProjectIssueSegmentLine[]>;
}

/** 缺省空发料源（零接线：材料/设备利库块为空）。 */
export const EMPTY_PROJECT_ISSUE_SOURCE: ProjectIssueCostSourcePort = {
  issueSegments: async () => [],
};

// ---- listing 端口：外购设备采购行（⑥采购段） ----

/** 外购设备采购行（⑥ cost_source=采购 的 Cadence 重述）。 */
export interface ProjectEquipmentPurchaseLine {
  readonly purchaseOrderId: string;
  readonly lineNo: number;
  readonly workOrderId: string;
  readonly itemId: string;
  readonly drawingNo: string | null;
  /** 申请采购数量。 */
  readonly quantity: number;
  /** 已收数量。 */
  readonly receivedQty: number;
  /** 单价（分；null = 未定价）。 */
  readonly unitPriceMinor: number | null;
  /**
   * 金额（分）：receivedQty × unitPriceMinor（listing 既定金额汇总口径——文档
   * 「申请子行 Σ amount，不以 quantity × unit_price 重算」的 Cadence 对应面，
   * 差异登记）；未收货或未定价 = 0（未收不计成本）。
   */
  readonly amountMinor: number;
  /** 匹配的设备清单行锚（equipment 清单行 id；未匹配 null）。 */
  readonly equipmentListingLineId: string | null;
  readonly equipmentRef: string | null;
}

export interface ProjectEquipmentPurchaseSourcePort {
  /** 该工作令外购设备采购行集（purchaseOrderId/lineNo 升序）。 */
  equipmentPurchases(tenant: TenantId, workOrderId: string): Promise<readonly ProjectEquipmentPurchaseLine[]>;
}

/** 缺省空设备采购源（零接线：⑥采购段为空）。 */
export const EMPTY_PROJECT_EQUIPMENT_PURCHASE_SOURCE: ProjectEquipmentPurchaseSourcePort = {
  equipmentPurchases: async () => [],
};

// ---- dispatch 端口：售后报销（⑤报销段） ----

/** 售后报销行（U5 aftercare-claim 的成本投影；工作令归属由适配器联查）。 */
export interface ProjectAftercareClaimLine {
  /** 报销单 id（幂等锚点）。 */
  readonly claimId: string;
  readonly dispatchId: string;
  readonly workOrderId: string;
  /** 四费合计（食宿+交通+加班+其他；aftercareClaimTotalMinor 口径）。 */
  readonly reimburseMinor: number;
  readonly filedAt: string;
}

export interface ProjectAftercareClaimSourcePort {
  /** 该工作令售后报销行集（filedAt 升序）。 */
  aftercareClaims(tenant: TenantId, workOrderId: string): Promise<readonly ProjectAftercareClaimLine[]>;
}

/** 缺省空售后报销源（零接线：⑤报销段为空）。 */
export const EMPTY_PROJECT_AFTERCARE_CLAIM_SOURCE: ProjectAftercareClaimSourcePort = {
  aftercareClaims: async () => [],
};

// ---- 录入价格写回端口（单向通知式合同） ----

/** 写回载荷：一条发料明细行的录入价格（costing 价格表落账后的 issue 侧镜像）。 */
export interface IssuePriceWritebackEntry {
  readonly workOrderId: string;
  readonly recordId: string;
  readonly taskLineId: string;
  /** 行类别（part=非标利库 / equipment=外购设备利库——文档两个录入 Tab）。 */
  readonly kind: 'part' | 'equipment';
  readonly sourceLineId: string | null;
  /** 成本单价（分；null = 未录入）。 */
  readonly unitPriceMinor: number | null;
  /** 总金额（分；未手改 = 预占数量 × 单价）。 */
  readonly totalMinor: number | null;
}

/**
 * 录入价格写回端口（文档 §2.1.5/三-7/8「直读写发料明细」的单向 Cadence 重述）：
 * costing 价格表落账后单向通知 issue 侧；issue 侧是否镜像进发料明细由接线方
 * 决定（本波 issue 源码冻结——缺省 NOOP 不写发料明细，价格表即成本口径唯一
 * 事实；写回失败不回滚 costing 落账，通知式合同体例同 IssueSyncTrigger）。
 */
export interface IssuePriceWritebackPort {
  writeback(tenant: TenantId, entries: readonly IssuePriceWritebackEntry[]): Promise<void>;
}

/** 缺省 NOOP 写回（零接线：价格只落 costing 表，不写发料明细）。 */
export const NOOP_ISSUE_PRICE_WRITEBACK: IssuePriceWritebackPort = {
  writeback: async () => {},
};

// ---- 端口全集（ProjectCostService 构造入参形状） ----

export interface ProjectCostSourcePorts {
  /** issue 发料行段（②材料 + ⑥利库段）。 */
  readonly issueSegments: ProjectIssueCostSourcePort;
  /** listing 外购设备采购行（⑥采购段）。 */
  readonly equipmentPurchases: ProjectEquipmentPurchaseSourcePort;
  /** dispatch 售后报销（⑤报销段）。 */
  readonly aftercareClaims: ProjectAftercareClaimSourcePort;
  /** hours 工时量（④/⑤ 工时段；复用既有口径端口）。 */
  readonly labor: LaborCostSourcePort;
  /** dispatch 外协价格（③；复用既有口径端口）。 */
  readonly outsourcing: OutsourcingCostSourcePort;
  /** workorder 归集主体校验（复用既有口径端口）。 */
  readonly workOrder: WorkOrderSubjectPort;
  /** 录入价格写回（缺省 NOOP）。 */
  readonly priceWriteback: IssuePriceWritebackPort;
}

/** 全缺省端口集（零接线 boot）。 */
export function emptyProjectCostSourcePorts(): ProjectCostSourcePorts {
  return {
    issueSegments: EMPTY_PROJECT_ISSUE_SOURCE,
    equipmentPurchases: EMPTY_PROJECT_EQUIPMENT_PURCHASE_SOURCE,
    aftercareClaims: EMPTY_PROJECT_AFTERCARE_CLAIM_SOURCE,
    labor: EMPTY_LABOR_COST_SOURCE,
    outsourcing: EMPTY_OUTSOURCING_COST_SOURCE,
    workOrder: ALWAYS_WORK_ORDER_SUBJECT,
    priceWriteback: NOOP_ISSUE_PRICE_WRITEBACK,
  };
}
