/**
 * 标准报表口径包（S1 backfill：0920 #89/#91/#92/#96 四张 P3 标准报表）。
 *
 * 清洁室纪律：口径从《机加工MES功能清单-0920.xlsx》功能说明**重述**，不从
 * 现系统抄口径——四条功能描述原文（openpyxl 直读）：
 *   #89 库存报表      —— 按物料统计指定周期内的库存变动与期末现存量。
 *   #91 工作令工时报表 —— 按工作令汇总机加工、装配、电气、售后四类工时，并可下钻到明细。
 *   #92 自制零件派工报工报表 —— 按工作令—设备—模块看自制件派工与报工执行。
 *   #96 自制零件入库日报表 —— 按日/月/年跟踪自制件入库图号产出与入库节奏。
 *
 * 版本化口径包（决策簿"口径包=商业资产"）：packId = standard-reports，
 * 每报表一 metric；口径演进 = 发新包版本（不在包内并存同 id 双版本）。
 * timeBasis 按报表语义选（见各 metric description）；度量字段名与
 * business-store 事实源适配器物化字段一一对应（src/standardreports/
 * pg-standardreports-sources.ts）。
 */
import { defineMetricPack, type MetricPack } from '@smes/engine-reporting';

export const STANDARD_REPORTS_PACK_ID = 'standard-reports';

/**
 * 四张标准报表口径定义（v1）。**降级项如实标注**（数据面不可得的维度/口径，
 * 不硬造——"待数据面补齐"逐条写进 description，总控可追踪）：
 *  - #89：期末现存量 = 无时间下界的净额（库存账=流水恒等式）；子窗口给净变动；
 *    期初余快照暂缺（无 opening-balance 事实面）。
 *  - #92：设备/模块维度暂缺（dispatch_orders 无设备/模块列——现按图号×工序
 *    派发）；降级维度 = 工作令×图号×工序。
 *  - #96：movement 行无图号列（图号在派工/清单侧，未落到流水）——图号产出
 *    降级为物料/工作令维度计数；月/年汇总 = 日报行呈现层聚合（S2）。
 */
export const STANDARD_REPORTS_PACK: MetricPack = defineMetricPack({
  schemaVersion: 1,
  packId: STANDARD_REPORTS_PACK_ID,
  version: 1,
  title: '标准报表（0920 清单 89/91/92/96）',
  description:
    '四张 P3 标准报表的版本化口径包（清洁室重述自 0920 功能清单功能说明）。数据面降级项见各口径 description——如实标注，不硬造。',
  metrics: [
    {
      schemaVersion: 1,
      metricId: 'inventory-movements',
      version: 1,
      display: '库存报表（按物料收发存）',
      description:
        '口径重述（#89）：按物料统计指定周期内的库存变动与期末现存量。received/issued/net 按流水方向归集（调拨出入两行、盘盈亏按方向计入）；期末现存量 = 不设时间下界查询的 net（库存账=流水恒等式）；指定子窗口时 net 为窗口净变动，期初余快照数据面暂缺（待数据面补齐）。',
      timeBasis: 'business',
      sourceKind: 'stock-movement-facts',
      dimensions: [{ field: 'itemId', label: '物料' }],
      measures: [
        { measureId: 'received-qty', aggregation: 'sum', field: 'receivedQty', format: { maximumFractionDigits: 2 } },
        { measureId: 'issued-qty', aggregation: 'sum', field: 'issuedQty', format: { maximumFractionDigits: 2 } },
        { measureId: 'net-qty', aggregation: 'sum', field: 'netQty', format: { maximumFractionDigits: 2 } },
        { measureId: 'movement-count', aggregation: 'count' },
      ],
    },
    {
      schemaVersion: 1,
      metricId: 'workorder-labor-hours',
      version: 1,
      display: '工作令工时报表（四工种）',
      description:
        '口径重述（#91）：按工作令汇总机加工、装配、电气、售后四类工时；冲销条目计负值（净额口径），total 为四类合计。下钻到明细 = 工时账本条目（labor_entries），明细呈现待 S2 报表页面。零工（misc）不挂工作令，不在四类口径内。',
      timeBasis: 'business',
      sourceKind: 'labor-entry-facts',
      dimensions: [{ field: 'workOrderId', label: '工作令' }],
      measures: [
        { measureId: 'machining-hours', aggregation: 'sum', field: 'machiningHours', format: { unit: 'h', maximumFractionDigits: 2 } },
        { measureId: 'assembly-hours', aggregation: 'sum', field: 'assemblyHours', format: { unit: 'h', maximumFractionDigits: 2 } },
        { measureId: 'electrical-hours', aggregation: 'sum', field: 'electricalHours', format: { unit: 'h', maximumFractionDigits: 2 } },
        { measureId: 'aftercare-hours', aggregation: 'sum', field: 'aftercareHours', format: { unit: 'h', maximumFractionDigits: 2 } },
        { measureId: 'total-hours', aggregation: 'sum', field: 'netHours', format: { unit: 'h', maximumFractionDigits: 2 } },
        { measureId: 'entry-count', aggregation: 'count' },
      ],
    },
    {
      schemaVersion: 1,
      metricId: 'part-dispatch-report',
      version: 1,
      display: '自制零件派工报工报表',
      description:
        '口径重述（#92）：按工作令—设备—模块看自制件派工与报工执行。降级维度：工作令×图号×工序（dispatch_orders 无设备/模块列——现按图号×工序派发，设备/模块维度待数据面补齐）；reported = 未撤销报工单 doneQty 合计（撤销单不计）。时间口径 occurred = 派工单创建（派发时刻）。',
      timeBasis: 'occurred',
      sourceKind: 'part-dispatch-report-facts',
      dimensions: [
        { field: 'workOrderId', label: '工作令' },
        { field: 'drawingNo', label: '图号' },
        { field: 'operationCode', label: '工序' },
      ],
      measures: [
        { measureId: 'dispatched-qty', aggregation: 'sum', field: 'dispatchedQty', format: { maximumFractionDigits: 2 } },
        { measureId: 'reported-qty', aggregation: 'sum', field: 'reportedQty', format: { maximumFractionDigits: 2 } },
        { measureId: 'order-count', aggregation: 'count' },
      ],
      filter: { kind: 'compare', op: 'eq', field: 'kind', value: 'part' },
    },
    {
      schemaVersion: 1,
      metricId: 'production-receipt-daily',
      version: 1,
      display: '自制零件入库日报表',
      description:
        '口径重述（#96）：按日跟踪自制件入库产出与入库节奏。v1 口径 = 完工入库（production-in）流水；质检放行入库（inspection-in）混含外协/采购来源、现有表不可区分（待数据面补齐）；movement 行无图号列——图号产出降级为工作令维度计数（drawing-count 缺，待数据面补齐）；月/年汇总 = 日报行呈现层聚合（S2）。',
      timeBasis: 'business',
      sourceKind: 'production-receipt-facts',
      dimensions: [{ field: 'periodDay', label: '日期' }],
      measures: [
        { measureId: 'received-qty', aggregation: 'sum', field: 'receiptQty', format: { maximumFractionDigits: 2 } },
        { measureId: 'movement-count', aggregation: 'count' },
        { measureId: 'work-order-count', aggregation: 'distinct-count', field: 'workOrderId' },
      ],
      filter: { kind: 'compare', op: 'eq', field: 'kind', value: 'production-in' },
    },
  ],
});
