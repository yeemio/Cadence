/**
 * metric-pack 三端口的 PG 实现 + 六种 sourceKind 事实源适配器 + 组合根装配工厂
 * （M3，m3-drafts/04-metric-pack.md §4；经本包 `./metric-pack` 子路径导出——与
 * `./payroll` 同模式：主入口保持零 @prisma/client 依赖）。启动零 DB 依赖：
 * connectMetricPackStore / connectMetricSourceBundle 只构造 PrismaClient（惰性
 * 连接），无 DATABASE_URL 时组合根不调用本工厂。
 *
 * **结构同形取舍（pro-pack-tier-edges 推论，写明）**：dep-cruiser 禁止
 * business-store import @smes/metric-pack（专业包不在 store-tier-edges 白名单），
 * 故本文件不 import 其类型，改用**本地结构化镜像类型**（与
 * packages/metric-pack/src/metric-pack-stores.ts 的行/端口形状逐字段同形——
 * 品牌化 id 用 business-core defineId 以同名品牌声明，类型统一于同一 Brand
 * 符号）。组合根注入时由 TypeScript 结构校验兼容（Pg* 类可直接喂
 * MetricPackService 的 MetricPackStores 槽位）。冲突信号用同名错误类承载
 * （name === 'MetricPackConflictError'），metric-pack 侧 isMetricPackConflict
 * 按 name 识别——跨包可观察行为等价。
 *
 * **事实源适配器（合同 §4 / 差异表 #2 收编）**：六种 sourceKind 各一个
 * 只读适配器，实现 engine-reporting 的 MetricSource 端口形状（本地结构同形
 * 镜像声明，见下方 Local* 接口——business-store 依赖区未含 engine-reporting，
 * 不为纯类型形状加包依赖；组合根注入时结构校验兼容引擎端口）。行形状对齐
 * 引擎 source.ts 锁的三时间列 + occurredAt + 领域字段；**动态判定字段（是否
 * 逾期/是否准时/交付判定）在适配器物化为数据字段**，引擎谓词保持静态纯数据。
 * 取行取舍（写明）：v1 不做谓词/时间窗下推——返回租户内全量事实行，全部谓词
 * 由引擎 evaluateMetric 重复施加（"正确性归属引擎、下推只是优化"，source.ts
 * 头注同口径；大数据量性能=合同 §12 开放问题）。租户收口：构造注入 TenantId
 * （组合根按请求租户绑定实例——引擎 MetricSource 端口不带租户参数）。
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';
import { TenantId, defineId, type BusinessEvent } from '@smes/business-core';
import { fromBusinessEventRow, toBusinessEventRow } from '../events/event-row.js';
import { initialOutboxRow } from '../events/outbox-row.js';
import { uuidv7 } from '../ids/uuidv7.js';

// ---- engine-reporting MetricSource 端口的本地结构同形镜像（不 import 该包） ----

/**
 * 事实源行（引擎 MetricSourceRow 同形）：证据三时间列 + occurredAt + 任意
 * 领域字段（索引签名）。引擎行约定 occurredAt 必有、businessTime/availableTime
 * 可空（口径回落语义在引擎）。
 */
export interface MetricSourceRow {
  readonly businessTime?: string;
  readonly availableTime?: string;
  readonly occurredAt: string;
  readonly [field: string]: unknown;
}

/** 读行请求（引擎 MetricSourceRequest 同形；filter 谓词形状由引擎侧持有）。 */
export interface MetricSourceRequest {
  readonly sourceKind: string;
  readonly timeBasis: 'business' | 'available' | 'occurred';
  readonly from?: string;
  readonly to?: string;
  readonly filter?: unknown;
}

/** 数据源端口（引擎 MetricSource 同形；组合根注入时结构校验兼容）。 */
export interface MetricSource {
  read(request: MetricSourceRequest): Promise<readonly MetricSourceRow[]>;
}

// ---- 本地结构同形镜像（与 @smes/metric-pack 同名品牌/同形行；不 import 该包） ----

