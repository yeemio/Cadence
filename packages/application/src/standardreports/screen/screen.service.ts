/**
 * DigitalOperationScreenService —— 数字运营大屏数据帧聚合用例（A8 首波，
 * PRD 20 册 RREQ-RP-023~026；零框架业务类，调度/通道归组合根 screen 模块）。
 *
 * == Cadence 读面映射（源文档口径 → 本仓事实面，逐块写明） ==
 *  - 台套 = 一条工作令计 1（源 §2.2）。
 *  - KPI① 计划发货 = work_orders.plannedDeliveryAt 落当月（UTC 月份）。
 *  - KPI② 已发货：Cadence 工作令行无实际交付列——**实际交付时点物化 =
 *    packagingArrivalAt**（与 #90 workorder-delivery-facts 适配器同源先例，
 *    pg-metric-pack-stores.ts:370）。
 *  - KPI③ 在制 = state ∉ {completed, closed}（源：非已完成(9)/非已关闭(10)）。
 *  - KPI⑤ 年度下图 = ListingLineStore.countPartLinesCreatedBetween（A9 同源
 *    端口；PG 适配器未实现该可选成员时 → source 占位）。
 *  - KPI⑥ 待机加 = A10 日表最新行 pendingMachiningCount（同源残差公式，
 *    machining-daily.service.ts 头注——两指标读面缺失现为 null 占位）。
 *  - 派工状态码表：draft=1 待派工/assigned=2 已派工/executing=3 进行中/
 *    done=4 已完成；cancelled 源码表无位、不进屏表。非已完成计数
 *    （自制执行/外协在制）= assigned+executing（源 dispatch_status IN (2,3)）。
 *  - 今日产出 = 质检单 kind=self_outsourced ∧ sourceType='report'（源
 *    inspection_source=1 自制完工）∧ state='passed'（已质检合格）∧ judgedAt
 *    当日，SUM passedQty（源 SUM qualified_quantity）。
 *  - 12 天产出折线 = 报工链尾行 state ∈ {reported, verified}（revoked 冲销
 *    不计——REPORT_OUTPUT_STATES 同口径）按 businessTime UTC 日历日 SUM
 *    doneQty；缺日补 0。
 *  - 在制小时桶（§2.5）：三域单 state ∈ {assigned, executing, done}（源
 *    ">1"）按**派工时刻**入当日小时桶；Cadence 派工单行无派工时刻列（源
 *    机加主表亦无 dispatch_time 用 create_time）——统一 **createdAt**。
 *    去重键：机加 'm:'+图号（缺图号 'i'+单 id）、外协 'o:'+明细行图号（缺
 *    'i'+明细 id）、装配 'a:'+单 id；COUNT DISTINCT。
 *  - 小时合格（§2.5/§2.6 折线）= state='passed' ∧ judgedAt 当日小时
 *    SUM passedQty（不限来源——源不限制 inspection_source）；累计 = 08:00
 *    起前缀和含当前小时。
 *  - 待检（§2.6 三支）= state='pending' ∧ sourceType ∈ {report 自制, dispatch
 *    外协回厂, receipt 采购收货} 按 createdAt 入桶 SUM quantity（源①件数取
 *    报工数量/③取收货行合计——Cadence 质检单 quantity 即创建时送检数量）。
 *  - 延期风险（§2.3 选项 A）：R = plannedDeliveryAt − 当天（UTC 日历日）；
 *    低 0≤R≤7 / 中 8≤R≤14 / 高 R≥15 或 R<0；无计划 = null。
 *  - 项目进度行主键：源 = 工作令×设备（mes_work_purchase）；Cadence 清单
 *    无设备维度 → **一行一在制工作令**（设备列缺，差异登记）。
 *
 * == 登记不做（缺读面子指标 → source 占位，不虚构） ==
 *  - 待入库小时桶（§2.6 左轴黄柱）：Cadence inventory 无"待入库"状态读面
 *    （出入库流水为已发生事实），inventory 域在途禁碰 → pendingStorage 恒 null。
 *  - 项目进度：零件/电气件**已入库数**（清单行无入库状态列）、外购件两数
 *    （无 processing_type 列）、装配~打包发货六列（RREQ-RP-030 未实现）。
 *
 * == definition 占位（源文档假数据，值域按源约定、显式登记） ==
 *  - 6S/综合得分（一位小数；值域 90.0~99.9 为实现约定——源未给范围）；
 *    关键里程碑按期率 0.850~0.950 三位小数含端点；一次交检合格率
 *    0.900~0.950 三位小数含端点；项目行整体进度 0~100。确定性伪随机
 *    （时间桶+键哈希，帧间缓变不跳变），口径确认后替换为本体实现。
 *
 * 时区口径：日/小时桶与月份判定统一 **UTC**（与 reporting.outputTrend 的
 * businessTime UTC 日期同口径）；now 可注入（测试锚定）。
 */
