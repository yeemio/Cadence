# MFG01 具名差量处置（mfg01-delta-v1）

报告完整读取：`noodle-test-output/MFG01-delivery-20261028/MFG01-full-delivery-report.md`；按需核e08/e09/e10分册及e02/e07的主报告具名观察。本报告测试8080/3000未绑定提交，原观察不抹除；本表结论针对ae7a615代码和本轮8181/3101隔离读回。原未提交写动作不能当已证越权。

| 报告ID | 当前核定、实际处置与证据 |
|---|---|
| P0-03 生产/质量分闸 | **当前代码已修且HTTP负向通过，报告建议部分错误。** StockOperationsPage按stock:receive呈现；prod收货选项/POST均403，wh质量判定403，qc库存入库403，wh消费已放行选项200（ENTRY-HTTP-RESULT.json及完整HTTP）。ROLE-PACKS §1.3/1.4/1.5明确生产无stock:receive/inspection:judge、品质判定、仓管消费放行件入仓；不把库存动作改为QC专属。本轮加动作解释，防将“放行入库”误读成“质量判定”。独立生产放行单属于主控后续MFG01新增合同，不在此差量实施。 |
| P0-05 收货→来料检 | **合法链原已接通；缺来源仅warn不可见是真实缺陷，已修。** ListingService.resolvePurchaseInspectionKind（1433附近）从申请item/kind映射三类；seed-factory.mjs:984/1045的旧PO requestIds为空。现收货返回逐行created/existing/unclassified/not-created/failed及单号/原因，原PO页与专用收货页均显示；收货前投影提示未知类别。合法3类申请承接PO的实际wh收货自动建3张pending，完整HTTP见live-legal-received/live-qc-queue；无来源订单明确unclassified未造standard。通知式失败不回滚收货的现合同保留并有故障单测。 |
| P0-06 质量态库存 | **模型差异，未伪造修复。** 07-inventory §1/2/7及15册IV-003/008/014定义总量−预占；现无HOLD/QUALIFIED/隔离质量态分账。采购入库当下on-hand可用是旧合同实态，本轮3张pending不证明MFG01质量态库存完成。不能总量改名“合格”或简单加列0。需主控独立产品决定。发现同读面真实bug“仓库筛选未传给库存API”已修并接缝测试，当前库存/库位/预占使用一致仓物料过滤。 |
| P1-01 RES链 | **既有数量逻辑已证；缺可追溯列表已补。** IV-008允许跨域reserve/release，现StockReservation三态，无独立RES/RTN单据。新增stock:read的GET /inventory/stock/reservations与实时库存只读追溯（key/来源/原量/余量/状态），按租户仓物料过滤。inventory测试证明20/5/15→核销15/0/15→预占3释放2后15/1/14，释放不虚增物理库存；终态与跨租户/错仓过滤有断言。复用上一设备链真实核销/撤销证据，不另造新释放写权限。正式RES/RTN状态机仍属MFG01新增面，不能用列表冒充全单据链。 |
| P1-04 PO版减量/应付 | **报告为未测，当前无此财务业务版模型。** 03-listing对象/五态与listing-config定义objectVersion为并发版本；不等于PO A/B业务版，无应付实体/第二应付生成路径。本轮不凭不存在的应付宣称不二生已验。外协unitPriceMinor:null/priceSource:null原合同保真（DispatchService.outsourcingBySupplier:1186、dispatch.test.ts未定价场景）；本轮新PO实际3行均null原样保存。PO变更/应付需产品合同，未新增财务模型。 |
| P1-05 外协入口/验收 | **ae7a615已有/权限模型差异，未证非法验收捷径。** apps/web/src/menu.ts:126注册/outsourcing/lines并挂outsourcing:read；purch-role无该码，不能因报告旧直链可达而擅加。/outsourcing根URL未承诺，正式路径是lines。DispatchService complete:706将外协done定义为“回厂可检事实”，投递self_outsourced pending，不等于质量合格；17册RQ-018已有明确时机裁定。供应商备注不驱动质量放行，报告未证明备注可关单。专属SCN09批次/公司验收独立单据不在现模型，留产品决定。 |
| P2-02 IQ/IP/FQ与返工门 | **现有返工复检门有效，新增工艺批准路线未实现。** 17册不合格闭环条款（177附近）和InspectionService:1316要求rework复检passed方可闭环。当前4类来源kind不是MFG01 IQ/IP/FQ新模型。修复真实UI问题：open不能直接闭环、disposed不能再处置、返工未复检合格不能点闭环；不无理由要求闭环重填已保存的处置原因。没有虚造工艺路线批准字段。 |
| P2-03 locations/寻料/废品 | **猜测路由不存在不等于库位不存在。** 15册IV-001/006与GET /inventory/warehouses/:id、/inventory/stock/locations已有仓库位/分布，桌面正确入口/inventory/warehouses和/inventory/stock，移库为stock.transfer。未增加任意alias。当前修库存仓筛选未生效。HOLD/SCRAP/客户处分列依赖质量/物权模型，不以普通库位名称假装隔离禁发完成。 |
| P2-04 plan图纸403 | **现码已修，权限不扩。** WorkOrdersPage:526仅drawing:read挂图纸卡；plan-role未授drawing:read，直链拒绝属正确边界，角色矩阵未承诺计划读取所有图纸。当前不会再在WO详情强拉图纸显示403。若要MFG01岗位授权由主控实名矩阵决定。 |
| P2-05 仓PO上下文 | **真实动作读面缺陷，已修。** ROLE-PACKS §1.5仓管有purchase:receive却无purchase:read，原菜单/页面按后者导致合法动作堵塞。现/purchase/receiving挂purchase:receive，专用页读取/receiving-orders最小投影（无价格、审批、人员详情），原POST收货权限不变。实际wh投影200并完成有申请收货，完整PO仍403；prod新投影403。未给岗位加任何read码。 |
| P2-06 审批人映射 | **种子项目经理事实，不是E02实名映射缺陷。** seed-factory.mjs:798 manager=ACTOR_PLAN；WorkOrderService:1406一级manager空回落salesRep；18册/ROLE-PACKS明确项目经理一级审批。user-factory-plan并不自动等于MFG01 E02；不能按账号名换审批人或越过真实身份clearance保留边界。本轮不改审批流/角色。 |

