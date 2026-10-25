/**
 * 标准报表四事实源适配器（S1 backfill：0920 #89/#91/#92/#96）+ 组合根装配
 * 工厂，经本包 `./standardreports` 子路径导出（与 `./metric-pack` 同模式）。
 *
 * **结构同形取舍（同 pg-metric-pack-stores.ts 先例，写明）**：dep-cruiser
 * 允许 business-store 依赖 engine-*，但包依赖区未含 @smes/engine-reporting
 * ——不为纯类型形状加包依赖，故本文件声明 MetricSource/MetricSourceRow/
 * MetricSourceRequest 的**本地结构同形镜像**（与引擎端口逐字段同形，组合根
 * 注入时 TypeScript 结构校验兼容）。
 *
 * 取行取舍（同 metric-pack v1）：不下推谓词/时间窗——返回租户内全量事实行，
 * 全部谓词由引擎 evaluateMetric 重复施加（正确性归属引擎，source.ts 头注同
 * 口径）。租户收口 = 构造注入 TenantId（组合根按请求租户绑定实例——引擎
 * MetricSource 端口不带租户参数）。
 *
 * 度量字段与 application/src/standardreports/standard-reports-pack.ts 的
 * measures.field 一一对应（口径包注释锁定的对应关系）：
 *   #89 stock-movement-facts      ← stock_movements（方向物化 received/issued/net）
 *   #91 labor-entry-facts         ← labor_entries（工种分列 + 方向符号 netHours）
 *   #92 part-dispatch-report-facts← dispatch_orders（kind=part 根过滤在引擎侧）
 *   #96 production-receipt-facts  ← stock_movements kind=production-in（根过滤在引擎侧）
 */
import { PrismaClient } from '@prisma/client';
import { TenantId } from '@smes/business-core';
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';

// ---- engine-reporting MetricSource 端口的本地结构同形镜像（不 import 该包） ----

/** 事实源行（引擎 MetricSourceRow 同形）：三时间列 + occurredAt + 领域字段。 */
export interface MetricSourceRow {
  readonly businessTime?: string;
  readonly availableTime?: string;
  readonly occurredAt: string;
  readonly [field: string]: unknown;
}

/** 读行请求（引擎 MetricSourceRequest 同形）。 */
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

function iso(data: Date): string {
  return data.toISOString();
}

/** 入库方向 kind 清单（与 application inventory-config.ts KIND_DIRECTION 同源事实：
 *  in = purchase-in/inspection-in/production-in/transfer-in/stocktake-gain）。 */
const INBOUND_KINDS = new Set([
  'purchase-in',
  'inspection-in',
  'production-in',
  'transfer-in',
  'stocktake-gain',
]);

/** 通用取行壳：租户收口 + sourceKind 防线（本适配器只服务一种 sourceKind）。 */
abstract class PgStandardReportsSourceBase implements MetricSource {
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
 * #89 库存报表事实源（stock-movement-facts）→ stock_movements 只读。
 * 物化（quantity 恒正、方向由 kind 推导——inventory-config 事实）：
 *  - receivedQty = 入向 kind 的 quantity，否则 0；issuedQty = 出向同理；
 *  - netQty = receivedQty − issuedQty（有符号净额；无时间下界查询的 Σnet
 *    即期末现存量——库存账=流水恒等式，口径包 description 同口径）。
 */
export class PgInventoryMovementsMetricSource extends PgStandardReportsSourceBase {
  constructor(prisma: PrismaClient, tenant: TenantId) {
    super(prisma, tenant, 'stock-movement-facts');
  }

  protected async readRows(): Promise<readonly MetricSourceRow[]> {
    const rows = await this.prisma.stockMovementRecord.findMany({
      where: { tenantId: this.tenant },
      orderBy: { occurredAt: 'asc' },
    });
    return rows.map((row): MetricSourceRow => {
      const inbound = INBOUND_KINDS.has(row.kind);
      const receivedQty = inbound ? row.quantity : 0;
      const issuedQty = inbound ? 0 : row.quantity;
      return {
        occurredAt: iso(row.occurredAt),
        ...(row.businessTime === null ? {} : { businessTime: iso(row.businessTime) }),
        ...(row.availableTime === null ? {} : { availableTime: iso(row.availableTime) }),
        movementId: row.id,
        kind: row.kind,
        itemId: row.itemId,
        workOrderId: row.workOrderId,
        receivedQty,
        issuedQty,
        netQty: receivedQty - issuedQty,
      };
    });
  }
}

/**
 * #91 工作令工时报表事实源（labor-entry-facts）→ labor_entries 只读。
 * 物化（hours 恒正、方向由 direction 推导——hours-stores 事实）：
 *  - 工种分列（trade ∈ machining/assembly/electrical/aftercare；misc 零工
 *    不挂工作令——workOrderId 为 null，被口径定义的根过滤
 *    `workOrderId ne null` 在引擎侧排除，本源仍全量返回，不自行裁行：
 *    "无归属不进口径"是口径不变量，属版本化定义而非适配器实现）；
 *  - signed = direction='reverse' ? −hours : +hours；netHours = signed；
 *    total-hours 度量 = ΣnetHours（四类合计 = 分列和）。
 */
export class PgLaborEntryMetricSource extends PgStandardReportsSourceBase {
  constructor(prisma: PrismaClient, tenant: TenantId) {
    super(prisma, tenant, 'labor-entry-facts');
  }