import type { TenantId } from '@smes/business-core';
import { REPORT_OUTPUT_STATES } from '../../reporting/reporting-config.js';
import type { DispatchOrder } from '../../dispatch/dispatch-stores.js';
import type { WorkOrder } from '../../workorder/workorder-stores.js';
import {
  DEFAULT_SCREEN_CONFIG,
  type DigitalOperationScreenConfig,
  type ScreenSourceStores,
} from './screen-ports.js';
import type {
  DigitalOperationScreenEnvelope,
  DigitalOperationScreenPayload,
  ScreenAssemblyDetailRow,
  ScreenAssemblyOnlineSnapshot,
  ScreenAssemblyTypeCount,
  ScreenDailyOutputPoint,
  ScreenDeliveryRisk,
  ScreenDispatchStatusCode,
  ScreenHourlyInboundInspectionPoint,
  ScreenHourlyOutputWipPoint,
  ScreenKpi,
  ScreenLed,
  ScreenMachiningDispatchRow,
  ScreenMachiningOnlineSnapshot,
  ScreenOutsourceDispatchRow,
  ScreenPendingFields,
  ScreenProjectProgressRow,
  ScreenStoredTotal,
  ScreenTopBar,
  ScreenWorkReportRankRow,
} from './screen-payload.js';
import { SCREEN_DISPATCH_STATUS_INFO } from './screen-payload.js';

/** 源契约行窗口：机加表 6 / 外协表 3 / 装配明细 7（v1.5/v1.6 定稿）。 */
const MACHINING_ROWS_LIMIT = 6;
const OUTSOURCE_ROWS_LIMIT = 3;
const ASSEMBLY_ROWS_LIMIT = 7;
/** 当日小时窗 08:00~20:00 共 13 整点（源 §2.5/§2.6）。 */
const HOUR_FROM = 8;
const HOUR_TO = 20;

/** 在制快照计数口径：非已完成 = 已派工+进行中（源 dispatch_status IN (2,3)）。 */
const ACTIVE_DISPATCH_STATES: ReadonlySet<string> = new Set(['assigned', 'executing']);
/** 小时桶在制口径：已派工起（源 dispatch_status > 1 → 2/3/4）。 */
const BUCKETED_DISPATCH_STATES: ReadonlySet<string> = new Set(['assigned', 'executing', 'done']);
/** 屏表收纳状态（cancelled 无码位，不进表）。 */
const SCREEN_TABLE_STATES: ReadonlySet<string> = new Set(['draft', 'assigned', 'executing', 'done']);

export class DigitalOperationScreenService {
  private readonly config: Required<DigitalOperationScreenConfig>;

  constructor(
    private readonly sources: ScreenSourceStores = {},
    config: DigitalOperationScreenConfig = {},
  ) {
    this.config = { ...DEFAULT_SCREEN_CONFIG, ...config };
  }

