/**
 * inspection 模块联动夹具（M2-W4）。
 *
 * 跨模块端口（放行事实 → inventory、IM 点名 → integration-im）与来源事实
 * 构造器的可注入假实现——供 inspection 联动验证与后续兄弟模块（inventory
 * 合流时消费 released 放行事实；reporting/dispatch/listing 合流时投递来源
 * 事实）对账测试使用。
 *
 * 类型取舍（同 workorder-fixtures）：本文件自带与
 * application/src/inspection/inspection-ports.ts 合同同形的**本地结构化类型**
 * （testkit rootDir 不含 application 源）。结构化兼容——假实现可直接注入
 * InspectionModule 的对应端口参数位。
 */
import type { TenantId } from '@smes/business-core';

// ---- 本地结构化类型（镜像 inspection-ports.ts 合同；字段口径以该文件为准） ----

export type FixtureInspectionKind =
  | 'self_outsourced'
  | 'nonstandard_purchase'
  | 'standard_purchase'
  | 'equipment_purchase';

export type FixtureInspectionSourceType = 'report' | 'dispatch' | 'receipt';

/** 来源事实（reporting 末道报工 / dispatch 外协回厂 / listing 收货 → 待检单）。 */
export interface FixtureInspectionSourceFact {
  readonly sourceType: FixtureInspectionSourceType;
  readonly sourceRefId: string;
  readonly kind?: FixtureInspectionKind;
  readonly itemId: string | null;
  readonly drawingNo: string | null;
  readonly quantity: number;
  readonly workOrderId: string | null;
  readonly occurredAt: string;
  readonly triggeredBy: string;
}

/** 放行事实（passed 后 inventory 才可入库的许可锚点）。 */
export interface FixtureStockReleaseFact {
  readonly inspectionId: string;
  readonly kind: FixtureInspectionKind;
  readonly itemId: string | null;
  readonly drawingNo: string | null;
  readonly quantity: number;
  readonly sourceType: FixtureInspectionSourceType | null;
  readonly sourceRefId: string | null;
  readonly releasedAt: string;
}

/** IM 点名消息（业务侧最小通知形状）。 */
export interface FixtureNotifyMessage {
  readonly title: string;
  readonly body: string;
  readonly refType?: string;
  readonly refId?: string;
}

// ---- 可编程假端口 ----

/**
 * 可编程放行事实端口夹具：记录全部放行事实（inventory 合流前的联动验证——
 * 验证"passed 才放行、放行数量 = 合格数量"）。
 */
export class FakeStockReleasePort {
  readonly facts: FixtureStockReleaseFact[] = [];

  async recordRelease(_tenant: TenantId, fact: FixtureStockReleaseFact): Promise<void> {
    this.facts.push(fact);
  }

  releasedCount(): number {
    return this.facts.length;
  }

  totalReleasedQty(): number {
    return this.facts.reduce((sum, fact) => sum + fact.quantity, 0);
  }
}

/** 可编程 IM 点名夹具：记录全部通知（闭环超时点名联动验证）。 */
export class FakeNotifyChannel {
  readonly messages: FixtureNotifyMessage[] = [];

  async notify(_tenant: TenantId, message: FixtureNotifyMessage): Promise<void> {
    this.messages.push(message);
  }
}

// ---- 来源事实构造器（三来源便捷注入） ----

/** 末道报工完成事实（reporting → 自制外协质检）。 */
export function finalReportFact(
  sourceRefId: string,
  overrides: Partial<FixtureInspectionSourceFact> = {},
): FixtureInspectionSourceFact {
  return {
    sourceType: 'report',
    sourceRefId,
    itemId: 'item-1',
    drawingNo: null,
    quantity: 10,
    workOrderId: null,
    occurredAt: new Date().toISOString(),
    triggeredBy: 'system-reporting',
    ...overrides,
  };
}

/** 外协回厂事实（dispatch → 自制外协质检）。 */
export function outsourcingReturnFact(
  sourceRefId: string,
  overrides: Partial<FixtureInspectionSourceFact> = {},
): FixtureInspectionSourceFact {
  return finalReportFact(sourceRefId, {
    sourceType: 'dispatch',
    triggeredBy: 'system-dispatch',
    ...overrides,
  });
}

/** 收货事实（listing → 三类采购质检；kind 必填）。 */
export function goodsReceiptFact(
  sourceRefId: string,
  kind: Extract<FixtureInspectionKind, 'nonstandard_purchase' | 'standard_purchase' | 'equipment_purchase'>,
  overrides: Partial<FixtureInspectionSourceFact> = {},
): FixtureInspectionSourceFact {
  return finalReportFact(sourceRefId, {
    sourceType: 'receipt',
    kind,
    triggeredBy: 'system-listing',
    ...overrides,
  });
}