const MetricPackActivationId = defineId('MetricPackActivationId');
type MetricPackActivationId = ReturnType<typeof MetricPackActivationId.create>;

interface MetricRef {
  readonly metricId: string;
  readonly version: number;
}

interface MetricPackActivationRow {
  readonly id: MetricPackActivationId;
  readonly tenant: TenantId;
  readonly packId: string;
  readonly packVersion: number;
  readonly title: string;
  readonly pack: Readonly<Record<string, unknown>>;
  readonly metricRefs: readonly MetricRef[];
  readonly activatedBy: string;
  readonly activatedAt: string;
  readonly supersedes: string | null;
  readonly auditStatus: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly businessTime?: string;
  readonly createdAt: string;
}

type AppendMetricPackActivationInput = Omit<MetricPackActivationRow, 'id' | 'createdAt'>;

/** 冲突错误镜像（name 同形——metric-pack 侧 isMetricPackConflict 按 name 识别）。 */
class MetricPackConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricPackConflictError';
  }
}

// ---- 小工具 ----

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function jsonInput(value: Readonly<Record<string, unknown>> | readonly unknown[]): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

function isoToDate(value: string | undefined | null): Date | undefined {
  return value === undefined || value === null ? undefined : new Date(value);
}

function iso(data: Date): string {
  return data.toISOString();
}

/** 正数 half-up 取整（金额分口径：lineAmountMinor = receivedQty × unitPriceMinor）。 */
function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

function metricRefsToJson(refs: readonly MetricRef[]): Prisma.InputJsonValue {
  return refs.map((ref) => ({ metricId: ref.metricId, version: ref.version }));
}

function metricRefsFromJson(raw: unknown): readonly MetricRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    if (typeof record['metricId'] !== 'string' || typeof record['version'] !== 'number') return [];
    return [{ metricId: record['metricId'], version: record['version'] }];
  });
}

// ---- 装载记录（append-only 配置装载事实） ----

type MetricPackActivationDbRow = {
  id: string;
  tenantId: string;
  packId: string;
  packVersion: number;
  title: string;
  pack: unknown;
  metricRefs: unknown;
  activatedBy: string;
  activatedAt: Date;
  objectVersion: number;
  supersedes: string | null;
  auditStatus: string;
  provenance: unknown;
  businessTime: Date | null;
  availableTime: Date | null;
  createdAt: Date;
};

function toActivationRow(row: MetricPackActivationDbRow): MetricPackActivationRow {
  return {
    id: MetricPackActivationId.create(row.id),
    tenant: TenantId.create(row.tenantId),
    packId: row.packId,
    packVersion: row.packVersion,
    title: row.title,
    pack: (row.pack ?? {}) as Readonly<Record<string, unknown>>,
    metricRefs: metricRefsFromJson(row.metricRefs),
    activatedBy: row.activatedBy,
    activatedAt: row.activatedAt.toISOString(),
    supersedes: row.supersedes,
    auditStatus: row.auditStatus,
    ...(row.provenance === null || row.provenance === undefined
      ? {}
      : { provenance: row.provenance as Readonly<Record<string, unknown>> }),
    ...(row.businessTime === null ? {} : { businessTime: row.businessTime.toISOString() }),
    createdAt: row.createdAt.toISOString(),
  };
}