  /** 聚合一帧（tenant 收口；now 注入测试锚定）。 */
  async buildFrame(
    tenant: TenantId,
    now: string = new Date().toISOString(),
  ): Promise<DigitalOperationScreenEnvelope> {
    const pending: Record<string, ScreenPendingFields[string]> = {};
    const nowDate = new Date(now);
    const todayKey = nowDate.toISOString().slice(0, 10);
    const currentMonth = todayKey.slice(0, 7);

    // ---- 并行取面（面缺 → undefined，逐块降级） ----
    const [orders, dispatches, reports, inspections] = await Promise.all([
      this.sources.workOrders?.list(tenant) ?? Promise.resolve(undefined),
      this.sources.dispatchOrders?.list(tenant) ?? Promise.resolve(undefined),
      this.sources.workReports?.list(tenant) ?? Promise.resolve(undefined),
      this.sources.inspections?.list(tenant) ?? Promise.resolve(undefined),
    ]);

    const topBar = this.buildTopBar(nowDate, pending);
    const kpi = await this.buildKpi(tenant, orders, currentMonth, nowDate, pending);
    const progressRows = await this.buildProjectProgress(tenant, orders, todayKey, nowDate, pending);
    const machining = await this.buildMachiningSnapshot(
      tenant,
      dispatches,
      inspections,
      todayKey,
      pending,
    );
    const assembly = this.buildAssemblySnapshot(dispatches, pending);
    const dailyOutput = this.buildDailyOutput(reports, todayKey, pending);
    const hourlyOutput = await this.buildHourlyOutputWip(tenant, dispatches, inspections, todayKey, pending);
    const hourlyInbound = this.buildHourlyInbound(inspections, todayKey, pending);
    const rank = await this.buildRank(tenant, reports, todayKey);

    const payload: DigitalOperationScreenPayload = {
      topBar,
      kpi,
      projectProgressRows: progressRows,
      machiningOnlineSnapshot: machining,
      assemblyOnlineSnapshot: assembly,
      dailyProductionOutputByWorkReport: dailyOutput,
      hourlyOutputWipPoints: hourlyOutput,
      hourlyInboundInspectionPoints: hourlyInbound,
      todayWorkReportRankRows: rank,
      pendingFields: pending,
    };
    return { type: 'digital_operation.snapshot', ts: nowDate.getTime(), payload };
  }

  // ---- 顶栏 ----

  private buildTopBar(now: Date, pending: Record<string, ScreenPendingFields[string]>): ScreenTopBar {
    const baseline = Date.parse(`${this.config.safeProductionBaselineDate}T00:00:00.000Z`);
    const safeDays = Math.trunc((now.getTime() - baseline) / 86_400_000);
    const daySeed = `${now.toISOString().slice(0, 10)}|6s`;
    const scoreSeed = `${now.toISOString().slice(0, 10)}|composite`;
    // definition 占位（值域 90.0~99.9 一位小数，日桶确定性——实现约定，源未给范围）
    pending['topBar.sixSScore'] = 'definition';
    pending['topBar.comprehensiveScore'] = 'definition';
    return {
      companyNameLines: this.config.companyNameLines,
      safeProductionDays: Math.max(0, safeDays),
      sixSScore: 90 + (hashOf(daySeed) % 100) / 10,
      comprehensiveScore: 90 + (hashOf(scoreSeed) % 100) / 10,
    };
  }

  // ---- KPI 七项 ----

