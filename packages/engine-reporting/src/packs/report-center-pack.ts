/**
 * 报表中心预置口径包（U 波：r2/r7/r12/r13 四张报表；v2 追加 r8；v3 追加
 * r9 采购件汇总主口径 + r7 下钻明细口径——功能补齐第一波）。
 *
 * 定位声明（ADR-0010 自证边界）：本文件是**预置口径集（纯数据）**，不是引擎
 * 机制——引擎（filter/definition/evaluate/pack）零改动、不含任何硬编码口径；
 * "行业差异 = 另一份口径包"在此落地为一份随包分发的数据文件。v2 起经包根
 * index.ts 转出口（消费接线波已至：application standardreports 组合引用本包
 * 冻结口径——单一事实源，不在消费侧重述）。
 *
 * 清洁室纪律：口径自需求开发文档**重述**（报表/工作令交付报表 r2、外协零件
 * 交货情况汇总 r7、逾期交货采购件报表 r8、质检汇总报表 r12、工时汇总报表
 * r13、采购件情况汇总表 r9——Owner 解禁的正式需求输入），不抄现系统 SQL。
 * 原系统表名（mes_*）仅在 description 中作溯源对照，行字段一律用本引擎
 * camelCase 词汇。
 *
 * 快照口径冻结范围（U 波合同）：跑批类（r7/r8/r12/r13）本版**只冻结口径定义**
 * ——跑批策略（JobHandler/Cron/入参/删除重入）逐条写进 metric description；
 * 调度实现与快照表落库归后续波（OQ-4）。粒度取舍：引擎不支持分组粒度粗化
 * （月去重 ≠ 日图号数相加、工序分列 ≠ 岗位合计），故 r12 拆日/月两条、r13 拆
 * 主表/工序子表两条口径——一条报表口径 = 其全部粒度定义的集合。包版本演进
 * （体例）：v1 = r2/r7/r12/r13 六条；v2 纯追加 r8 明细行日快照一条；v3 纯追加
 * r9 采购件汇总（A4 部分）+ r7 下钻明细两条，既有七条不变。
 */
import { defineMetricPack, type MetricPack } from '../pack.js';

export const REPORT_CENTER_PACK_ID = 'report-center';

/**
 * 六张报表 × 九条粒度口径（v3）。快照/降级口径如实写进各 metric description：
 *  - r2  工作令交付：实时无跑批；business=实际交付（未交付行回落行创建）。
 *  - r7  外协交货汇总：月×供应商；按期率为派生指标（呈现层由两度量计算）；
 *      v3 追加未按期交货明细下钻口径（呈现层弹窗用）。
 *  - r8  逾期交货采购件：**明细行粒度日快照**（与既有订单头粒度催货事实面
 *     并存）；未入库数量每批重算、逾期零件数量一次性固化跨批沿用。
 *  - r12 质检汇总：日/月两粒度分立（当月图号去重 ≠ 各日图号数相加）。
 *  - r13 工时汇总：主表（岗位×日）+ 工序子表（机加工分列）两粒度分立；
 *     无法解析工序的机加工工时只进主表口径。
 *  - r9  采购件情况汇总（v3，A4 部分）：工作令×零件类型的订单数/采购金额
 *     汇总（实时求值形态；源文档跑批快照形态归后续波）。
 */