export class PgMetricPackActivationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(input: AppendMetricPackActivationInput): Promise<MetricPackActivationRow> {
    try {
      const row = await this.prisma.metricPackActivationRecord.create({
        data: {
          id: uuidv7(),
          tenantId: input.tenant,
          packId: input.packId,
          packVersion: input.packVersion,
          title: input.title,
          pack: jsonInput(input.pack),
          metricRefs: metricRefsToJson(input.metricRefs),
          activatedBy: input.activatedBy,
          activatedAt: new Date(input.activatedAt),
          objectVersion: 1,
          supersedes: input.supersedes,
          auditStatus: input.auditStatus,
          ...(input.provenance === undefined ? {} : { provenance: jsonInput(input.provenance) }),
          businessTime: isoToDate(input.businessTime) ?? null,
        },
      });
      return toActivationRow(row);
    } catch (error) {
      throw toConflict(
        error,
        `口径包 ${input.packId} 版本 ${input.packVersion} 唯一约束冲突（并发装载竞态或 supersedes 链分叉）`,
      );
    }
  }

  async chain(tenant: TenantId, packId: string): Promise<readonly MetricPackActivationRow[]> {
    const rows = await this.prisma.metricPackActivationRecord.findMany({
      where: { tenantId: tenant, packId },
      orderBy: { packVersion: 'asc' },
    });
    return rows.map(toActivationRow);
  }

  async listAll(tenant: TenantId): Promise<readonly MetricPackActivationRow[]> {
    const rows = await this.prisma.metricPackActivationRecord.findMany({
      where: { tenantId: tenant },
      orderBy: [{ packId: 'asc' }, { packVersion: 'asc' }],
    });
    return rows.map(toActivationRow);
  }
}

function toConflict(error: unknown, message: string): unknown {
  if (isUniqueViolation(error)) {
    return new MetricPackConflictError(message);
  }
  return error;
}

// ---- 事件 + Outbox（同事务）与幂等账本 ----