  private async buildKpi(
    tenant: TenantId,
    orders: readonly WorkOrder[] | undefined,
    currentMonth: string,
    now: Date,
    pending: Record<string, ScreenPendingFields[string]>,
  ): Promise<ScreenKpi> {
    let plannedSets: number | null = null;
    let deliveredSets: number | null = null;
    let inProgress: number | null = null;
    if (orders !== undefined) {
      plannedSets = orders.filter((order) => (order.plannedDeliveryAt ?? '').slice(0, 7) === currentMonth).length;
      // 实际交付时点物化 = packagingArrivalAt（#90 同源；service 头注）
      deliveredSets = orders.filter((order) => (order.packagingArrivalAt ?? '').slice(0, 7) === currentMonth).length;
      inProgress = orders.filter((order) => order.state !== 'completed' && order.state !== 'closed').length;
    } else {
      pending['kpi.monthlyPlannedDeliverySets'] = 'source';
      pending['kpi.monthlyDeliveredSets'] = 'source';
      pending['kpi.inProgressWorkOrders'] = 'source';
    }

    // KPI⑤：A9 同源计数端口（可选成员——PG 适配器未实现 → undefined → 占位）
    let yearlyIntake: number | null = null;
    const year = currentMonth.slice(0, 4);
    const counted = await this.sources.listingLines?.countPartLinesCreatedBetween?.(tenant, {
      fromDay: `${year}-01-01`,
      toDay: `${year}-12-31`,
    });
    if (counted !== undefined) {
      yearlyIntake = counted;
    } else {
      pending['kpi.yearlyDrawingIntakeCount'] = 'source';
    }

    // KPI⑥：A10 日表最新行（读面缺失 → 行内值 null 或无行 → 占位）
    let pendingMachining: number | null = null;
    const latestDaily = await this.sources.machiningDailyStats?.findLatest(tenant);
    if (latestDaily !== undefined && latestDaily !== null && latestDaily.pendingMachiningCount !== null) {
      pendingMachining = latestDaily.pendingMachiningCount;
    } else {
      pending['kpi.pendingMachiningDrawingCount'] = 'source';
    }

    // definition 占位：范围含端点三位小数，分钟桶缓变
    const minuteSeed = `${Math.floor(now.getTime() / 60_000)}`;
    pending['kpi.milestoneOnTimeRate'] = 'definition';
    pending['kpi.firstPassYieldRate'] = 'definition';
    return {
      monthlyPlannedDeliverySets: plannedSets,
      monthlyDeliveredSets: deliveredSets,
      inProgressWorkOrders: inProgress,
      milestoneOnTimeRate: 0.85 + (hashOf(`milestone|${minuteSeed}`) % 101) / 1000,
      yearlyDrawingIntakeCount: yearlyIntake,
      pendingMachiningDrawingCount: pendingMachining,
      firstPassYieldRate: 0.9 + (hashOf(`fpYield|${minuteSeed}`) % 51) / 1000,
    };
  }

  // ---- 项目进度一览（行主键 = 在制工作令；设备维度差异登记） ----

  private async buildProjectProgress(
    tenant: TenantId,
    orders: readonly WorkOrder[] | undefined,
    todayKey: string,
    now: Date,
    pending: Record<string, ScreenPendingFields[string]>,
  ): Promise<readonly ScreenProjectProgressRow[]> {
    if (orders === undefined) {
      pending['projectProgressRows'] = 'source';
      return [];
    }
    const inProgress = orders.filter((order) => order.state !== 'completed' && order.state !== 'closed');
    if (inProgress.length === 0) return [];

    const listingFace = this.sources.listingLines;
    const rows: ScreenProjectProgressRow[] = [];
    for (const order of inProgress) {
      let parts: ScreenStoredTotal = { stored: null, total: null };
      let electrical: ScreenStoredTotal = { stored: null, total: null };
      if (listingFace !== undefined) {
        const lines = await listingFace.listByWorkOrder(tenant, order.id);
        parts = { stored: null, total: lines.filter((line) => line.kind === 'part').length };
        electrical = { stored: null, total: lines.filter((line) => line.kind === 'electrical').length };
      }
      rows.push({
        workOrderId: order.id,
        projectName: order.projectName,
        riskLevel: riskLevelOf(order, todayKey),
        remainingDays: remainingDaysOf(order, todayKey),
        overallProgress: hashOf(`overall|${order.id}|${todayKey}`) % 101,
        parts,
        purchasedParts: { stored: null, total: null },
        electricalParts: electrical,
        assemblyProgress: null,
        wiringProgress: null,
        debuggingProgress: null,
        lineWiringProgress: null,
        lineDebugProgress: null,
        packShipProgress: null,
      });
    }
    // 占位登记（按列登记一次，不逐行重复）
    pending['projectProgressRows.overallProgress'] = 'definition';
    if (listingFace === undefined) {
      pending['projectProgressRows.parts.total'] = 'source';
      pending['projectProgressRows.electricalParts.total'] = 'source';
    }
    pending['projectProgressRows.parts.stored'] = 'source';
    pending['projectProgressRows.purchasedParts'] = 'source';
    pending['projectProgressRows.electricalParts.stored'] = 'source';
    pending['projectProgressRows.assemblyProgress'] = 'source';
    pending['projectProgressRows.wiringProgress'] = 'source';
    pending['projectProgressRows.debuggingProgress'] = 'source';
    pending['projectProgressRows.lineWiringProgress'] = 'source';
    pending['projectProgressRows.lineDebugProgress'] = 'source';
    pending['projectProgressRows.packShipProgress'] = 'source';
    return rows;
  }