## 同范围UX

- **已修**：重复库存收货明确提示“幂等重放，库存未重复增加”；新来料投递回执不再只有控制台warn；仓管收货有订单/行/仓库上下文，不能读完整PO也可合法收货；库存仓筛选真正送到API；预占key/来源/余量/状态可读；NC按钮按原后端前置状态禁用。
- **已在上一候选修且保留**：采购收货仓库专用选项（purch-warehouse-options.http 200）；未知wh-seed-factory-01不在选项中，未伪造该仓。prod01库存表单权限裁剪、plan图纸卡隐藏沿原有效证据及本轮HTTP。
- **建议不采纳**：无菜单就统一封所有直链/写读同码，会破坏hideInMenu合法路由及已授权动作投影；质量放行入仓一律QC岗403会破坏岗位分工；原因输入为空一律禁NC闭环会让已有disposed记录无理由重填原因。按实际动作权限/业务状态处理。
- 原seed无申请承接的原因明确保留：不能从历史receiptKey或物料外观安全推断当时采购类别，也不能为补检去重写旧PO/申请/库存。此次没有运行或更改seed-factory源码；通过真实API新增合法三类申请链作为可操作合成夹具，并更新demo-handover说明。旧PO与旧库存读回完全不变，见PROTECTION-RESULT.json。

父级Owner新纳入的排程、独立承诺、金额分流、复机/报废会签、工程变更由主控PRODUCT-DECISION.md与后续增量合同管理，本差量没有启动这些新增实施。