export class PgMetricPackDomainEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: BusinessEvent): Promise<void> {
    const row = toBusinessEventRow(event);
    const outbox = initialOutboxRow(row.eventId, event.tenantId);
    try {
      // 交互式事务共享 tx 句柄：event+outbox 原子双写（RLS 接管见 rls-session.ts）。
      await this.prisma.$transaction(async (tx) => {
        await tx.businessEventRecord.create({
          data: {
            eventId: row.eventId,
            tenantId: row.tenantId,
            eventType: row.eventType,
            aggregateId: row.aggregateId,
            aggregateType: row.aggregateType,
            aggregateRevision: row.aggregateRevision,
            occurredAt: row.occurredAt,
            ...(row.businessTime === undefined ? {} : { businessTime: row.businessTime }),
            ...(row.availableTime === undefined ? {} : { availableTime: row.availableTime }),
            ...(row.provenance === undefined ? {} : { provenance: row.provenance as Prisma.InputJsonObject }),
            payload: row.payload as Prisma.InputJsonObject,
          },
        });
        await tx.outboxRecord.create({
          data: { eventId: outbox.eventId, tenantId: outbox.tenantId, createdAt: outbox.createdAt },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new MetricPackConflictError(`事件 '${row.eventId}' 已落账（eventId 幂等锚点）`);
      }
      throw error;
    }
  }

  async list(tenant: TenantId): Promise<readonly BusinessEvent[]> {
    const rows = await this.prisma.businessEventRecord.findMany({
      where: { tenantId: tenant },
      orderBy: { occurredAt: 'asc' },
    });
    return rows.map((row) =>
      fromBusinessEventRow({
        eventId: row.eventId,
        eventType: row.eventType,
        tenantId: TenantId.create(row.tenantId),
        aggregateId: row.aggregateId,
        aggregateType: row.aggregateType,
        aggregateRevision: row.aggregateRevision,
        occurredAt: row.occurredAt,
        ...(row.businessTime === null ? {} : { businessTime: row.businessTime }),
        ...(row.availableTime === null ? {} : { availableTime: row.availableTime }),
        ...(row.provenance === null ? {} : { provenance: row.provenance as Readonly<Record<string, unknown>> }),
        payload: row.payload,
      }),
    );
  }
}

export class PgMetricPackOperationLedger {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(tenant: TenantId, operationId: string, commandKind: string): Promise<boolean> {
    try {
      await this.prisma.metricPackOperationRecord.create({
        data: { id: uuidv7(), tenantId: tenant, operationId, commandKind },
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false; // 已落账 → 幂等拒绝
      throw error;
    }
  }
}

// ============================================================================
// 六种 sourceKind 事实源适配器（MetricSource；只读，判定字段物化）
// ============================================================================

/** 通用取行壳：租户收口 + sourceKind 防线（本适配器只服务一种 sourceKind）。 */
abstract class PgMetricSourceBase implements MetricSource {
  constructor(
    protected readonly prisma: PrismaClient,
    protected readonly tenant: TenantId,
    private readonly servedKind: string,
  ) {}

  async read(request: MetricSourceRequest): Promise<readonly MetricSourceRow[]> {
    if (request.sourceKind !== this.servedKind) {
      throw new Error(
        `unknown sourceKind "${String(request.sourceKind)}": this source serves "${this.servedKind}"`,
      );
    }
    return this.readRows();
  }

  /** 取租户内全量事实行（不下推谓词/时间窗——正确性归引擎，见文件头取舍）。 */
  protected abstract readRows(): Promise<readonly MetricSourceRow[]>;
}

/**
 * workorder-attachment-facts（88 下图统计）→ work_order_attachments 只读。
 * 物化：drawingNo = 附件名（机加场景图纸附件名即图号；对账阶段校准）；
 * occurredAt = attachedAt；businessTime/availableTime 原样（缺省引擎回落 occurredAt）。
 */
export class PgWorkOrderAttachmentMetricSource extends PgMetricSourceBase {
  constructor(prisma: PrismaClient, tenant: TenantId) {
    super(prisma, tenant, 'workorder-attachment-facts');
  }

  protected async readRows(): Promise<readonly MetricSourceRow[]> {
    const rows = await this.prisma.workOrderAttachmentRecord.findMany({
      where: { tenantId: this.tenant },
      orderBy: { attachedAt: 'asc' },
    });
    return rows.map(
      (row): MetricSourceRow => ({
        occurredAt: iso(row.attachedAt),
        ...(row.businessTime === null ? {} : { businessTime: iso(row.businessTime) }),
        ...(row.availableTime === null ? {} : { availableTime: iso(row.availableTime) }),
        workOrderId: row.workOrderId,
        drawingNo: row.name,
        attachmentId: row.id,
        kind: row.kind,
      }),
    );
  }
}

/**
 * workorder-delivery-facts（90 工作令交付）→ work_orders 只读。
 * 物化（判定字段按计划 vs 实际交付日期，合同 §5）：
 *  - actualDeliveryAt = packagingArrivalAt（实际交付时点，可空）；
 *  - deliveryVerdict：实际<=计划 → on-time（含同刻）；实际>计划 → delayed；
 *    无实际 → undelivered；
 *  - periodMonth = 计划交付月（计划缺失回落创建月——行为重述初版，对账校准）。
 */
export class PgWorkOrderDeliveryMetricSource extends PgMetricSourceBase {
  constructor(prisma: PrismaClient, tenant: TenantId) {
    super(prisma, tenant, 'workorder-delivery-facts');
  }

  protected async readRows(): Promise<readonly MetricSourceRow[]> {
    const rows = await this.prisma.workOrderProjectionRecord.findMany({
      where: { tenantId: this.tenant },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row): MetricSourceRow => {
      const planned = row.plannedDeliveryAt;
      const actual = row.packagingArrivalAt;
      const verdict: string =
        actual === null || actual === undefined
          ? 'undelivered'
          : planned === null || planned === undefined
            ? 'delayed'
            : actual.getTime() <= planned.getTime()
              ? 'on-time'
              : 'delayed';
      const anchor = planned ?? row.createdAt;
      return {
        occurredAt: iso(row.createdAt),
        ...(planned === null ? {} : { businessTime: iso(planned) }),
        workOrderId: row.id,
        periodMonth: anchor.toISOString().slice(0, 7),
        deliveryVerdict: verdict,
        ...(planned === null ? {} : { plannedDeliveryAt: iso(planned) }),
        ...(actual === null ? { actualDeliveryAt: null } : { actualDeliveryAt: iso(actual) }),
        state: row.state,
      };
    });
  }
}

/**
 * outsourcing-delivery-facts（93 外协交货）→ outsourcing_lines × inspections 只读。
 * 物化：回厂时点 returnedAt = 该派工单外协检（kind=self_outsourced，
 * sourceType='dispatch'，sourceRefId=dispatchId）的最新 judgedAt；准时判定
 * onTimeFlag = returnedAt <= promisedAt ? 1 : 0。
 * 行集取舍（v1，对账阶段校准）：仅"已定交期且已回厂"的外协行成事实行
 * （准时率分母 = 已回厂单；在途单不进口径）。
 */
export class PgOutsourcingDeliveryMetricSource extends PgMetricSourceBase {
  constructor(prisma: PrismaClient, tenant: TenantId) {
    super(prisma, tenant, 'outsourcing-delivery-facts');
  }

  protected async readRows(): Promise<readonly MetricSourceRow[]> {
    const lines = await this.prisma.outsourcingLineRecord.findMany({
      where: { tenantId: this.tenant },
      orderBy: { createdAt: 'asc' },
    });
    const returns = await this.prisma.inspectionOrderRecord.findMany({
      where: { tenantId: this.tenant, kind: 'self_outsourced', sourceType: 'dispatch' },
      orderBy: { judgedAt: 'asc' },
    });
    // dispatchId → 最新 judgedAt（回厂判定时点；复检不重建明细，取末次判定）。
    const returnedAtByDispatch = new Map<string, Date>();
    for (const inspection of returns) {
      if (inspection.judgedAt === null || inspection.sourceRefId === null) continue;
      returnedAtByDispatch.set(inspection.sourceRefId, inspection.judgedAt);
    }
    const rows: MetricSourceRow[] = [];
    for (const line of lines) {
      const promised = line.promisedAt;
      const returned = returnedAtByDispatch.get(line.dispatchId);
      if (promised === null || returned === undefined) continue; // 无交期/未回厂不进口径
      rows.push({
        occurredAt: iso(returned),
        businessTime: iso(promised),
        supplierId: line.supplierRef,
        periodMonth: promised.toISOString().slice(0, 7),
        ...(line.drawingNo === null ? { drawingNo: null } : { drawingNo: line.drawingNo }),
        onTimeFlag: returned.getTime() <= promised.getTime() ? 1 : 0,
        dispatchId: line.dispatchId,
        lineId: line.id,
        processCode: line.processCode,
        promisedAt: iso(promised),
        returnedAt: iso(returned),
      });
    }
    return rows;
  }
}

/** 采购订单行 JSONB 载荷的防御性解析形状（listing PurchaseOrderLine 镜像）。 */
interface PurchaseOrderLineJson {
  readonly lineNo: number;
  readonly itemId: string;
  readonly drawingNo: string | null;
  readonly quantity: number;
  readonly unitPriceMinor: number | null;
  readonly receivedQty: number;
}

function parseOrderLines(raw: unknown): readonly PurchaseOrderLineJson[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): PurchaseOrderLineJson[] => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    if (
      typeof record['lineNo'] !== 'number' ||
      typeof record['itemId'] !== 'string' ||
      typeof record['quantity'] !== 'number' ||
      typeof record['receivedQty'] !== 'number' ||
      !(record['unitPriceMinor'] === null || typeof record['unitPriceMinor'] === 'number')
    ) {
      return [];
    }
    return [
      {
        lineNo: record['lineNo'],
        itemId: record['itemId'],
        drawingNo: typeof record['drawingNo'] === 'string' ? record['drawingNo'] : null,
        quantity: record['quantity'],
        unitPriceMinor: record['unitPriceMinor'],
        receivedQty: record['receivedQty'],
      },
    ];
  });
}

/**
 * purchase-overdue-facts（94 采购件预期）→ purchase_orders 只读（含收货回填的
 * 行级 receivedQty——"已收数量由 receive 联动回填"事实，与 inventory 入库净额
 * 同源同值，不重算 movement 汇总）。
 * 物化：outstandingQty = quantity − receivedQty；isOverdue = 读取时刻已过交期
 * （动态判定物化，94 根过滤 isOverdue ∧ outstanding>0 消费）；
 * 行集：排除 draft 态（未下单不进采购预期口径）。
 */
export class PgPurchaseOverdueMetricSource extends PgMetricSourceBase {
  constructor(prisma: PrismaClient, tenant: TenantId) {
    super(prisma, tenant, 'purchase-overdue-facts');
  }

