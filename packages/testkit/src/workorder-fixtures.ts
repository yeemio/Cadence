/**
 * workorder 模块联动夹具（M2-W1）。
 *
 * 跨模块端口（listing 清单需求行 / inventory 可用量与出库 / reporting-dispatch
 * 进度事实 / masterdata 客户目录）的可注入假实现——供 workorder 联动验证与
 * 后续兄弟模块对账测试使用（真实端口由 listing/inventory/reporting 合流时
 * 提供）。
 *
 * 类型取舍：本文件自带与 application/src/workorder/workorder-ports.ts 合同
 * 同形的**本地结构化类型**（testkit rootDir 不含 application 源；tsconfig 为
 * 并行线共享文件不可动）。结构化兼容——假实现可直接注入 WorkOrderModule 的
 * 对应端口参数位；application 后续经包入口导出端口类型时可无缝切换。
 */
import type { TenantId } from '@smes/business-core';

// ---- 本地结构化类型（镜像 workorder-ports.ts 合同；字段口径以该文件为准） ----

export type FixtureListingKind = 'part' | 'standard' | 'electrical' | 'equipment';

export interface FixtureListingRequirementLine {
  readonly kind: FixtureListingKind;
  readonly itemId: string;
  readonly drawingNo: string | null;
  readonly requiredQty: number;
  readonly neededBy: string | null;
}

export interface FixturePartsIssueCommand {
  readonly requestId: string;
  readonly workOrderId: string;
  readonly itemId: string;
  readonly quantity: number;
}

export interface FixturePartsIssueReceipt {
  readonly issued: boolean;
  readonly refusedReason?: string;
}

export interface FixtureProgressFact {
  readonly stage: 'machining' | 'assembly';
  readonly drawingNo: string | null;
  readonly operationId: string;
  readonly doneQty: number;
  readonly totalQty: number;
  readonly status: 'pending' | 'in_progress' | 'done';
}

// ---- 可编程假端口 ----

/** 可编程清单需求行夹具：push/seed 进 lines 即生效。 */
export class FakeListingRequirementPort {
  readonly lines: FixtureListingRequirementLine[] = [];

  async requirementLines(_tenant: TenantId, _workOrderId: string): Promise<readonly FixtureListingRequirementLine[]> {
    return [...this.lines];
  }

  /** 便捷注入：一行零件类需求。 */
  seedPartLine(itemId: string, requiredQty: number, drawingNo: string | null = null): this {
    return this.seedLine('part', itemId, requiredQty, drawingNo);
  }

  /** 便捷注入：一行指定类目需求。 */
  seedLine(
    kind: FixtureListingKind,
    itemId: string,
    requiredQty: number,
    drawingNo: string | null = null,
  ): this {
    this.lines.push({ kind, itemId, drawingNo, requiredQty, neededBy: null });
    return this;
  }
}

/** 可编程库存可用量夹具：set 即生效，缺项按 0。 */
export class FakeInventoryAvailabilityPort {
  readonly stock = new Map<string, number>();

  async availableQty(
    _tenant: TenantId,
    itemIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    return new Map(itemIds.map((id) => [id, this.stock.get(id) ?? 0]));
  }
}

/**
 * 可编程出库端口夹具：默认放行；设 refuseReason 拒绝。
 * calls 记录全部指令（含被拒）——验证"拒绝不落账、放行才迁移"与 requestId 传参。
 */
export class FakePartsIssuePort {
  readonly calls: FixturePartsIssueCommand[] = [];
  refuseReason: string | null = null;

  async issueParts(_tenant: TenantId, command: FixturePartsIssueCommand): Promise<FixturePartsIssueReceipt> {
    this.calls.push(command);
    return this.refuseReason === null ? { issued: true } : { issued: false, refusedReason: this.refuseReason };
  }

  issuedCount(): number {
    return this.calls.length;
  }
}

/** 可编程进度事实夹具：push/seed 进 facts 即生效（机加工/装配调试两类视图数据源）。 */
export class FakeProgressFactPort {
  readonly facts: FixtureProgressFact[] = [];

  async progressFacts(_tenant: TenantId, _workOrderId: string): Promise<readonly FixtureProgressFact[]> {
    return [...this.facts];
  }

  seedMachining(drawingNo: string, operationId: string, doneQty: number, totalQty: number): this {
    this.facts.push({
      stage: 'machining',
      drawingNo,
      operationId,
      doneQty,
      totalQty,
      status: totalQty > 0 && doneQty >= totalQty ? 'done' : doneQty > 0 ? 'in_progress' : 'pending',
    });
    return this;
  }

  seedAssembly(operationId: string, doneQty: number, totalQty: number): this {
    this.facts.push({
      stage: 'assembly',
      drawingNo: null,
      operationId,
      doneQty,
      totalQty,
      status: totalQty > 0 && doneQty >= totalQty ? 'done' : doneQty > 0 ? 'in_progress' : 'pending',
    });
    return this;
  }
}

/** 静态客户目录夹具：Map 查找，未知引用 null。 */
export class FakeCustomerDirectoryPort {
  constructor(readonly entries: ReadonlyMap<string, string> = new Map()) {}

  async findCustomer(
    _tenant: TenantId,
    customerRef: string,
  ): Promise<{ readonly id: string; readonly name: string } | null> {
    const name = this.entries.get(customerRef);
    return name === undefined ? null : { id: customerRef, name };
  }
}
