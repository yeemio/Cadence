/**
 * 标准报表四事实源适配器（S1 backfill：0920 #89/#91/#92/#96）+ 报表中心六事实
 * 源适配器（功能补齐第一波 r2/r7/r8/r9/r12/r13，6a-3 裁决 2 补绑定）+ 组合根
 * 装配工厂，经本包 `./standardreports` 子路径导出（与 `./metric-pack` 同模式）。
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
 * 度量字段与 application/src/standardreports 两口径包的 measures.field 一一
 * 对应（口径包注释锁定的对应关系）：
 *   #89 stock-movement-facts       ← stock_movements（方向物化 received/issued/net）
 *   #91 labor-entry-facts          ← labor_entries（工种分列 + 方向符号 netHours）
 *   #92 part-dispatch-report-facts ← dispatch_orders（kind=part 根过滤在引擎侧）
 *   #96 production-receipt-facts   ← stock_movements kind=production-in（根过滤在引擎侧）
 *   r2  work-order-facts           ← work_orders（业务时间=实际交付，未交付回落引擎语义）
 *   r7  outsource-delivery-facts   ← dispatch_orders kind=outsourcing × outsourcing_lines
 *                                     × 外协检 judgedAt（逾期判定物化 lateDrawingKey）
 *   r12 quality-inspect-facts      ← inspections 三 kind（设备排除；completed 物化）
 *   r13 position-hours-facts       ← work_reports 三岗位 kind（approvalStatus 物化）
 *   r8  purchase-overdue-daily-facts ← purchase_orders 行级 + 承接申请溯源 partType
 *   r9  purchase-amount-facts      ← purchase_orders（复用 metric-pack 95 同源适配器，
 *                                     两包口径声明同源同根——见 pack description）
 */
import { PrismaClient } from '@prisma/client';
import { TenantId } from '@smes/business-core';
import { rlsSessionEnabled, withRlsTenantSession } from '../rls-session.js';
import { PgPurchaseAmountMetricSource } from '../metric-pack/pg-metric-pack-stores.js';

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

/** UTC 日段（yyyy-MM-dd）——全部日期维度物化统一 UTC 口径（与 iso 同基）。 */
function dayOf(data: Date): string {
  return data.toISOString().slice(0, 10);
}

/** UTC 月段（yyyy-MM）。 */
function monthOf(data: Date): string {
  return data.toISOString().slice(0, 7);
}

/** trim 后空串归 null（口径包"图号 trim 空值不计入去重"物化语义）。 */
function trimmed(value: string | null): string | null {
  if (value === null) return null;
  const trimmedValue = value.trim();
  return trimmedValue === '' ? null : trimmedValue;
}