  protected async readRows(): Promise<readonly MetricSourceRow[]> {
    const orders = await this.prisma.purchaseOrderRecord.findMany({
      where: { tenantId: this.tenant },
      orderBy: { createdAt: 'asc' },
    });
    const now = Date.now();
    const rows: MetricSourceRow[] = [];
    for (const order of orders) {
      if (order.state === 'draft') continue;
      for (const line of parseOrderLines(order.lines)) {
        rows.push({
          occurredAt: iso(order.createdAt),
          businessTime: iso(order.promisedAt),
          orderLineId: `${order.id}#${String(line.lineNo)}`,
          orderId: order.id,
          itemId: line.itemId,
          drawingNo: line.drawingNo,
          outstandingQty: line.quantity - line.receivedQty,
          isOverdue: now > order.promisedAt.getTime(),
          promisedAt: iso(order.promisedAt),
          ...(order.workOrderId === null ? { workOrderId: null } : { workOrderId: order.workOrderId }),
          orderState: order.state,
        });
      }
    }
    return rows;
  }
}

/**
 * purchase-amount-facts（95 采购金额汇总）→ purchase_orders 只读。
 * 物化：lineAmountMinor = receivedQty × unitPriceMinor（已收货数量×单价，
 * half-up 到分——listing 对账要点同口径）；partType = 按行挂图号两分
 * drawing-part/standard-part（v1 行为重述初版，对账阶段按活系统校正）；
 * 行集：排除 draft 态与未定价行（无价不归集——listing 先例）。
 */
export class PgPurchaseAmountMetricSource extends PgMetricSourceBase {
  constructor(prisma: PrismaClient, tenant: TenantId) {
    super(prisma, tenant, 'purchase-amount-facts');
  }