  // ---- 机加·外协 在制快照 ----

  private async buildMachiningSnapshot(
    tenant: TenantId,
    dispatches: readonly DispatchOrder[] | undefined,
    inspections: Awaited<ReturnType<NonNullable<ScreenSourceStores['inspections']>['list']>> | undefined,
    todayKey: string,
    pending: Record<string, ScreenPendingFields[string]>,
  ): Promise<ScreenMachiningOnlineSnapshot> {
    let selfCount: number | null = null;
    let outsourceCount: number | null = null;
    let machiningRows: readonly ScreenMachiningDispatchRow[] = [];
    let outsourceRows: readonly ScreenOutsourceDispatchRow[] = [];
    if (dispatches !== undefined) {
      const parts = dispatches.filter((order) => order.kind === 'part');
      const outsources = dispatches.filter((order) => order.kind === 'outsourcing');
      selfCount = parts.filter((order) => ACTIVE_DISPATCH_STATES.has(order.state)).length;
      outsourceCount = outsources.filter((order) => ACTIVE_DISPATCH_STATES.has(order.state)).length;

      machiningRows = parts
        .filter((order) => SCREEN_TABLE_STATES.has(order.state))
        .sort(byUpdatedDesc)
        .slice(0, MACHINING_ROWS_LIMIT)
        .map((order) => ({
          orderNo: order.id,
          opName: order.operationCode,
          progress: progressPercent(order),
          ...statusInfoOf(order.state),
        }));

      const topOutsources = outsources
        .filter((order) => SCREEN_TABLE_STATES.has(order.state))
        .sort(byUpdatedDesc)
        .slice(0, OUTSOURCE_ROWS_LIMIT);
      outsourceRows = [];
      for (const order of topOutsources) {
        const lines =
          (await this.sources.outsourcingLines?.listByDispatch(tenant, order.id).then((rows) =>
            rows.length > 0 ? rows[0] : undefined,
          )) ?? undefined;
        outsourceRows = [
          ...outsourceRows,
          {
            orderNo: order.id,
            vendor: lines?.supplierName ?? null,
            progress: progressPercent(order),
            ...statusInfoOf(order.state),
          },
        ];
      }
    } else {
      pending['machiningOnlineSnapshot.selfDispatchedOrderCount'] = 'source';
      pending['machiningOnlineSnapshot.outsourceDispatchedOrderCount'] = 'source';
      pending['machiningOnlineSnapshot.machiningDispatchRows'] = 'source';
      pending['machiningOnlineSnapshot.outsourceDispatchRows'] = 'source';
    }

    let todayQualified: number | null = null;
    if (inspections !== undefined) {
      todayQualified = inspections
        .filter(
          (order) =>
            order.kind === 'self_outsourced' &&
            order.sourceType === 'report' &&
            order.state === 'passed' &&
            (order.judgedAt ?? '').slice(0, 10) === todayKey,
        )
        .reduce((sum, order) => sum + (order.passedQty ?? 0), 0);
    } else {
      pending['machiningOnlineSnapshot.todayQualifiedOutputQuantity'] = 'source';
    }
    return {
      selfDispatchedOrderCount: selfCount,
      todayQualifiedOutputQuantity: todayQualified,
      outsourceDispatchedOrderCount: outsourceCount,
      machiningDispatchRows: machiningRows,
      outsourceDispatchRows: outsourceRows,
    };
  }