/** 日历日差（anchor − planned，日段相减——r7 lateDays 口径）。 */
function daysBetween(planned: Date, anchor: Date): number {
  return Math.round(
    (Date.parse(dayOf(anchor)) - Date.parse(dayOf(planned))) / 86_400_000,
  );
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

// ============================================================================
// 报表中心六事实源适配器（r2/r7/r8/r9/r12/r13——report-center 口径包 v3；
// 6a-3 裁决 2 补绑定。判定字段（逾期/已质检/审核态/清单来源）一律物化为
// 数据字段，引擎谓词保持静态纯数据；口径冻结处见 report-center-pack 各
// metric description，与本处物化的偏差点逐条登记在各类头注）
// ============================================================================

/**
 * r2 工作令交付事实源（work-order-facts）→ work_orders 投影只读。
 * 物化：workOrderNo=id（本系统工作令身份即 id，无独立单号列——重述取舍，
 * 对账阶段校准）；workOrderName=projectName；planDeliveryDate/
 * actualDeliveryDate=计划/实际交付日（yyyy-MM-dd，空归 null 组——r2 口径）；
 * businessTime=实际交付时刻（packagingArrivalAt，未交付行缺省 → 引擎回落
 * occurredAt=行创建时刻，r2 冻结语义）。逻辑删除（is_deleted）本系统工作令
 * 无此面（append-only 投影）——"删除行剔除"防线结构性不适用。
 */
export class PgReportCenterWorkOrderMetricSource extends PgStandardReportsSourceBase {
  constructor(prisma: PrismaClient, tenant: TenantId) {
    super(prisma, tenant, 'work-order-facts');
  }

  protected async readRows(): Promise<readonly MetricSourceRow[]> {
    const rows = await this.prisma.workOrderProjectionRecord.findMany({
      where: { tenantId: this.tenant },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(
      (row): MetricSourceRow => ({
        occurredAt: iso(row.createdAt),
        ...(row.packagingArrivalAt === null ? {} : { businessTime: iso(row.packagingArrivalAt) }),
        workOrderNo: row.id,
        workOrderName: row.projectName,
        workOrderStatus: row.state,
        ...(row.plannedDeliveryAt === null ? { planDeliveryDate: null } : { planDeliveryDate: dayOf(row.plannedDeliveryAt) }),
        ...(row.packagingArrivalAt === null ? { actualDeliveryDate: null } : { actualDeliveryDate: dayOf(row.packagingArrivalAt) }),
      }),
    );
  }
}

/** 派工单状态 → 源字典 dispatchStatus（r7 根过滤 >=2 已下发；cancelled 归 0 出口径）。 */
const OUTSOURCE_DISPATCH_STATUS: Readonly<Record<string, number>> = {
  draft: 1,
  assigned: 2,
  executing: 3,
  done: 4,
  cancelled: 0,
};

/**
 * r7 外协交货事实源（outsource-delivery-facts）→ dispatch_orders
 * kind=outsourcing × outsourcing_lines × 外协检只读。行粒度=派工单×外协明细行。
 * 物化（r7 冻结口径）：
 *  - drawingKey=工作令+trim 图号（同工作令同图号多次派工计 1）；图号空按
 *    明细行唯一键（line:id）物化；
 *  - 逾期判定：实际质检日>计划交货日，或未质检且统计截止日（口径默认昨日）
 *    >计划交货日 → lateDrawingKey=drawingKey、lateDays=日历日差（r7 下钻
 *    口径），非逾期 lateDrawingKey=null（distinct-count/max 跳过）；
 *  - 实际质检日=该派工单外协检（kind=self_outsourced，sourceType='dispatch'）
 *    末次 judgedAt（复检取末次——同 metric-pack 93 先例）；
 *  - statMonth=计划交货月；dispatchStatus 数值物化（状态机词汇见上表）。
 * 偏差登记（v1，对账阶段校准）：下发时刻无独立列 → dispatchTime/occurredAt
 * 按派工单创建时刻近似；availableTime=读取时刻（实时求值形态的"刷新时刻"）。
 * 已取消派工单 dispatchStatus=0 → 根过滤剔除（引擎侧，本源仍全量返回）。
 * 外协明细取消态（6a-1 在途新增列，未定稿）本源不引用不剔除——跨线零耦合，
 * 随取消语义定稿后对账收编。
 */
export class PgReportCenterOutsourceDeliveryMetricSource extends PgStandardReportsSourceBase {
  constructor(prisma: PrismaClient, tenant: TenantId) {
    super(prisma, tenant, 'outsource-delivery-facts');
  }

  protected async readRows(): Promise<readonly MetricSourceRow[]> {
    const dispatches = await this.prisma.dispatchOrderRecord.findMany({
      where: { tenantId: this.tenant, kind: 'outsourcing' },
      orderBy: { createdAt: 'asc' },
    });
    const lines = await this.prisma.outsourcingLineRecord.findMany({
      where: { tenantId: this.tenant },
      orderBy: { createdAt: 'asc' },
    });
    const inspections = await this.prisma.inspectionOrderRecord.findMany({
      where: { tenantId: this.tenant, kind: 'self_outsourced', sourceType: 'dispatch' },
      orderBy: { judgedAt: 'asc' },
    });
    // dispatchId → 末次判定时刻（升序遍历后写胜出；未判定行跳过）。
    const judgedByDispatch = new Map<string, Date>();
    for (const inspection of inspections) {
      if (inspection.judgedAt === null || inspection.sourceRefId === null) continue;
      judgedByDispatch.set(inspection.sourceRefId, inspection.judgedAt);
    }
    const linesByDispatch = new Map<string, typeof lines>();
    for (const line of lines) {
      const bucket = linesByDispatch.get(line.dispatchId);
      if (bucket === undefined) {
        linesByDispatch.set(line.dispatchId, [line]);
      } else {
        bucket.push(line);
      }
    }
    // 统计截止日：口径冻结默认昨日（实时求值形态按读取时刻前一日物化）。
    const cutoff = new Date(Date.now() - 86_400_000);
    const refreshedAt = new Date();
    const rows: MetricSourceRow[] = [];
    for (const dispatch of dispatches) {
      const status = OUTSOURCE_DISPATCH_STATUS[dispatch.state] ?? 0;
      for (const line of linesByDispatch.get(dispatch.id) ?? []) {
        const drawing = trimmed(line.drawingNo);
        const planned = line.promisedAt;
        const judged = judgedByDispatch.get(dispatch.id) ?? null;
        let lateDrawingKey: string | null = null;
        let lateDays: number | null = null;
        if (planned !== null) {
          const anchor = judged ?? cutoff;
          if (dayOf(anchor) > dayOf(planned)) {
            lateDrawingKey = drawing === null ? `line:${line.id}` : `${dispatch.workOrderId ?? 'none'}::${drawing}`;
            lateDays = daysBetween(planned, anchor);
          }
        }
        const drawingKey = drawing === null ? `line:${line.id}` : `${dispatch.workOrderId ?? 'none'}::${drawing}`;
        rows.push({
          occurredAt: iso(dispatch.createdAt),
          ...(planned === null ? {} : { businessTime: iso(planned) }),
          availableTime: iso(refreshedAt),
          ...(planned === null ? { statMonth: null } : { statMonth: monthOf(planned) }),
          supplierId: line.supplierRef,
          orderId: dispatch.id,
          ...(drawing === null ? { drawingNo: null } : { drawingNo: drawing }),
          processCode: line.processCode,
          ...(planned === null ? { plannedDeliveryDate: null } : { plannedDeliveryDate: dayOf(planned) }),
          ...(judged === null ? { actualInspectDate: null } : { actualInspectDate: dayOf(judged) }),
          drawingKey,
          lateDrawingKey,
          lateDays,
          dispatchStatus: status,
          dispatchTime: iso(dispatch.createdAt),
          lineId: line.id,
          ...(line.supplierName === null ? { supplierName: null } : { supplierName: line.supplierName }),
        });
      }
    }
    return rows;
  }
}

/**
 * r12 质检汇总事实源（quality-inspect-facts）→ inspections 三 kind 只读
 * （self_outsourced 外协回厂 / nonstandard_purchase 非标采购 / standard_purchase
 * 标准配件采购；equipment_purchase 设备质检不纳入 r12 口径——源适配器行集
 * 取舍，同"设备采购质检不纳入"冻结语）。物化：completed=judgedAt 非空（已
 * 质检；根过滤承载）；drawingNo=自制/外协/非标取图号、标准配件取物料编码
 * （itemId），trim 空归 null；inspectDate/statMonth=质检完成日段/月段；
 * inspectQty=quantity、unqualifiedQty=failedQty（空归 0）。本系统质检状态机
 * 无"已取消"态（pending/passed/failed/closed）——"排除已取消"结构性不适用；
 * 待检行 completed=false 由根过滤剔除。复检独立计行不冲减（每张质检单一行，
 * 天然满足）。occurredAt=源行创建；businessTime=质检完成时刻。缺口登记（v1，
 * 对账阶段校准）：源口径三源之"自制完工质检"在本系统无独立质检面（自制
 * 完工走报工域，不走 inspections）——本源覆盖外协回厂/非标采购/标准配件
 * 三 kind，自制完工面缺口随对账收编。
 */
export class PgReportCenterQualityInspectMetricSource extends PgStandardReportsSourceBase {
  constructor(prisma: PrismaClient, tenant: TenantId) {
    super(prisma, tenant, 'quality-inspect-facts');
  }

  protected async readRows(): Promise<readonly MetricSourceRow[]> {
    const rows = await this.prisma.inspectionOrderRecord.findMany({
      where: {
        tenantId: this.tenant,
        kind: { in: ['self_outsourced', 'nonstandard_purchase', 'standard_purchase'] },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row): MetricSourceRow => {
      const judgedAt = row.judgedAt;
      const completed = judgedAt !== null;
      const drawing = trimmed(row.kind === 'standard_purchase' ? row.itemId : row.drawingNo);
      return {
        occurredAt: iso(row.createdAt),
        ...(completed ? { businessTime: iso(judgedAt) } : {}),
        ...(completed
          ? { inspectDate: dayOf(judgedAt), statMonth: monthOf(judgedAt) }
          : { inspectDate: null, statMonth: null }),
        ...(drawing === null ? { drawingNo: null } : { drawingNo: drawing }),
        inspectQty: row.quantity,
        unqualifiedQty: row.failedQty ?? 0,
        completed,
        inspectionId: row.id,
        kind: row.kind,
      };
    });
  }
}

/** 报工 kind → 源字典岗位（r13 三岗位；aftermarket/oddjob 不在岗位字典——行集取舍剔除）。 */
const POSITION_OF_REPORT_KIND: Readonly<Record<string, number>> = {
  part: 1,
  assembly: 2,
  electrical: 3,
};

/**
 * r13 工时汇总事实源（position-hours-facts）→ work_reports 三岗位 kind 只读。
 * 物化：position=岗位字典（1 机加工=part/2 装配=assembly/3 电气=electrical）；
 * approvalStatus=verified→2（审核/审批通过）、revoked→0、其余→1（根过滤=2）；
 * hours=laborMinutes÷60（整数分钟换算小时）；statDate=完工日段（businessTime
 * ——机加工报工完成时间与装配/电气报工日期在本系统同为 businessTime 锚）；
 * processId=工序主数据主键（process_defs 按 operationCode 解析，取同码最高
 * objectVersion；编码空/主数据无对应=null → 工序子表口径剔除、工时仍进主表
 * ——r13 冻结语义）；processCode=报工行 operationCode 快照。
 * 偏差登记（v1，对账阶段校准）：核查修正链（supersedes append-only，原单行
 * 不动）本源不折叠——与 reporting 域自身聚合同口径；撤销单 approvalStatus=0
 * 由根过滤剔除。
 */
export class PgReportCenterPositionHoursMetricSource extends PgStandardReportsSourceBase {
  constructor(prisma: PrismaClient, tenant: TenantId) {
    super(prisma, tenant, 'position-hours-facts');
  }

  protected async readRows(): Promise<readonly MetricSourceRow[]> {
    const reports = await this.prisma.workReportRecord.findMany({
      where: { tenantId: this.tenant, kind: { in: ['part', 'assembly', 'electrical'] } },
      orderBy: { createdAt: 'asc' },
    });
    const processDefs = await this.prisma.processDefRecord.findMany({
      where: { tenantId: this.tenant },
      orderBy: { objectVersion: 'asc' },
    });
    // code → 最高 objectVersion 的主键（含停用——r13 工序列"未删除含停用全量"）。
    const processIdByCode = new Map<string, string>();
    for (const def of processDefs) {
      processIdByCode.set(def.code, def.id);
    }
    return reports.map(
      (row): MetricSourceRow => ({
        occurredAt: iso(row.createdAt),
        businessTime: iso(row.businessTime),
        position: POSITION_OF_REPORT_KIND[row.kind] ?? 0,
        statDate: dayOf(row.businessTime),
        hours: row.laborMinutes / 60,
        approvalStatus: row.state === 'verified' ? 2 : row.state === 'revoked' ? 0 : 1,
        ...(row.operationCode === null
          ? { processId: null, processCode: null }
          : {
              processId: processIdByCode.get(row.operationCode) ?? null,
              processCode: row.operationCode,
            }),
        reportId: row.id,
        dispatchId: row.dispatchId,
        ...(row.workOrderId === null ? { workOrderId: null } : { workOrderId: row.workOrderId }),
      }),
    );
  }
}

/** 采购订单行 JSONB 载荷的防御性解析形状（listing PurchaseOrderLine 镜像——
 *  pg-metric-pack-stores.ts parseOrderLines 未导出，包内不越界改他文件，此处同形镜像）。 */
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

function parseRequestIds(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string');
}

/**
 * r8 逾期交货采购件事实源（purchase-overdue-daily-facts）→ purchase_orders
 * 行级只读（含收货回填 receivedQty——净完成量单口径，r8 冻结语）。行粒度=
 * 订单明细行（orderLineId=订单#行号）。物化：
 *  - partType=源字典数值（1 零件清单/2 标准件清单/3 电气件清单/4 手工清单），
 *    溯源链：订单承接申请（requestIds）→ 优先申请挂靠清单行（sourceListing
 *    LineId → 清单行 → 清单 kind：part→1/standard→2/electrical→3），回落
 *    申请 kind（nonstandard→1/standard→2）；无申请/手工申请→4；设备来源
 *    （equipment）不在 r8 字典 → 整单不纳入（行集取舍）。多申请混合订单取
 *    首申请（v1，对账阶段校准）；申请悬挂（id 无对应行）→ null（未解析组可见）。
 *  - statDate=统计截止日：实时求值形态按读取当日物化（跑批形态默认昨日——
 *    快照冻结语义，调度归后续波 OQ-4）；逾期判定 statDate>=planArrivalDate
 *    （当天即逾期，冻结语义）；
 *  - unInboundQty=max(0, purchaseQty−receivedQty)（每批重算）；overdueQty=
 *    逾期未收齐时的当前未入库量（固化"跨批沿用"需快照表——实时形态以当前
 *    批近似，"已收齐晚完成留存"因此不可辨（无行级收货时刻），随快照表归
 *    后续波，登记）；非逾期/已收齐 → 0 → 根过滤剔除（快照面不变量）。
 *  - businessTime=计划到货日（promisedAt）；occurredAt/availableTime=物化
 *    时刻（快照口径"跑批写入时刻"的实时等价）。draft 态订单与 0 数量行
 *    不纳入（行集取舍）。
 */
export class PgReportCenterPurchaseOverdueDailyMetricSource extends PgStandardReportsSourceBase {
  constructor(prisma: PrismaClient, tenant: TenantId) {
    super(prisma, tenant, 'purchase-overdue-daily-facts');
  }

  protected async readRows(): Promise<readonly MetricSourceRow[]> {
    const orders = await this.prisma.purchaseOrderRecord.findMany({
      where: { tenantId: this.tenant },
      orderBy: { createdAt: 'asc' },
    });
    const requests = await this.prisma.purchaseRequestRecord.findMany({
      where: { tenantId: this.tenant },
    });
    const listingLines = await this.prisma.listingLineRecord.findMany({
      where: { tenantId: this.tenant },
    });
    const listingSheets = await this.prisma.listingSheetRecord.findMany({
      where: { tenantId: this.tenant },
    });
    const requestById = new Map(requests.map((request) => [request.id, request]));
    const sheetKindByLineId = new Map<string, string>();
    for (const line of listingLines) {
      const sheet = listingSheets.find((candidate) => candidate.id === line.sheetId);
      if (sheet !== undefined) sheetKindByLineId.set(line.id, sheet.kind);
    }
    /** 订单 → 清单来源字典值；EXCLUDE 哨兵=设备来源整单不纳入（r8 字典无设备）。 */
    const EXCLUDE = Symbol('equipment-order');
    /** 清单 kind → r8 字典数值；equipment → EXCLUDE；未知 → null（未解析组可见）。 */
    const partTypeOfSheetKind = (kind: string): number | null | typeof EXCLUDE => {
      switch (kind) {
        case 'part':
          return 1;
        case 'standard':
          return 2;
        case 'electrical':
          return 3;
        case 'equipment':
          return EXCLUDE;
        default:
          return null;
      }
    };
    const partTypeByOrder = new Map<string, number | null | typeof EXCLUDE>();
    for (const order of orders) {
      const requestIds = parseRequestIds(order.requestIds);
      if (requestIds.length === 0) {
        partTypeByOrder.set(order.id, 4); // 手工清单（无申请直建）
        continue;
      }
      const request = requestById.get(requestIds[0]!); // 首申请定来源（v1 对账）
      if (request === undefined) {
        partTypeByOrder.set(order.id, null); // 申请悬挂——未解析组可见
        continue;
      }
      if (request.sourceListingLineId !== null) {
        const sheetKind = sheetKindByLineId.get(request.sourceListingLineId);
        if (sheetKind !== undefined) {
          partTypeByOrder.set(order.id, partTypeOfSheetKind(sheetKind));
          continue;
        }
      }
      if (request.sourceType === 'manual') {
        partTypeByOrder.set(order.id, 4); // 手工发起申请
        continue;
      }
      // 回落：申请 kind（电气清单缺口在本系统走 standard 承接——归 2，登记对账；
      // equipment 申请同样不在 r8 字典 → 整单不纳入）
      if (request.kind === 'nonstandard') partTypeByOrder.set(order.id, 1);
      else if (request.kind === 'standard') partTypeByOrder.set(order.id, 2);
      else partTypeByOrder.set(order.id, EXCLUDE);
    }
    const statDate = dayOf(new Date());
    const materializedAt = new Date();
    const rows: MetricSourceRow[] = [];
    for (const order of orders) {
      if (order.state === 'draft') continue; // 未下单不纳入
      const partType = partTypeByOrder.get(order.id) ?? null;
      if (typeof partType === 'symbol') continue; // 设备来源不在 r8 字典
      for (const line of parseOrderLines(order.lines)) {
        if (line.quantity <= 0) continue; // 行订购数量>0 才纳入
        const unInboundQty = Math.max(0, line.quantity - line.receivedQty);
        const overdue = statDate >= dayOf(order.promisedAt);
        rows.push({
          occurredAt: iso(materializedAt),
          availableTime: iso(materializedAt),
          businessTime: iso(order.promisedAt),
          orderLineId: `${order.id}#${String(line.lineNo)}`,
          purchaseOrderId: order.id,
          ...(order.workOrderId === null ? { workOrderId: null } : { workOrderId: order.workOrderId }),
          partType,
          ...(line.drawingNo === null ? { drawingNo: null } : { drawingNo: line.drawingNo }),
          itemId: line.itemId,
          purchaseDate: dayOf(order.createdAt),
          planArrivalDate: dayOf(order.promisedAt),
          purchaseQty: line.quantity,
          unInboundQty,
          overdueQty: overdue ? unInboundQty : 0,
          ...(order.supplierName === null ? { supplierName: null } : { supplierName: order.supplierName }),
          statDate,
        });
      }
    }
    return rows;
  }
}

// ---- 组合根装配工厂 ----

export interface StandardReportsSourcesOptions {
  /** 显式覆盖数据源（缺省读 DATABASE_URL 环境变量，Prisma 原生行为）。 */
  readonly datasourceUrl?: string;
}

/**
 * 源装配句柄：sourceKind → MetricSource 绑定表（标准四源 + 报表中心六源；
 * 喂 application StandardReportsModule 的 reportSourceProviderOf——结构同形）。
 * 租户收口 = 构造注入（组合根按请求租户绑定实例；缓存策略在组合根）。
 */
export interface StandardReportsSourcesHandle {
  readonly sources: Readonly<Record<string, MetricSource>>;
  disconnect(): Promise<void>;
}

/** 构造十 sourceKind（四标准源 + report-center 六源）的 PG 事实源装配（惰性连接：只构造 PrismaClient）。 */
export function connectStandardReportsSources(
  tenant: TenantId,
  options: StandardReportsSourcesOptions = {},
): StandardReportsSourcesHandle {
  const prisma = options.datasourceUrl
    ? new PrismaClient({ datasources: { db: { url: options.datasourceUrl } } })
    : new PrismaClient();
  const client = withRlsTenantSession(prisma, { session: rlsSessionEnabled() });
  return {
    sources: {
      'stock-movement-facts': new PgInventoryMovementsMetricSource(client, tenant),
      'labor-entry-facts': new PgLaborEntryMetricSource(client, tenant),
      'part-dispatch-report-facts': new PgPartDispatchMetricSource(client, tenant),
      'production-receipt-facts': new PgProductionReceiptMetricSource(client, tenant),
      // 报表中心六源（r2/r7/r8/r9/r12/r13——6a-3 裁决 2 补绑定；同一映射喂
      // StandardReportsService 与 ReportCenterReportsService 两服务面）。
      'work-order-facts': new PgReportCenterWorkOrderMetricSource(client, tenant),
      'outsource-delivery-facts': new PgReportCenterOutsourceDeliveryMetricSource(client, tenant),
      'quality-inspect-facts': new PgReportCenterQualityInspectMetricSource(client, tenant),
      'position-hours-facts': new PgReportCenterPositionHoursMetricSource(client, tenant),
      'purchase-overdue-daily-facts': new PgReportCenterPurchaseOverdueDailyMetricSource(client, tenant),
      // r9 与 metric-pack 95 同 sourceKind 同源同根（两包口径声明，pack
      // description 并存登记）——直接复用 metric-pack 适配器，不为同形再立一类。
      'purchase-amount-facts': new PgPurchaseAmountMetricSource(client, tenant),
    },
    async disconnect(): Promise<void> {
      await client.$disconnect();
    },
  };
}