  protected async readRows(): Promise<readonly MetricSourceRow[]> {
    const orders = await this.prisma.purchaseOrderRecord.findMany({
      where: { tenantId: this.tenant },
      orderBy: { createdAt: 'asc' },
    });
    const rows: MetricSourceRow[] = [];
    for (const order of orders) {
      if (order.state === 'draft') continue;
      for (const line of parseOrderLines(order.lines)) {
        if (line.unitPriceMinor === null) continue;
        rows.push({
          occurredAt: iso(order.createdAt),
          businessTime: iso(order.promisedAt),
          ...(order.workOrderId === null ? { workOrderId: null } : { workOrderId: order.workOrderId }),
          partType: line.drawingNo === null ? 'standard-part' : 'drawing-part',
          orderId: order.id,
          orderLineId: `${order.id}#${String(line.lineNo)}`,
          lineAmountMinor: roundHalfUp(line.receivedQty * line.unitPriceMinor),
          receivedQty: line.receivedQty,
          unitPriceMinor: line.unitPriceMinor,
          itemId: line.itemId,
          drawingNo: line.drawingNo,
        });
      }
    }
    return rows;
  }
}

/**
 * costing-entry-facts（97 项目成本）→ cost_entries 只读（append-only 事实直读，
 * 含 delta 条目；amountMinor 可空行交引擎 sum 语义跳过）。归集与重算归 M2
 * costing（R6），本源只呈现口径消费。
 */
export class PgCostingEntryMetricSource extends PgMetricSourceBase {
  constructor(prisma: PrismaClient, tenant: TenantId) {
    super(prisma, tenant, 'costing-entry-facts');
  }