  // ---- 装配 类型块 + 明细 ----

  private buildAssemblySnapshot(
    dispatches: readonly DispatchOrder[] | undefined,
    pending: Record<string, ScreenPendingFields[string]>,
  ): ScreenAssemblyOnlineSnapshot {
    if (dispatches === undefined) {
      pending['assemblyOnlineSnapshot'] = 'source';
      return { typeCounts: [], detailRows: [] };
    }
    const rows = dispatches.filter((order) => order.kind === 'assembly' && SCREEN_TABLE_STATES.has(order.state));
    const byType = new Map<string, number>();
    for (const order of rows) {
      const type = order.operationCode ?? order.title;
      byType.set(type, (byType.get(type) ?? 0) + 1);
    }
    const typeCounts: readonly ScreenAssemblyTypeCount[] = [...byType.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
    const detailRows: readonly ScreenAssemblyDetailRow[] = [...rows]
      .sort(byUpdatedDesc)
      .slice(0, ASSEMBLY_ROWS_LIMIT)
      .map((order) => ({
        orderNo: order.id,
        opName: order.operationCode,
        progress: progressPercent(order),
        ...statusInfoOf(order.state),
      }));
    return { typeCounts, detailRows };
  }

  // ---- 产出与入库（近 12 天折线） ----

  private buildDailyOutput(
    reports: Awaited<ReturnType<NonNullable<ScreenSourceStores['workReports']>['list']>> | undefined,
    todayKey: string,
    pending: Record<string, ScreenPendingFields[string]>,
  ): readonly ScreenDailyOutputPoint[] {
    const windowDays = this.config.dailyOutputWindowDays;
    const todayMs = Date.parse(`${todayKey}T00:00:00.000Z`);
    const points: ScreenDailyOutputPoint[] = [];
    if (reports === undefined) {
      pending['dailyProductionOutputByWorkReport'] = 'source';
      for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
        const date = new Date(todayMs - offset * 86_400_000).toISOString().slice(0, 10);
        points.push({ dayLabel: date.slice(5), date, quantity: null });
      }
      return points;
    }
    const byDay = new Map<string, number>();
    for (const report of reports) {
      if (!REPORT_OUTPUT_STATES.has(report.state)) continue;
      const key = report.businessTime.slice(0, 10);
      byDay.set(key, (byDay.get(key) ?? 0) + report.doneQty);
    }
    for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
      const date = new Date(todayMs - offset * 86_400_000).toISOString().slice(0, 10);
      points.push({ dayLabel: date.slice(5), date, quantity: byDay.get(date) ?? 0 });
    }
    return points;
  }

  // ---- 当日 13 整点：产出/在制 ----

  private async buildHourlyOutputWip(
    tenant: TenantId,
    dispatches: readonly DispatchOrder[] | undefined,
    inspections: Awaited<ReturnType<NonNullable<ScreenSourceStores['inspections']>['list']>> | undefined,
    todayKey: string,
    pending: Record<string, ScreenPendingFields[string]>,
  ): Promise<readonly ScreenHourlyOutputWipPoint[]> {
    // 在制去重键需外协明细行（o: 前缀）——明细面缺 → 键集不完整 → 整列占位。
    const wipFaceReady = dispatches !== undefined && this.sources.outsourcingLines !== undefined;
    const qualifiedFaceReady = inspections !== undefined;
    if (!wipFaceReady) pending['hourlyOutputWipPoints.wipDrawingDistinctCount'] = 'source';
    if (!qualifiedFaceReady) pending['hourlyOutputWipPoints.qualifiedQuantity'] = 'source';

    const keysByHour = new Map<number, Set<string>>();
    if (wipFaceReady) {
      for (const order of dispatches!) {
        if (!BUCKETED_DISPATCH_STATES.has(order.state)) continue;
        const hour = hourBucketOf(order.createdAt, todayKey);
        if (hour === null) continue;
        const bucket = keysByHour.get(hour) ?? new Set<string>();
        if (order.kind === 'part') {
          bucket.add(`m:${order.drawingNo ?? `i${order.id}`}`);
        } else if (order.kind === 'outsourcing') {
          const lines = await this.sources.outsourcingLines!.listByDispatch(tenant, order.id);
          if (lines.length === 0) bucket.add(`o:i${order.id}`);
          for (const line of lines) bucket.add(`o:${line.drawingNo ?? `i${line.id}`}`);
        } else if (order.kind === 'assembly') {
          bucket.add(`a:${order.id}`);
        } else {
          continue; // 售后/零工/电气不进三域在制口径（§2.5：机加/外协/装配）
        }
        keysByHour.set(hour, bucket);
      }
    }

    const qualifiedByHour = new Map<number, number>();
    if (qualifiedFaceReady) {
      for (const order of inspections!) {
        if (order.state !== 'passed') continue;
        const hour = hourBucketOf(order.judgedAt, todayKey);
        if (hour === null) continue;
        qualifiedByHour.set(hour, (qualifiedByHour.get(hour) ?? 0) + (order.passedQty ?? 0));
      }
    }

    return hourSlots().map(({ hour, label }) => ({
      hourFrom: hour,
      hourLabel: label,
      wipDrawingDistinctCount: wipFaceReady ? (keysByHour.get(hour)?.size ?? 0) : null,
      qualifiedQuantity: qualifiedFaceReady ? (qualifiedByHour.get(hour) ?? 0) : null,
    }));
  }

  // ---- 当日 13 整点：入库与质检 ----

  private buildHourlyInbound(
    inspections: Awaited<ReturnType<NonNullable<ScreenSourceStores['inspections']>['list']>> | undefined,
    todayKey: string,
    pending: Record<string, ScreenPendingFields[string]>,
  ): readonly ScreenHourlyInboundInspectionPoint[] {
    // 待入库：inventory 无待入库状态读面（在途禁碰）——恒占位。
    pending['hourlyInboundInspectionPoints.pendingStorageQuantity'] = 'source';
    const inspectionFaceReady = inspections !== undefined;
    if (!inspectionFaceReady) {
      pending['hourlyInboundInspectionPoints.pendingInspectionQuantity'] = 'source';
      pending['hourlyInboundInspectionPoints.cumulativeQualifiedInspectionQuantity'] = 'source';
    }

    const pendingByHour = new Map<number, number>();
    const qualifiedByHour = new Map<number, number>();
    if (inspectionFaceReady) {
      for (const order of inspections!) {
        if (order.state === 'pending' && order.sourceType !== null) {
          const hour = hourBucketOf(order.createdAt, todayKey);
          if (hour !== null) {
            pendingByHour.set(hour, (pendingByHour.get(hour) ?? 0) + order.quantity);
          }
        }
        if (order.state === 'passed') {
          const hour = hourBucketOf(order.judgedAt, todayKey);
          if (hour !== null) {
            qualifiedByHour.set(hour, (qualifiedByHour.get(hour) ?? 0) + (order.passedQty ?? 0));
          }
        }
      }
    }

    let cumulative = 0;
    return hourSlots().map(({ hour, label }) => {
      if (inspectionFaceReady) cumulative += qualifiedByHour.get(hour) ?? 0;
      return {
        hourFrom: hour,
        hourLabel: label,
        pendingStorageQuantity: null,
        pendingInspectionQuantity: inspectionFaceReady ? (pendingByHour.get(hour) ?? 0) : null,
        cumulativeQualifiedInspectionQuantity: inspectionFaceReady ? cumulative : null,
      };
    });
  }

  // ---- 今日报工排名 ----

  private async buildRank(
    tenant: TenantId,
    reports: Awaited<ReturnType<NonNullable<ScreenSourceStores['workReports']>['list']>> | undefined,
    todayKey: string,
  ): Promise<readonly ScreenWorkReportRankRow[]> {
    if (reports === undefined) return [];
    const byReporter = new Map<string, number>();
    for (const report of reports) {
      if (!REPORT_OUTPUT_STATES.has(report.state)) continue;
      if (report.businessTime.slice(0, 10) !== todayKey) continue;
      byReporter.set(report.reporter, (byReporter.get(report.reporter) ?? 0) + report.doneQty);
    }
    const top = [...byReporter.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, this.config.rankLimit);
    const rows: ScreenWorkReportRankRow[] = [];
    for (const [reporter, quantity] of top) {
      const displayName = (await this.sources.userNameOf?.(tenant, reporter)) ?? null;
      rows.push({ userName: displayName ?? reporter, reporter, quantity });
    }
    return rows;
  }
}

