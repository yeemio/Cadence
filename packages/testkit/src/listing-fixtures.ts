/**
 * listing 模块联动夹具（M2-W3）。
 *
 * 跨模块端口（workorder WorkOrderCreated 订阅 / inventory 可用量与入库指令 /
 * baseline 物料校验执行 / Excel 结构化表源）的可注入假实现——供 listing 联动
 * 验证与对账测试使用（真实端口由兄弟模块合流时提供）。
 *
 * 类型取舍：本文件自带与 application/src/listing 各端口合同同形的**本地结构化
 * 类型**（testkit rootDir 不含 application 源；tsconfig 为并行线共享文件不可动）。
 * 结构化兼容——假实现可直接注入 ListingModule 的对应端口参数位。
 */
import type { TenantId } from '@smes/business-core';

// ---- 本地结构化类型（镜像 listing-ports.ts / excel-port.ts 合同） ----

export type FixtureListingKind = 'part' | 'standard' | 'electrical' | 'equipment';

export interface FixtureWorkOrderCreatedMessage {
  readonly eventId: string;
  readonly tenantId: string;
  readonly occurredAt: string;
  readonly payload: {
    readonly workOrderId: string;
    readonly projectName: string;
    readonly listingKinds: readonly FixtureListingKind[];
    readonly actor: string;
  };
}

export interface FixtureInventoryReceiptCommand {
  readonly receiptKey: string;
  readonly purchaseOrderId: string;
  readonly itemId: string;
  readonly quantity: number;
}

export interface FixtureExcelSheet {
  readonly name: string;
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

// ---- workorder WorkOrderCreated 订阅假端口 ----

/** 可编程订阅夹具：seed 进消息即生效；acknowledge 记账去重。 */
export class FakeWorkOrderCreatedFeed {
  readonly messages: FixtureWorkOrderCreatedMessage[] = [];
  readonly acknowledged: string[] = [];

  seed(
    tenant: string,
    workOrderId: string,
    listingKinds: readonly FixtureListingKind[] = ['part', 'standard', 'electrical', 'equipment'],
  ): string {
    const eventId = `evt-wo-fixture-${this.messages.length + 1}`;
    this.messages.push({
      eventId,
      tenantId: tenant,
      occurredAt: new Date().toISOString(),
      payload: { workOrderId, projectName: `项目-${workOrderId}`, listingKinds, actor: 'u-fixture' },
    });
    return eventId;
  }

  async pendingCreatedEvents(tenant: TenantId): Promise<readonly FixtureWorkOrderCreatedMessage[]> {
    return this.messages.filter(
      (message) => message.tenantId === tenant && !this.acknowledged.includes(message.eventId),
    );
  }

  async acknowledge(eventId: string): Promise<void> {
    if (!this.acknowledged.includes(eventId)) this.acknowledged.push(eventId);
  }
}

// ---- inventory 假端口（可用量 + 入库指令） ----

/** 可编程库存可用量夹具：set 即生效，缺项按 0。 */
export class FakeListingInventoryPort {
  readonly stock = new Map<string, number>();

  async availableQty(
    _tenant: TenantId,
    itemIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    return new Map(itemIds.map((id) => [id, this.stock.get(id) ?? 0]));
  }
}

/**
 * 可编程入库指令夹具：默认放行；设 refuseReason 拒绝。
 * calls 记录全部指令（含被拒）——验证"拒绝不落账、放行才收货"与 receiptKey 幂等传参。
 */
export class FakeInventoryReceiptPort {
  readonly calls: FixtureInventoryReceiptCommand[] = [];
  refuseReason: string | null = null;

  async receivePurchase(_tenant: TenantId, command: FixtureInventoryReceiptCommand) {
    this.calls.push(command);
    return this.refuseReason === null
      ? { received: true }
      : { received: false, refusedReason: this.refuseReason };
  }

  receivedCount(): number {
    return this.calls.length;
  }
}

// ---- baseline 物料校验执行假端口 ----

/**
 * 可编程物料校验夹具：code 命中种子库 → matched（候选回填）；否则 unmatched。
 * 回执事件载荷形状与 baseline MaterialValidated 一致（listing 服务按结构化提取）。
 */
export class FakeMaterialValidationExecutor {
  readonly library = new Map<string, string>(); // code -> itemId
  refuseReason: string | null = null;

  async execute(tenant: TenantId, envelope: { readonly command: { readonly payload: unknown } }) {
    if (this.refuseReason !== null) {
      return { status: 'rejected' as const, reason: this.refuseReason };
    }
    const lines = (envelope.command.payload as { lines: readonly { code: string | null }[] }).lines;
    const judgments = lines.map((line, index) => {
      const itemId = line.code === null ? undefined : this.library.get(line.code);
      return {
        lineNo: index + 1,
        code: line.code,
        name: null,
        spec: null,
        judgment: itemId === undefined ? 'unmatched' : 'matched',
        candidateItemId: itemId ?? null,
        candidateItemCode: itemId === undefined ? null : line.code,
        similarity: itemId === undefined ? 0 : 1,
        basis: itemId === undefined ? 'none' : 'code-exact',
      };
    });
    return {
      status: 'committed' as const,
      newRevision: 1,
      events: [
        {
          eventId: `evt-mv-fixture-${Date.now()}`,
          eventType: 'smes.baseline.v1.material-validated',
          tenantId: tenant,
          aggregate: { id: 'mv-fixture', type: 'baseline-material-validation', revision: 1 },
          occurredAt: new Date().toISOString(),
          payload: { runId: 'mv-fixture', summary: { total: judgments.length }, lines: judgments },
        },
      ],
    };
  }
}

// ---- Excel 结构化源构造（json-tables 源；表头别名单见 application 侧语义层） ----

/** 清单导入的常用中文表头（别名集之一；等价表头见 excel-port 测试）。 */
export const LISTING_EXCEL_CN_HEADER: readonly string[] = [
  '图号', '物料编码', '物料名称', '规格型号', '数量', '需求日期',
];

/** 构造 json-tables Excel 源（单表）。 */
export function listingExcelSource(
  rows: readonly (readonly string[])[],
  header: readonly string[] = LISTING_EXCEL_CN_HEADER,
): { kind: 'json-tables'; sheets: FixtureExcelSheet[] } {
  return { kind: 'json-tables', sheets: [{ name: '清单', header, rows }] };
}
