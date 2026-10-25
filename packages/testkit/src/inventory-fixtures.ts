/**
 * inventory 模块联动夹具（M2-W5）。
 *
 * 两个用途（体例同 workorder/listing/inspection-fixtures——类型取舍：本文件
 * 自带与 application/src/inventory 端口合同同形的**本地结构化类型**，testkit
 * rootDir 不含 application 源；结构化兼容，假实现可直接注入兄弟模块端口位）：
 *  1. 兄弟模块联动验证：FakeShippingConfirmedConsumer——workorder 消费
 *     ShippingConfirmed 事件（待发货→已发货联动）的假订阅器（seed 进事件
 *     即生效；acknowledge 记账去重）；
 *  2. inventory 线自测辅助：放行事实种子（seedReleaseFact 直接落内存
 *     ReleaseFactStore——inspection 未接线时的放行咬合测试捷径）。
 */
import type { TenantId } from '@smes/business-core';

// ---- 本地结构化类型（镜像 inventory-events.ts 合同） ----

/** 发货行镜像（ShippingConfirmed 载荷行）。 */
export interface FixtureShippingLine {
  readonly itemId: string;
  readonly quantity: number;
  readonly warehouseId: string;
  readonly locationId: string | null;
  readonly reservationKey: string | null;
}

/** ShippingConfirmed 事件消息镜像（eventId + 时刻 + 载荷——消费面最小形状）。 */
export interface FixtureShippingConfirmedMessage {
  readonly eventId: string;
  readonly tenantId: string;
  readonly occurredAt: string;
  readonly payload: {
    readonly shippingOrderId: string;
    readonly workOrderId: string | null;
    readonly lines: readonly FixtureShippingLine[];
    readonly carrier: string | null;
    readonly trackingNo: string | null;
    readonly actor: string;
  };
}

// ---- workorder ShippingConfirmed 订阅假端口 ----

/**
 * 可编程发货确认订阅夹具：seed 进消息即生效；acknowledge 记账去重。
 * 形状与 listing-ports 的 WorkOrderCreatedFeedPort 同构（镜像订阅端口体例，
 * workorder 合流时按此形状定义消费端口）。
 */
export class FakeShippingConfirmedFeed {
  readonly messages: FixtureShippingConfirmedMessage[] = [];
  readonly acknowledged: string[] = [];

  seed(
    tenant: string,
    shippingOrderId: string,
    workOrderId: string | null,
    lines: readonly FixtureShippingLine[] = [{ itemId: 'item-fx', quantity: 1, warehouseId: 'wh-fx', locationId: null, reservationKey: null }],
  ): string {
    const eventId = `evt-ship-fixture-${this.messages.length + 1}`;
    this.messages.push({
      eventId,
      tenantId: tenant,
      occurredAt: new Date().toISOString(),
      payload: {
        shippingOrderId,
        workOrderId,
        lines,
        carrier: null,
        trackingNo: null,
        actor: 'u-fixture',
      },
    });
    return eventId;
  }

  async pendingConfirmedEvents(tenant: TenantId): Promise<readonly FixtureShippingConfirmedMessage[]> {
    return this.messages.filter(
      (message) => message.tenantId === tenant && !this.acknowledged.includes(message.eventId),
    );
  }

  async acknowledge(eventId: string): Promise<void> {
    if (!this.acknowledged.includes(eventId)) this.acknowledged.push(eventId);
  }
}

// ---- 放行事实种子（inventory 线放行咬合测试捷径） ----

/**
 * 放行事实种子形状：与 inspection-fixtures 的 FixtureStockReleaseFact 同形
 * （kind/sourceType 在本文件放宽为 string——seed 面不重复导出类型，避免与
 * inspection-fixtures 同名冲突；两形状结构化互通）。
 */
export interface InventoryReleaseFactSeed {
  readonly inspectionId: string;
  readonly kind: string;
  readonly itemId: string | null;
  readonly drawingNo: string | null;
  readonly quantity: number;
  readonly sourceType: string | null;
  readonly sourceRefId: string | null;
  readonly releasedAt: string;
}

/** 推荐的放行事实幂等键串（inventory 侧 phase 口径：direct@<releasedAt>）。 */
export function releasePhaseOf(fact: InventoryReleaseFactSeed): string {
  return `direct@${fact.releasedAt}`;
}

/**
 * 放行事实种子：直接落内存 ReleaseFactStore（绕过 StockReleasePort——
 * inspection 未接线时的 receive(kind=inspection) 咬合测试捷径）。返回落账 id。
 */
export async function seedReleaseFact(
  store: {
    append(input: {
      readonly tenant: TenantId;
      readonly id: string;
      readonly inspectionId: string;
      readonly phase: string;
      readonly kind: string;
      readonly itemId: string | null;
      readonly drawingNo: string | null;
      readonly quantity: number;
      readonly sourceType: string | null;
      readonly sourceRefId: string | null;
      readonly releasedAt: string;
    }): Promise<unknown>;
  },
  tenant: TenantId,
  fact: InventoryReleaseFactSeed,
): Promise<string> {
  const id = `rel-fixture-${Math.random().toString(36).slice(2, 10)}`;
  await store.append({
    tenant,
    id,
    inspectionId: fact.inspectionId,
    phase: releasePhaseOf(fact),
    kind: fact.kind,
    itemId: fact.itemId,
    drawingNo: fact.drawingNo,
    quantity: fact.quantity,
    sourceType: fact.sourceType,
    sourceRefId: fact.sourceRefId,
    releasedAt: fact.releasedAt,
  });
  return id;
}

// ---- 库存种子快捷输入（命令面载荷构造——常用中文别名的极简面） ----

/** 构造 warehouse.define 载荷（两库位：RAW/FG）。 */
export function warehouseDefineFixture(code: string, name?: string): {
  readonly code: string;
  readonly name: string;
  readonly locations: readonly { readonly code: string; readonly name: string | null }[];
} {
  return {
    code,
    name: name ?? `仓库-${code}`,
    locations: [
      { code: 'RAW', name: '原料区' },
      { code: 'FG', name: '成品区' },
    ],
  };
}