// ---- 纯辅助（导出供测试锚定） ----

/** 派工单状态 → 源码表（1~4）；非表内状态（cancelled/未知）返回 null。 */
export function screenDispatchStatusCode(state: string): ScreenDispatchStatusCode | null {
  switch (state) {
    case 'draft':
      return 1;
    case 'assigned':
      return 2;
    case 'executing':
      return 3;
    case 'done':
      return 4;
    default:
      return null;
  }
}

function statusInfoOf(state: string): {
  dispatchStatus: ScreenDispatchStatusCode;
  status: string;
  led: ScreenLed;
} {
  const code = screenDispatchStatusCode(state) ?? 1;
  return { dispatchStatus: code, ...SCREEN_DISPATCH_STATUS_INFO[code] };
}

/** 完工进度 %（quantity<=0 → 0；向下取整）。 */
export function progressPercent(order: DispatchOrder): number {
  return order.quantity > 0 ? Math.floor((order.doneQty / order.quantity) * 100) : 0;
}

/** 剩余交期 R（UTC 日历日；无计划/坏日期 → null）。 */
export function remainingDaysOf(order: WorkOrder, todayKey: string): number | null {
  if (order.plannedDeliveryAt === null) return null;
  const planned = Date.parse(`${order.plannedDeliveryAt.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(planned)) return null;
  return Math.trunc((planned - Date.parse(`${todayKey}T00:00:00.000Z`)) / 86_400_000);
}

/** 延期风险分档（§2.3 选项 A：低 0~7 / 中 8~14 / 高 ≥15 或已逾期；无计划 null）。 */
export function riskLevelOf(order: WorkOrder, todayKey: string): ScreenDeliveryRisk {
  const remaining = remainingDaysOf(order, todayKey);
  if (remaining === null) return null;
  if (remaining < 0) return 'high';
  if (remaining <= 7) return 'low';
  if (remaining <= 14) return 'mid';
  return 'high';
}

/** 时刻 → 当日小时桶（8~20 命中；非当日/窗内无命中 → null）。 */
export function hourBucketOf(iso: string | null, todayKey: string): number | null {
  if (iso === null || iso.slice(0, 10) !== todayKey) return null;
  const hour = new Date(iso).getUTCHours();
  return hour >= HOUR_FROM && hour <= HOUR_TO ? hour : null;
}

function hourSlots(): readonly { readonly hour: number; readonly label: string }[] {
  const slots: { hour: number; label: string }[] = [];
  for (let hour = HOUR_FROM; hour <= HOUR_TO; hour += 1) {
    slots.push({ hour, label: `${String(hour).padStart(2, '0')}:00` });
  }
  return slots;
}

function byUpdatedDesc(a: DispatchOrder, b: DispatchOrder): number {
  return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id.localeCompare(b.id);
}

/** FNV-1a 32 位（definition 占位的确定性伪随机源；非安全用途）。 */
export function hashOf(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
