/**
 * 数字运营大屏数据帧契约（PRD 20 册 RREQ-RP-023~026，A8 首波）。
 *
 * 契约形态对齐源文档《数字运营大屏-开发文档.md》§4 的下行 JSON：
 * `{ type: 'digital_operation.snapshot', ts, payload }`；块名沿用源契约
 * （kpi / machiningOnlineSnapshot / dailyProductionOutputByWorkReport /
 * hourlyOutputWipPoints / hourlyInboundInspectionPoints /
 * todayWorkReportRankRows / projectProgressRows）， Cadence 读面映射与
 * 差异逐块写明在 screen.service.ts 头注。
 *
 * 占位语义（PRD §4.5：口径待定项须以「口径待定占位」形态可辨识，不虚构）：
 *  - **definition 占位**（口径待定）：源文档自承假数据（6S/综合得分、关键
 *    里程碑按期率、自制件一次交检合格率、项目行整体进度）——值域按源文档
 *    约定生成，但字段路径登记进 payload.pendingFields，kind='definition'；
 *  - **source 占位**（数据源待接）：Cadence 缺对应域读面的子指标（详见
 *    service 头注"登记不做"清单）——值恒 null，kind='source'。
 * 数值字段统一 `number | null`：null = 该块读面缺失（不静默回 0——空结果
 * 会被误读为"无数据"）。消费端（web 大屏页）对 null 显示「—/数据源待接」。
 */

/** 占位种类：definition=口径待定（假数据，业务口径确认后替换）；source=数据源待接。 */
export type ScreenPendingKind = 'definition' | 'source';

/**
 * 占位字段登记：字段路径 → 占位种类。
 * 路径约定与 JSON payload 点路径一致（如 'kpi.milestoneOnTimeRate'）；
 * 行级字段用块名.字段（如 'projectProgressRows.overallProgress'）。
 */
export type ScreenPendingFields = Readonly<Record<string, ScreenPendingKind>>;

// ---- 顶栏（RREQ-RP-024） ----

export interface ScreenTopBar {
  /** 公司名称两行（静态配置注入，非业务数据）。 */
  readonly companyNameLines: readonly string[];
  /** 安全生产天数：固定基准日至今的日历日差（不扣除），后端算好整数下发。 */
  readonly safeProductionDays: number;
  /** 现场 6S 得分（一位小数）——definition 占位。 */
  readonly sixSScore: number;
  /** 综合得分（一位小数）——definition 占位。 */
  readonly comprehensiveScore: number;
}

// ---- KPI 条（RREQ-RP-024，台套 = 一条工作令计 1） ----

export interface ScreenKpi {
  /** 本月计划发货台套（计划交付日落当月）。 */
  readonly monthlyPlannedDeliverySets: number | null;
  /** 本月已发货台套（实际交付日落当月；实际交付时点物化口径见 service 头注）。 */
  readonly monthlyDeliveredSets: number | null;
  /** 在制工作令（状态非已完成/非已关闭）。 */
  readonly inProgressWorkOrders: number | null;
  /** 关键里程碑按期率（0~1，三位小数）——definition 占位，展示范围 0.85~0.95 含端点。 */
  readonly milestoneOnTimeRate: number;
  /** 本年度下图总数量（零件清单行 createdAt 落本自然年、不去重）——listing 读面缺失时 null。 */
  readonly yearlyDrawingIntakeCount: number | null;
  /** 待机加图号总数（A10 残差公式同源，读 A10 日表最新行）——读面缺失时 null。 */
  readonly pendingMachiningDrawingCount: number | null;
  /** 自制件一次交检合格率（0~1，三位小数）——definition 占位，展示范围 0.90~0.95 含端点。 */
  readonly firstPassYieldRate: number;
}

// ---- 项目进度一览（RREQ-RP-025；行主键 Cadence 映射 = 在制工作令，设备维度缺） ----

/** 延期风险：剩余交期 R（计划交付日−当天，日历日）分档；无计划交付日 = null（屏显「—」）。 */
export type ScreenDeliveryRisk = 'low' | 'mid' | 'high' | null;

