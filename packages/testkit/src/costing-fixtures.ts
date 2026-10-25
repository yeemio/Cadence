/**
 * costing 模块联动夹具（M2-W6）。
 *
 * 三类成本事实源端口（inventory 材料金额 / hours 工时量 / dispatch 外协价格）
 * 与归集主体校验的可注入假实现——供 costing 联动验证与对账测试使用（真实
 * 端口由兄弟模块合流时提供；hours 工时源在仓内已有 createHoursCostSource
 * 适配器，一般直接注入真实 HoursService）。
 *
 * 类型取舍同 hours-fixtures：本地结构化镜像类型，结构化兼容注入。
 */
import type { TenantId } from '@smes/business-core';

// ---- 本地结构化类型（镜像 costing-ports.ts 合同） ----

export interface FixtureMaterialCostLine {
  readonly movementId: string;
  readonly workOrderId: string;
  readonly itemId: string;
  readonly quantity: number;
  /** 金额（分，带符号：成本为正、冲减为负）。 */
  readonly amountMinor: number;
  readonly occurredAt: string;
}

export interface FixtureOutsourcingCostLine {
  readonly dispatchId: string;
  readonly lineNo: number;
  readonly workOrderId: string;
  readonly processCode: string;
  readonly supplierRef: string;
  readonly unitPriceMinor: number;
  readonly quantity: number;
  readonly amountMinor: number;
}

// ---- inventory 材料金额假端口 ----

/** 可编程材料金额夹具：seed 即生效；reprice 覆盖同 movementId 行（当前定价口径）。 */
export class FakeMaterialCostSource {
  readonly lines = new Map<string, FixtureMaterialCostLine[]>(); // workOrderId -> 行集

  seed(line: FixtureMaterialCostLine): void {
    const bucket = this.lines.get(line.workOrderId) ?? [];
    const existing = bucket.findIndex((row) => row.movementId === line.movementId);
    if (existing >= 0) bucket.splice(existing, 1);
    bucket.push(line);
    this.lines.set(line.workOrderId, bucket);
  }

  async materialLines(_tenant: TenantId, workOrderId: string): Promise<readonly FixtureMaterialCostLine[]> {
    return [...(this.lines.get(workOrderId) ?? [])].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }
}

// ---- dispatch 外协价格假端口 ----

/** 可编程外协价格夹具：同 (dispatchId, lineNo) 覆盖 = 重定价（OutsourcingPriced 补录口径）。 */
export class FakeOutsourcingCostSource {
  readonly lines = new Map<string, FixtureOutsourcingCostLine[]>(); // workOrderId -> 行集

  seed(line: FixtureOutsourcingCostLine): void {
    const bucket = this.lines.get(line.workOrderId) ?? [];
    const existing = bucket.findIndex((row) => row.dispatchId === line.dispatchId && row.lineNo === line.lineNo);
    if (existing >= 0) bucket.splice(existing, 1);
    bucket.push(line);
    this.lines.set(line.workOrderId, bucket);
  }

  async outsourcingLines(_tenant: TenantId, workOrderId: string): Promise<readonly FixtureOutsourcingCostLine[]> {
    return [...(this.lines.get(workOrderId) ?? [])];
  }
}

// ---- workorder 归集主体假端口 ----

/** 可编程主体校验夹具：known 集合内存在（默认空 = 全拒，测试自填）。 */
export class FakeWorkOrderSubject {
  readonly known = new Set<string>();

  know(workOrderId: string): void {
    this.known.add(workOrderId);
  }

  async exists(_tenant: TenantId, workOrderId: string): Promise<boolean> {
    return this.known.has(workOrderId);
  }
}