export const REPORT_CENTER_PACK: MetricPack = defineMetricPack({
  schemaVersion: 1,
  packId: REPORT_CENTER_PACK_ID,
  version: 3,
  title: '报表中心口径包（r2/r7/r8/r9/r12/r13）',
  description:
    '报表中心六张报表的版本化口径包（清洁室重述自开发文档）。跑批类（r7/r8/r12/r13）只冻结快照口径（见各 metric description），调度实现归后续波（OQ-4）。v2 纯追加 r8 一条；v3 纯追加 r9 采购件汇总主口径与 r7 未按期明细下钻口径两条，既有七条不变。',
  metrics: [
    {
      schemaVersion: 1,
      metricId: 'work-order-delivery',
      version: 1,
      display: '工作令交付报表（r2）',
      description:
        '口径重述（r2）：按计划交付日期与实际交付日期审视工作令交付情况——实时查询口径，无跑批、无结果表（源 mes_work_order 只读）。粒度=一行一工作令；维度字段即报表列（工作令号/项目名称/状态/计划交付日/实际交付日），空日期归 null 组（Web 显示「—」）。实际交付日=验收类工单末次报工审核确认后回写（维护在工作令/报工域，本口径只读）。时间口径 business：businessTime=实际交付时间；未交付行 businessTime 为空，按引擎回落语义锚 occurredAt（行创建时刻）——窗口匹配含此回落，需求文档"范围均可为空、计划与实际独立、可只填一侧"由查询层承载：statPeriod（month/year）与计划/实际范围成对才分别过滤（range 谓词作用于 planDeliveryDate/actualDeliveryDate 维度，月范围展开月首末、年范围展开年首末，含边界）；状态多选=in-set 查询过滤；未选维度或范围不完整=不过滤查全部。逻辑删除行（is_deleted=1）由源适配器取行时剔除。默认排序（实际交付日降序+id 升序）与导出归呈现层。',
      timeBasis: 'business',
      sourceKind: 'work-order-facts',
      dimensions: [
        { field: 'workOrderNo', label: '工作令号' },
        { field: 'workOrderName', label: '项目名称' },
        { field: 'workOrderStatus', label: '工作令状态' },
        { field: 'planDeliveryDate', label: '计划交付日期' },
        { field: 'actualDeliveryDate', label: '实际交付日期' },
      ],
      measures: [{ measureId: 'work-order-count', aggregation: 'count' }],
    },
    {
      schemaVersion: 1,
      metricId: 'outsource-delivery-monthly',
      version: 1,
      display: '外协零件交货情况汇总（r7）',
      description:
        '口径重述（r7）：按计划交货月份×供应商汇总外协派工交货情况。粒度=(statMonth, supplierId)，statMonth=计划交货日（plannedDeliveryDate）所在 yyyy-MM。纳入范围（根过滤，双方 is_deleted=0 由源适配器剔除）：派工单已下发（dispatchStatus>=2）且下发时间/计划交货日/供应商均非空。指标口径：外协派工单数=orderId 去重（distinct-count）；外协零件图号总数=drawingKey 去重——源适配器物化 drawingKey=工作令+去空格图号（同一工作令同图号多次派工计 1），图号为空按明细行唯一键物化（按行计）；未按时交货图号总数=lateDrawingKey 去重——逾期判定：实际质检日>计划交货日，或未质检且统计截止日（asOfDate，快照口径默认昨日）>计划交货日；非逾期行为 null 不计数（distinct-count 跳过 null）。按期率=(图号总数-未按时图号数)/图号总数为派生指标，呈现层由两度量计算。快照口径冻结（本版不实现调度）：xxl-job 日跑批全量重算（JobHandler outsourceDeliveryReportJobHandler，Cron 建议 0 5 0 * * ?；入参空=统计截止昨日，yyyy-MM-dd 仅影响逾期判定），先逻辑删除结果表全部有效行再批量写入最新快照、不保留历史版本，业务键 (stat_month, supplier_id) 非唯一索引。时间列映射：occurredAt=派工下发时刻、businessTime=计划交货日（statMonth 锚）、availableTime=跑批刷新时刻。下钻明细（未按期交货明细弹窗）归呈现层后续波。',
      timeBasis: 'business',
      sourceKind: 'outsource-delivery-facts',
      dimensions: [
        { field: 'statMonth', label: '月份' },
        { field: 'supplierId', label: '供应商' },
      ],
      measures: [
        { measureId: 'order-count', aggregation: 'distinct-count', field: 'orderId' },
        { measureId: 'drawing-total', aggregation: 'distinct-count', field: 'drawingKey' },
        { measureId: 'late-drawing-total', aggregation: 'distinct-count', field: 'lateDrawingKey' },
      ],
      filter: {
        kind: 'and',
        parts: [
          { kind: 'compare', op: 'gte', field: 'dispatchStatus', value: 2 },
          { kind: 'compare', op: 'ne', field: 'dispatchTime', value: null },
          { kind: 'compare', op: 'ne', field: 'plannedDeliveryDate', value: null },
          { kind: 'compare', op: 'ne', field: 'supplierId', value: null },
        ],
      },
    },
    {
      schemaVersion: 1,
      metricId: 'quality-summary-daily',
      version: 1,
      display: '质检汇总报表·按日（r12）',
      description:
        '口径重述（r12 按日）：按日汇总已完成质检的图号数/零件总数量/不合格总数量。事实源=三源 UNION ALL（仅跑批读源表）：自制完工+外协回厂（质检单 inspection_status=2 已质检，完成日=DATE(inspection_time)）、非标件采购质检行（qc_status=2 已质检、排除已取消 3，完成日=DATE(inspect_time)）、标准配件采购质检行（标准件∪电气∪需检手工，qc_status=2 排除取消）。不纳入：设备采购质检、装配/电气派工质检、旧采购来料（inspection_source=3）、待质检、已取消、完成时间为空的已质检行——各源完成判定由源适配器物化 completed（根过滤承载，引擎重复施加）。复检：每张已质检单独立一行，复检合格不冲减首检不合格。图号身份：自制/外协/非标取图号、标准配件取物料编码，源适配器 trim 后物化 drawingNo（空值=null，不计入图号去重——distinct-count 跳过 null，Web 显示「—」）。数量：总数量=送检数量（inspectQty）合计、不合格总数量=unqualifiedQty 合计；数量精度 decimal(18,5)、Web 最多 5 位小数去末尾 0（format 提示）。当日去重图号（drawing-count）；无质检的日不产汇总行（无分组即无行，列表不补 0）。快照口径冻结（本版不实现调度）：JobHandler qualitySummaryReportJobHandler，Cron 建议 0 5 0 * * ?；入参空/单日 yyyy-MM-dd=重刷该日事实+日汇总并按事实重算该日所在月月汇总，yyyy-MM=整月重刷；单日只删该日事实+该日日汇总+当月月汇总一行，手工月只删该月，禁全表清空、禁日期区间入参；事实业务键 (source_type, source_id)。时间口径 business：businessTime=质检完成时刻，occurredAt=源行创建。不合格明细下钻（unqualifiedQty>0 事实行）归呈现层后续波。',
      timeBasis: 'business',
      sourceKind: 'quality-inspect-facts',
      dimensions: [{ field: 'inspectDate', label: '日期' }],
      measures: [
        { measureId: 'drawing-count', aggregation: 'distinct-count', field: 'drawingNo' },
        { measureId: 'total-qty', aggregation: 'sum', field: 'inspectQty', format: { maximumFractionDigits: 5 } },
        { measureId: 'unqualified-qty', aggregation: 'sum', field: 'unqualifiedQty', format: { maximumFractionDigits: 5 } },
      ],
      filter: { kind: 'compare', op: 'eq', field: 'completed', value: true },
    },
    {
      schemaVersion: 1,
      metricId: 'quality-summary-monthly',
      version: 1,
      display: '质检汇总报表·按月（r12）',
      description:
        '口径重述（r12 按月）：同质检汇总·按日的三源事实与根过滤（completed=已质检；复检独立计行不冲减；图号 trim 空值不计入去重），唯一差异=分组粒度——**当月去重图号（statMonth 维度内 distinct），不是各日图号数相加**（需求文档 1.2.2 明示），故与按日口径分立两条定义（引擎不支持分组粗化，月去重必须在月粒度分组上求值）。statMonth=质检完成日所在 yyyy-MM（源适配器物化）。数量为当月合计（SUM 精确可粗化，但与图号数同表产出）。无事实的月不产行。快照口径冻结：与按日同一跑批按事实表重算月汇总（先删该月月汇总行再插入），见按日口径 description；月表业务键 stat_month。时间口径 business：businessTime=质检完成时刻。',
      timeBasis: 'business',
      sourceKind: 'quality-inspect-facts',
      dimensions: [{ field: 'statMonth', label: '月份' }],
      measures: [
        { measureId: 'drawing-count', aggregation: 'distinct-count', field: 'drawingNo' },
        { measureId: 'total-qty', aggregation: 'sum', field: 'inspectQty', format: { maximumFractionDigits: 5 } },
        { measureId: 'unqualified-qty', aggregation: 'sum', field: 'unqualifiedQty', format: { maximumFractionDigits: 5 } },
      ],
      filter: { kind: 'compare', op: 'eq', field: 'completed', value: true },
    },
    {
      schemaVersion: 1,
      metricId: 'hours-summary-daily',
      version: 1,
      display: '工时汇总报表·岗位×日（r13 主表）',
      description:
        '口径重述（r13 主表）：按岗位×统计日汇总审核/审批通过的报工工时。岗位 position：1 机加工（源自制报工，工时审核状态=2，完工日=报工完成时间 report_time 所在日；工时=审核工时分钟数，源适配器换算小时=分钟÷60 中间 10 位精度）；2 装配（装配报工×派工单 business_type=1，审批状态=2，完工日=report_date；工时=审批工时+审批加班工时）；3 电气（business_type=2，余同装配）。根过滤 approvalStatus=2；两侧逻辑删除行由源适配器剔除。机加工**无法解析工序**的工时仍计入本口径 total-hours（不进工序分列口径，列表/导出无「其他」列）。数值精度：引擎只累加换算后原始值（format 提示 2 位小数），四舍五入归呈现层；无数据日该岗位不产行（无分组即无行，重跑后无源数据仅删旧行不插 0）。快照口径冻结（本版不实现调度）：JobHandler hoursSummaryReportJobHandler，Cron 建议 0 10 0 * * ?；入参空=昨日、yyyy-MM-dd 单日、起~止闭区间、逗号离散日（非法抛业务异常中止）；逐日删除重入（先按该日逻辑删除主表/子表行，仅 total>0 岗位重插，禁全表清空），主表业务键 (stat_date, position)。按月/按年=同口径对日行按岗位+窗口 SUM（呈现层聚合；SUM 口径粗化精确）。时间口径 business：businessTime=完工日、occurredAt=报工行创建。与 r5 工作令工时报表（按工作令累计）、工时管理工时汇总（按人×月）为不同模块：本口径无工作令维度、无个人折算。',
      timeBasis: 'business',
      sourceKind: 'position-hours-facts',
      dimensions: [
        { field: 'position', label: '岗位' },
        { field: 'statDate', label: '日期' },
      ],
      measures: [
        { measureId: 'total-hours', aggregation: 'sum', field: 'hours', format: { unit: 'h', maximumFractionDigits: 2 } },
      ],
      filter: { kind: 'compare', op: 'eq', field: 'approvalStatus', value: 2 },
    },
    {
      schemaVersion: 1,
      metricId: 'hours-summary-process',
      version: 1,
      display: '工时汇总报表·机加工工序分列（r13 子表）',
      description:
        '口径重述（r13 工序子表）：机加工（position=1）按工序主数据分列的日工时。归集键=processId（工序主数据主键；跑批由源端工序编码解析——优先派工明细工序编码、可再关联工序工艺补全后查主数据；编码为空或主数据无对应=无法解析，不进本口径，其工时仍进主表口径）。根过滤：审批/审核状态=2 且 position=1 且 processId 非空。工序列动态口径：按工序主数据机加工类型未删除**含停用**全量展开（勿写死固定列）；processCode/processName 为源适配器快照（导出/核对用，不作归集键）。快照口径冻结：与主表同一跑批删除重入，子表业务键 (stat_date, process_id)，仅机加工写子表且工时>0 才插行；按月/按年=同口径 SUM（呈现层聚合）。时间口径 business：businessTime=完工日。',
      timeBasis: 'business',
      sourceKind: 'position-hours-facts',
      dimensions: [
        { field: 'processId', label: '工序' },
        { field: 'statDate', label: '日期' },
      ],
      measures: [
        { measureId: 'work-hours', aggregation: 'sum', field: 'hours', format: { unit: 'h', maximumFractionDigits: 2 } },
      ],
      filter: {
        kind: 'and',
        parts: [
          { kind: 'compare', op: 'eq', field: 'approvalStatus', value: 2 },
          { kind: 'compare', op: 'eq', field: 'position', value: 1 },
          { kind: 'compare', op: 'ne', field: 'processId', value: null },
        ],
      },
    },
    {
      schemaVersion: 1,
      metricId: 'purchase-overdue-daily',
      version: 1,
      display: '逾期交货采购件报表·明细行日快照（r8）',
      description:
        '口径重述（r8 逾期交货采购件）：采购订单**明细行级**逾期快照——一行一明细行（业务键 orderLineId=订单#行号），按统计截止日 statDate（默认昨日）保存当前逾期全量快照（非按日追加归档）；与既有订单头粒度催货事实面（listing overdueList，天数为纲）并存，互不替代。纳入范围：订单头/明细行未删（源适配器剔除）、订单已进入采购链路（未下单不纳入；已完成行按留存条件保留）、行订购数量>0、计划到货日 planArrivalDate 非空（空跳过）；逾期判定 statDate>=planArrivalDate（**计划到货日当天即逾期**）。清单来源 partType=订单申请来源字典（1 零件清单/2 标准件清单/3 电气件清单/4 手工清单）；**手工清单行（partType=4）无工作令，同等纳入**，workOrderId/drawingNo 落 null 组（Web/导出显示「—」），源适配器禁止因工作令 INNER JOIN 漏手工行。完成量（inboundQty 语义）按加工类型分支：纯外购等=入库累计−入库退货（净入库）；**外购加工（加工类型 6/7）无采购入库、不来料质检——完成量=确认收货−收货退货（净收货）、完成时间=确认收货时间**（禁止用来料质检合格数/质检时间；本域收货回填 receivedQty 即两分支统一的净完成量单口径）。未入库数量 unInboundQty=max(0, purchaseQty−完成量)，每批重算、部分完成后减少；全部完成且无晚完成、无固化则整行退出。逾期零件数量 overdueQty（仅 Web 列表展示，导出不含）**一次性固化**：行首次纳入写 purchaseQty−当时完成量；跨批沿用历史值不随完成量减少；整行退出后再纳入视为新周期重新固化。留存：已收齐但曾在计划到货日之后才完成的行保留（晚完成量>0），仅历史固化 overdueQty>0 亦保留——三种纳入路径均蕴含固化值>0，故根过滤 overdueQty>0 即快照面不变量（引擎重复施加）。快照口径冻结（本版不实现调度）：xxl-job **每日全量删写**（JobHandler overduePurchaseReportJobHandler，Cron 建议 0 10 0 * * ?；入参空=statDate 取昨日，yyyy-MM-dd 指定统计截止日），事务内先读 purchase_order_line_id→overdue_qty 固化映射，再逻辑删除结果表全部有效行、批量插入最新快照（仅保留最新一次跑批产物，不并存历史版本），禁止逐行查库（批量拉取→内存判定→批量插入）。时间列映射：businessTime=计划到货日（窗口=计划到货月）、occurredAt/availableTime=跑批写入时刻（statTime 同值）；行字段清单 orderLineId/purchaseOrderId/workOrderId/partType/drawingNo/itemId/purchaseDate（订单创建日）/planArrivalDate/purchaseQty/unInboundQty/overdueQty/supplierName/statDate。Web 筛选（清单来源多选=partType 维度切片、工作令=workOrderId、项目名称模糊归工作令域）与导出 11 列（无逾期零件数量列）归呈现层。',
      timeBasis: 'business',
      sourceKind: 'purchase-overdue-daily-facts',
      dimensions: [
        { field: 'orderLineId', label: '采购订单明细行' },
        { field: 'workOrderId', label: '工作令' },
        { field: 'partType', label: '清单来源' },
        { field: 'purchaseOrderId', label: '采购订单' },
        { field: 'drawingNo', label: '图号' },
        { field: 'itemId', label: '零件/物料' },
        { field: 'purchaseDate', label: '采购日期' },
        { field: 'planArrivalDate', label: '计划到货日' },
        { field: 'supplierName', label: '供应商' },
        { field: 'statDate', label: '统计截止日' },
      ],
      measures: [
        { measureId: 'purchase-qty', aggregation: 'sum', field: 'purchaseQty', format: { maximumFractionDigits: 5 } },
        { measureId: 'un-inbound-qty', aggregation: 'sum', field: 'unInboundQty', format: { maximumFractionDigits: 5 } },
        { measureId: 'overdue-qty', aggregation: 'sum', field: 'overdueQty', format: { maximumFractionDigits: 5 } },
      ],
      filter: { kind: 'compare', op: 'gt', field: 'overdueQty', value: 0 },
    },
    {
      schemaVersion: 1,
      metricId: 'purchase-parts-summary',
      version: 1,
      display: '采购件情况汇总（r9）',
      description:
        '口径重述（r9，A4 部分·功能补齐第一波）：工作令×零件类型 汇总采购订单数与采购金额。粒度=(workOrderId, partType) 一行；采购订单数=orderId 去重（distinct-count，一张采购单只计一次）；采购金额=lineAmountMinor 合计（**分，整数**——默认口径=已收货数量×单价，源适配器物化 lineAmountMinor=receivedQty×unitPriceMinor，half-up 到分，对齐 PRD 20 册 RP-016 裁定与 listing 对账要点；源文档 r9 按申请子行 amount 的跑批口径差异按 PRD §7 裁决不采用）。partType 两分（v1 行为重述，对账阶段按活系统校正）：drawing-part 非标件（行挂图号）/ standard-part 标准件电气件（行无图号）；workOrderId 空落 null 组（Web 显示「—」）。行集（源适配器取行时施加）：排除 draft 态订单与未定价行（无价不归集——listing 先例）；源文档订单范围（已下发/进行中/已完成、行数量>0）一致性对账归 A4 后续。时间口径 business：businessTime=订单承诺到货时刻（promisedAt）、occurredAt=订单创建。**口径并存登记（PRD RP-016/OQ 体例）**：与 smes-machining-calib 包 purchase-amount-summary（#95，激活价售卖层）同源同根——本条为**随标准版交付形态**（standardreports 服务面），两包各持其版、演进各自走包版本；金额量纲统一为分。A4 其余缺口（勾选行 zip 双模板导出/日跑批快照形态/实际交付日期筛选）归后续波。',
      timeBasis: 'business',
      sourceKind: 'purchase-amount-facts',
      dimensions: [
        { field: 'workOrderId', label: '工作令' },
        { field: 'partType', label: '零件类型' },
      ],
      measures: [
        { measureId: 'purchase-amount-minor', aggregation: 'sum', field: 'lineAmountMinor', format: { unit: '分' } },
        { measureId: 'order-count', aggregation: 'distinct-count', field: 'orderId' },
      ],
    },
    {
      schemaVersion: 1,
      metricId: 'outsource-delivery-late-detail',
      version: 1,
      display: '外协交货未按期明细（r7 下钻）',
      description:
        '口径重述（r7 下钻·功能补齐第一波）：主口径 outsource-delivery-monthly 的下钻明细——未按期交货的外协派工明细行（呈现层弹窗用，r7 源文档「未按期交货明细」节）。粒度=供应商×计划交货月×派工单×图号×工序×计划交货日×实际交货日（同键多行合并由 line-count 呈现）；根过滤钉「未按期」（lateDrawingKey 非空——源适配器物化：实际质检日>计划交货日，或未质检且统计截止日（默认昨日）>计划交货日）+ 主口径纳入范围（派工单已下发 dispatchStatus>=2 且下发时间/计划交货日/供应商非空）。指标：late-days=延迟天数（max——逾期锚（实际质检日或统计截止日）−计划交货日的日历日差，同键多行取同值）；line-count=明细行数。时间口径 business：businessTime=计划交货时刻、occurredAt=派工下发时刻。按期率/汇总列在主口径；本明细只列未按期行。',
      timeBasis: 'business',
      sourceKind: 'outsource-delivery-facts',
      dimensions: [
        { field: 'supplierId', label: '供应商' },
        { field: 'statMonth', label: '月份' },
        { field: 'orderId', label: '外协派工单' },
        { field: 'drawingNo', label: '图号' },
        { field: 'processCode', label: '工序' },
        { field: 'plannedDeliveryDate', label: '计划交货日' },
        { field: 'actualInspectDate', label: '实际交货日' },
      ],
      measures: [
        { measureId: 'late-days', aggregation: 'max', field: 'lateDays', format: { maximumFractionDigits: 0 } },
        { measureId: 'line-count', aggregation: 'count' },
      ],
      filter: {
        kind: 'and',
        parts: [
          { kind: 'compare', op: 'gte', field: 'dispatchStatus', value: 2 },
          { kind: 'compare', op: 'ne', field: 'dispatchTime', value: null },
          { kind: 'compare', op: 'ne', field: 'plannedDeliveryDate', value: null },
          { kind: 'compare', op: 'ne', field: 'supplierId', value: null },
          { kind: 'compare', op: 'ne', field: 'lateDrawingKey', value: null },
        ],
      },
    },
  ],
});