/** 已入库/总数 对（任一侧读面缺失 → stored=null，source 占位）。 */
export interface ScreenStoredTotal {
  readonly stored: number | null;
  readonly total: number | null;
}

export interface ScreenProjectProgressRow {
  readonly workOrderId: string;
  readonly projectName: string;
  readonly riskLevel: ScreenDeliveryRisk;
  /** 剩余交期 R（日历日；负数=已逾期；无计划=null）。 */
  readonly remainingDays: number | null;
  /** 整体进度 %（0~100）——definition 占位（业务口径待定）。 */
  readonly overallProgress: number;
  /** 零件（零件清单行计数；入库数读面缺）。 */
  readonly parts: ScreenStoredTotal;
  /** 外购件（清单行加工类型读面缺 → 全 null，source 占位）。 */
  readonly purchasedParts: ScreenStoredTotal;
  /** 电气件（电气清单行计数；入库数读面缺）。 */
  readonly electricalParts: ScreenStoredTotal;
  /** 装配/接线/调试 + 整线接线/整线调试/打包发货：RREQ-RP-030 装配调试进度未实现 → null。 */
  readonly assemblyProgress: number | null;
  readonly wiringProgress: number | null;
  readonly debuggingProgress: number | null;
  readonly lineWiringProgress: number | null;
  readonly lineDebugProgress: number | null;
  readonly packShipProgress: number | null;
}

// ---- 机加·外协·装配 在制快照（RREQ-RP-026 ①） ----

/**
 * 派工单状态码表（源契约 1~4，三表统一；Cadence 状态映射：
 * draft=1 / assigned=2 / executing=3 / done=4；cancelled 不进屏表）。
 */
export type ScreenDispatchStatusCode = 1 | 2 | 3 | 4;

/** 状态灯：off=待派工 / info=已派工 / warn=进行中 / ok=已完成（已派工与已完成不共色）。 */
export type ScreenLed = 'off' | 'info' | 'warn' | 'ok';

/** 状态中文（服务层据码生成，存储/SQL 不落中文——源契约纪律）。 */
export type ScreenDispatchStatusInfo = {
  readonly dispatchStatus: ScreenDispatchStatusCode;
  readonly status: string;
  readonly led: ScreenLed;
};

/** 机加派工行（≤6，updatedAt 倒序）。 */
export interface ScreenMachiningDispatchRow extends ScreenDispatchStatusInfo {
  readonly orderNo: string;
  readonly opName: string | null;
  /** 完工进度 %（doneQty/quantity 向下取整；quantity<=0 → 0）。 */
  readonly progress: number;
}

/** 外协·供应商行（≤3，updatedAt 倒序）。 */
export interface ScreenOutsourceDispatchRow extends ScreenDispatchStatusInfo {
  readonly orderNo: string;
  readonly vendor: string | null;
  readonly progress: number;
}

export interface ScreenMachiningOnlineSnapshot {
  /** 自制执行：非已完成自制派工单总数（assigned+executing）。 */
  readonly selfDispatchedOrderCount: number | null;
  /** 今日产出：自制完工质检合格件数（当日判定合格，SUM 合格数量）。 */
  readonly todayQualifiedOutputQuantity: number | null;
  /** 外协在制：非已完成外协派工单总数（assigned+executing）。 */
  readonly outsourceDispatchedOrderCount: number | null;
  readonly machiningDispatchRows: readonly ScreenMachiningDispatchRow[];
  readonly outsourceDispatchRows: readonly ScreenOutsourceDispatchRow[];
}

/** 装配类型块（按真实类型渲染：Cadence 映射 = 装配派工单工序 operationCode 分组）。 */
export interface ScreenAssemblyTypeCount {
  readonly type: string;
  readonly count: number;
}

export interface ScreenAssemblyDetailRow extends ScreenDispatchStatusInfo {
  readonly orderNo: string;
  readonly opName: string | null;
  readonly progress: number;
}