  protected async readRows(): Promise<readonly MetricSourceRow[]> {
    const rows = await this.prisma.laborEntryRecord.findMany({
      where: { tenantId: this.tenant },
      orderBy: { occurredAt: 'asc' },
    });
    return rows.map((row): MetricSourceRow => {
      const signed = row.direction === 'reverse' ? -row.hours : row.hours;
      const byTrade = (trade: string): number => (row.trade === trade ? signed : 0);
      return {
        occurredAt: iso(row.occurredAt),
        ...(row.businessTime === null ? {} : { businessTime: iso(row.businessTime) }),
        ...(row.availableTime === null ? {} : { availableTime: iso(row.availableTime) }),
        entryId: row.id,
        workOrderId: row.workOrderId,
        trade: row.trade,
        direction: row.direction,
        machiningHours: byTrade('machining'),
        assemblyHours: byTrade('assembly'),
        electricalHours: byTrade('electrical'),
        aftercareHours: byTrade('aftercare'),
        netHours: signed,
      };
    });
  }
}

/**
 * #92 自制零件派工报工事实源（part-dispatch-report-facts）→ dispatch_orders
 * 只读。物化：dispatchedQty = quantity（派发量）；reportedQty = doneQty
 * （dispatch.complete 回填的终态量——reporting 域报工撤销**不回滚** doneQty，
 * 两域未联动，口径按派工侧终态呈现，对账阶段校正）；occurred = createdAt
 * （派发时刻，口径包 timeBasis=occurred）。kind='part' 根过滤在引擎侧施加
 * （本源返回全 kind，防线冗余不越权）。
 */
export class PgPartDispatchMetricSource extends PgStandardReportsSourceBase {
  constructor(prisma: PrismaClient, tenant: TenantId) {
    super(prisma, tenant, 'part-dispatch-report-facts');
  }

  protected async readRows(): Promise<readonly MetricSourceRow[]> {
    const rows = await this.prisma.dispatchOrderRecord.findMany({
      where: { tenantId: this.tenant },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(
      (row): MetricSourceRow => ({
        occurredAt: iso(row.createdAt),
        dispatchId: row.id,
        kind: row.kind,
        state: row.state,
        workOrderId: row.workOrderId,
        drawingNo: row.drawingNo,
        operationCode: row.operationCode,
        dispatchedQty: row.quantity,
        reportedQty: row.doneQty,
      }),
    );
  }
}

/**
 * #96 自制零件入库日报表事实源（production-receipt-facts）→ stock_movements
 * 只读。物化：periodDay = business 口径时间的日期段（businessTime 缺省回落
 * occurredAt——引擎同回落语义）；receiptQty = quantity（恒正）。kind='
 * production-in' 根过滤在引擎侧施加；movement 行无图号列——图号维度降级
 * 标注在口径包 description（待数据面补齐），本源不硬造。
 */
export class PgProductionReceiptMetricSource extends PgStandardReportsSourceBase {
  constructor(prisma: PrismaClient, tenant: TenantId) {
    super(prisma, tenant, 'production-receipt-facts');
  }

  protected async readRows(): Promise<readonly MetricSourceRow[]> {
    const rows = await this.prisma.stockMovementRecord.findMany({
      where: { tenantId: this.tenant },
      orderBy: { occurredAt: 'asc' },
    });
    return rows.map((row): MetricSourceRow => {
      const basis = row.businessTime ?? row.occurredAt;
      return {
        occurredAt: iso(row.occurredAt),
        ...(row.businessTime === null ? {} : { businessTime: iso(row.businessTime) }),
        ...(row.availableTime === null ? {} : { availableTime: iso(row.availableTime) }),
        movementId: row.id,
        kind: row.kind,
        periodDay: basis.toISOString().slice(0, 10),
        workOrderId: row.workOrderId,
        itemId: row.itemId,
        receiptQty: row.quantity,
      };
    });
  }
}

// ---- 组合根装配工厂 ----

export interface StandardReportsSourcesOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/**
 * 四源装配句柄：sourceKind → MetricSource 绑定表（喂 application
 * StandardReportsModule 的 reportSourceProviderOf——结构同形）。租户收口 =
 * 构造注入（组合根按请求租户绑定实例；缓存策略在组合根）。
 */
export interface StandardReportsSourcesHandle {
  readonly sources: Readonly<Record<string, MetricSource>>;
  disconnect(): Promise<void>;
}

/** 构造四 sourceKind 的 PG 事实源装配（惰性连接：只构造 PrismaClient）。 */
export function connectStandardReportsSources(
  tenant: TenantId,
  options: StandardReportsSourcesOptions = {},
): StandardReportsSourcesHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  const client = rlsSessionEnabled() ? withRlsTenantSession(prisma) : prisma;
  return {
    sources: {
      'stock-movement-facts': new PgInventoryMovementsMetricSource(client, tenant),
      'labor-entry-facts': new PgLaborEntryMetricSource(client, tenant),
      'part-dispatch-report-facts': new PgPartDispatchMetricSource(client, tenant),
      'production-receipt-facts': new PgProductionReceiptMetricSource(client, tenant),
    },
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}