  protected async readRows(): Promise<readonly MetricSourceRow[]> {
    const rows = await this.prisma.costEntryRecord.findMany({
      where: { tenantId: this.tenant },
      orderBy: { occurredAt: 'asc' },
    });
    return rows.map(
      (row): MetricSourceRow => ({
        occurredAt: iso(row.occurredAt),
        ...(row.businessTime === null ? {} : { businessTime: iso(row.businessTime) }),
        ...(row.availableTime === null ? {} : { availableTime: iso(row.availableTime) }),
        workOrderId: row.workOrderId,
        category: row.category,
        ...(row.amountMinor === null ? { amountMinor: null } : { amountMinor: row.amountMinor }),
        ...(row.quantity === null ? {} : { quantity: row.quantity }),
        entryId: row.id,
      }),
    );
  }
}

// ---- 组合根装配工厂 ----

export interface MetricPackStoreOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/**
 * 组合根装配句柄：三端口实现。结构同形兼容 @smes/metric-pack 的
 * MetricPackStores 槽位（组合根注入时结构校验），可直接喂 MetricPackService
 * 构造函数。
 */
export interface MetricPackStoreHandle {
  readonly activationStore: PgMetricPackActivationStore;
  readonly eventStore: PgMetricPackDomainEventStore;
  readonly operationStore: PgMetricPackOperationLedger;
  readonly stores: {
    readonly activations: PgMetricPackActivationStore;
    readonly events: PgMetricPackDomainEventStore;
    readonly operations: PgMetricPackOperationLedger;
  };
  disconnect(): Promise<void>;
}

/** 构造 metric-pack PG 存储装配（惰性连接：见文件头）。 */
export function connectMetricPackStore(options: MetricPackStoreOptions = {}): MetricPackStoreHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  // RLS session 接线（ESCALATION-2 收尾）：门控与机制/取舍见 ../rls-session.ts 文件头。
  const client = withRlsTenantSession(prisma, { session: rlsSessionEnabled() });
  const activationStore = new PgMetricPackActivationStore(client);
  const eventStore = new PgMetricPackDomainEventStore(client);
  const operationStore = new PgMetricPackOperationLedger(client);
  return {
    activationStore,
    eventStore,
    operationStore,
    stores: {
      activations: activationStore,
      events: eventStore,
      operations: operationStore,
    },
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}

/**
 * 六源装配句柄：sourceKind → MetricSource 绑定表（喂 @smes/metric-pack 的
 * metricSourceSetOf / MetricSourceSet 槽位——结构同形）。租户收口=构造注入
 * （组合根按请求租户绑定实例；引擎 MetricSource 端口不带租户参数）。
 */
export interface MetricSourceBundleHandle {
  readonly sources: Readonly<Record<string, MetricSource>>;
  disconnect(): Promise<void>;
}

/** 构造六种 sourceKind 的 PG 事实源装配（惰性连接：同上）。 */
export function connectMetricSourceBundle(
  tenant: TenantId,
  options: MetricPackStoreOptions = {},
): MetricSourceBundleHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  // RLS session 接线（ESCALATION-2 收尾）：门控与机制/取舍见 ../rls-session.ts 文件头。
  const client = withRlsTenantSession(prisma, { session: rlsSessionEnabled() });
  return {
    sources: {
      'workorder-attachment-facts': new PgWorkOrderAttachmentMetricSource(client, tenant),
      'workorder-delivery-facts': new PgWorkOrderDeliveryMetricSource(client, tenant),
      'outsourcing-delivery-facts': new PgOutsourcingDeliveryMetricSource(client, tenant),
      'purchase-overdue-facts': new PgPurchaseOverdueMetricSource(client, tenant),
      'purchase-amount-facts': new PgPurchaseAmountMetricSource(client, tenant),
      'costing-entry-facts': new PgCostingEntryMetricSource(client, tenant),
    },
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}