export interface ScreenAssemblyOnlineSnapshot {
  readonly typeCounts: readonly ScreenAssemblyTypeCount[];
  /** 明细 ≤7（源契约窗口行数）。 */
  readonly detailRows: readonly ScreenAssemblyDetailRow[];
}

// ---- 产出与入库（近 12 天折线，RREQ-RP-026 ②） ----

export interface ScreenDailyOutputPoint {
  /** MM-dd。 */
  readonly dayLabel: string;
  /** yyyy-MM-dd。 */
  readonly date: string;
  /** 当日报工件数合计（无报工日记 0；读面缺失整列 null）。 */
  readonly quantity: number | null;
}

// ---- 当日 13 整点双图（08:00~20:00，RREQ-RP-026 ③） ----

/** 产出/在制（chartRightCombo1 同源块）。 */
export interface ScreenHourlyOutputWipPoint {
  readonly hourFrom: number; // 8~20
  readonly hourLabel: string; // '08:00'
  /** 在制去重键计数（当日派工事件入桶）。 */
  readonly wipDrawingDistinctCount: number | null;
  /** 该小时检验合格件数。 */
  readonly qualifiedQuantity: number | null;
}

/** 入库与质检（chartRightCombo2 同源块）。 */
export interface ScreenHourlyInboundInspectionPoint {
  readonly hourFrom: number;
  readonly hourLabel: string;
  /** 待入库件数——Cadence 无待入库状态读面，恒 null（source 占位）。 */
  readonly pendingStorageQuantity: number | null;
  /** 待检件数（自制未检 + 外协回厂未检 + 采购收货待检，按质检单创建时刻入桶）。 */
  readonly pendingInspectionQuantity: number | null;
  /** 累计检验合格（08:00 起对小时合格序列做前缀和，含当前小时）。 */
  readonly cumulativeQualifiedInspectionQuantity: number | null;
}

// ---- 今日报工排名（html 契约 todayWorkReportRankRows） ----

export interface ScreenWorkReportRankRow {
  /** 申报人显示名（未注入用户名解析端口时回退 reporter id）。 */
  readonly userName: string;
  readonly reporter: string;
  /** 今日净报工件数合计（reported+verified，revoked 不计）。 */
  readonly quantity: number;
}

// ---- 帧载荷 ----

export interface DigitalOperationScreenPayload {
  readonly topBar: ScreenTopBar;
  readonly kpi: ScreenKpi;
  readonly projectProgressRows: readonly ScreenProjectProgressRow[];
  readonly machiningOnlineSnapshot: ScreenMachiningOnlineSnapshot;
  readonly assemblyOnlineSnapshot: ScreenAssemblyOnlineSnapshot;
  readonly dailyProductionOutputByWorkReport: readonly ScreenDailyOutputPoint[];
  readonly hourlyOutputWipPoints: readonly ScreenHourlyOutputWipPoint[];
  readonly hourlyInboundInspectionPoints: readonly ScreenHourlyInboundInspectionPoint[];
  readonly todayWorkReportRankRows: readonly ScreenWorkReportRankRow[];
  /** 占位字段登记（可辨识的口径待定/数据源待接标记）。 */
  readonly pendingFields: ScreenPendingFields;
}

/** 下行帧信封（源契约 type=digital_operation.snapshot）。 */
export interface DigitalOperationScreenEnvelope {
  readonly type: 'digital_operation.snapshot';
  readonly ts: number;
  readonly payload: DigitalOperationScreenPayload;
}

/** 状态码 → 展示/灯（服务层映射的唯一出处）。 */
export const SCREEN_DISPATCH_STATUS_INFO: Readonly<
  Record<ScreenDispatchStatusCode, { readonly status: string; readonly led: ScreenLed }>
> = {
  1: { status: '待派工', led: 'off' },
  2: { status: '已派工', led: 'info' },
  3: { status: '进行中', led: 'warn' },
  4: { status: '已完成', led: 'ok' },
};
