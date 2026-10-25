# U 波合同：文档增量需求第一批（A11 发料链路 + 报表族四定义 + A9 下图统计）

冻结：2026-10-26 晨｜总控派发（Owner 指令"找不到新需求就去搜索安排"）｜需求源 = 73 份开发文档（Owner 全面解禁，正式需求输入）｜清单基线：architecture/coverage/DOCS-INVENTORY-DIFF.md §2

## Goal / Done-when

A11 发料任务+发料记录（新 issue 模块，后端全量）与 A1/A2/A6/A7 四张报表的 engine-reporting 口径定义 + A9 下图统计只读端点落地，局部测试绿。接线（注册/联运钩子/报表 HTTP 呈现）归后续波。

## U1 发料链路（code-writer-pro）

- **需求文档**（必读）：`/Users/yeemio/AI/project/sieracMes-AI/docs/开发文档/发料任务/发料任务-开发文档.md` + `发料记录-开发文档.md`（以文档行为为准重述，词汇纪律 ADR-0010 仍有效——用离散制造通用词）
- 范围：发料任务（装配/电气派工自动生成维度、补全子行、去发料/确认发料/进度汇总、排除配件行）+ 发料记录（确认建快照、撤销原路回滚、快递单管理）+ 库存/预占联动端口（IssueMaterialPort 依赖倒置，接线归合流）
- 写入面：packages/application/src/issue/**（新）、packages/business-store/src/issue/** + schema.prisma 新 model + rls/tables.ts 补登 + 迁移、两侧 tests。禁改：dispatch/inventory 既有源码（钩子用端口注入）、apps/**、共享接线文件
- 验证：application+business-store 局部全量测试+tsc 绿即停

## U2 报表口径定义 + 下图统计（code-writer-pro）

- **需求文档**（必读，四份）：`报表/工作令交付报表-开发文档.md`（A1：计划/实际交付日期月年维、实时无跑批）、`报表/外协零件交货情况汇总-开发文档.md`（A2：计划交货月×供应商、按期率+下钻）、`报表/质检汇总报表-开发文档.md`（A6：日/月图号数/零件总数/不合格数三源）、`报表/工时汇总报表-开发文档.md`（A7：岗位×日/月/年、工序动态分列含停用）
- 范围：engine-reporting 四个新 MetricDefinition（沿既有 MetricDefinition 版本化体例，纯数据+求值测试）+ A9 下图统计（listing 只读统计端点：时间范围内零件清单明细行 COUNT 不去重，`工作令模块/工作令-下图统计-开发文档.md`）
- 写入面：engine-reporting 新定义文件+tests（纯新增）；application/src/listing 只读端点若需改既有文件→停手上报（预期为新增 controller 方法级小增量，允许最小追加）。禁改：standardreports 既有文件（S1 验收在途）、apps/**
- 验证：engine-reporting+application 局部测试+tsc 绿即停。跑批类口径（A2/A6/A7 的日跑批）本波只定义快照口径不实现调度

## 共同纪律

零新增运行时依赖（发料的对象存储/快递单走纯元数据）；不 commit/push；429 退避重试（30s 起步）；同树并行（他线合流在途）——冲突停手上报；回传身份+changed paths+口径对照表（文档行为 vs 实现口径）+测试数字。

## U3 文件管理（A13，code-writer-pro；2026-10-26 晨追加）

- **需求文档**（必读）：`/Users/yeemio/AI/project/sieracMes-AI/docs/开发文档/基础信息/文件管理模块-开发文档.md`（bizFile 统一附件元数据；save/save-batch/list-by-biz-id/remove/下载链接；无独立菜单）
- 范围：attachment 模块后端全量——附件元数据 CRUD + 按业务对象（bizType+bizId）挂取 + **ObjectStoragePort 依赖倒置**（对象存储纯端口，本波只落内存/本地文件适配器，**不引入 MinIO/S3 依赖**——基础设施接入归部署期）；上传字节经端口 put、下载经端口签发只读引用
- 写入面：packages/application/src/attachment/**（新）、business-store/src/attachment/** + schema 新 model + rls/tables.ts 补登 + 迁移、两侧 tests。禁改：既有模块源码、apps/**、共享接线文件（工作令/采购合同/送货单/报工的消费接线归后续波）
- 验证：application+business-store 局部全量测试+tsc 绿即停（U1 兄弟线在途文件的 tsc 错不计）

## U4 原材料关联表（S10，code-writer-pro；2026-10-26 凌晨追加，A5 前置之一）

- **需求文档**：`工作令模块/工作令-生产购置清单模块-开发文档.md` §1.3.4/1.2（一工序多原材料：尺寸/单价快照）
- 范围：listing 域工序×原材料关联表——关联 CRUD、工序行挂多原材料、原材料行快照字段（尺寸/单价，单价为录入值无取价源）、数量；A5 项目成本 r11 原材料成本的取数源（本波只落数据面不接成本计算）
- 写入面：application/src/listing 追加新文件（process-material-*.ts 族）+ 既有文件仅允许方法级最小追加（沿 U2 upload-stats 先例，超出停手上报）；business-store schema 新 model+迁移+RLS 补登+tests
- 验证：application+business-store 局部全量+tsc 绿

## U5 售后报销（A12，code-writer-pro；A5 前置之二）

- **需求文档**：`售后派工/售后派工-开发文档.md` §2.4（527-643 行：审批通过后财务填报四类费用 食宿/交通/加班/其他）
- 范围：dispatch 售后域报销面——报销记录 CRUD（挂售后派工单，仅审批通过后可填报）、四类费用行、金额合计、幂等；A5 的"售后成本块"取数源
- 写入面：application/src/dispatch 追加新文件（aftercare-claim-*.ts 族）+ 方法级最小追加同上约束；business-store schema+迁移+RLS+tests
- 验证：application+business-store 局部全量+tsc 绿

## U6 接线波（code-writer-pro；2026-10-26 凌晨②追加，总控收口后）

- 范围：把已验收未接线的六模块接进组合根——①apps/server 注册 IssueModule/AttachmentModule/AftercareClaimModule +（若 M1 线收口时未接的）MenuConfigModule/ApprovalConfigModule/NotificationsModule（先盘点 app-registry/main.ts 实态，已接不重接）②跨模块端口适配：IssueMaterialPort←inventory 实现、AftercareApprovedReportPort←reporting（createAftercareReportPort 已备）、dispatch→IssueSyncPort 派工生成钩子、NotificationSourcePort 既有事件点注入（点名/派修，单行式）③domain-error.filter 六域错误 HTTP 映射 ④business-store package.json exports 补缺（./issue ./attachment ./menu-config ./approval-config ./notifications——先查已登记者）⑤deploy/scripts/rls-proof.mjs EXPECTED_RLS_TABLES bump 98 ⑥attachment 上传 bodyLimit（base64 32MiB≈43MB）⑦boot 冒烟场景扩展
- 写入面：apps/server/src/**、packages/business-store/package.json、deploy/scripts/rls-proof.mjs、相关测试。禁改：application/product-ui 业务源码（发现缺口停手上报）
- 验证：server 全量测试+boot e2e+局部 tsc 绿即停；全仓 verify 总控收口统一跑

## U7 项目成本大扩（A5，code-writer-pro；2026-10-26 凌晨③追加，前置 U1/U4/U5/U6 全就绪）

- **需求文档**（必读，口径权威）：`/Users/yeemio/AI/project/sieracMes-AI/docs/开发文档/报表/项目成本报表-开发文档.md`（六块成本：材料四类按发料两段拆分利库/外协/人工三类别/售后保内保外/外购设备采购+利库；详情 KPI 7 项；录入价格写回发料明细；跑批七表）
- 范围：costing 模块扩展——六块成本聚合（取数源=U1 issue 发料记录+U4 process-material 原材料单价+U5 aftercare-claim 售后四费+listing 外购+hours 人工+dispatch 外协）、成本快照表+命令化跑批（沿 costing 既有 supersedes/幂等体例）、详情 KPI 查询面。**录入价格写回发料明细**经端口单向（写回交互若超 costing 写入面→停手上报裁定）
- 写入面：packages/application/src/costing/**、business-store costing store+schema+迁移+RLS、两侧 tests；apps/server 仅注册/接线追加（沿 U6 体例）。禁改：issue/reporting/dispatch 既有源码（经端口/事件消费）
- 验证：application+business-store 局部全量+tsc+server 测试绿即停；全仓 verify 总控收口
- 口径对照：材料四类的"两段拆分"（利用库存段/采购入库段）以 U1 发料记录的 reservedConsumed/availableConsumed 回执快照为据；口径差异如实登记对账

## U8 逾期采购件报表口径（A3，code-writer-pro；2026-10-26 凌晨④追加）

- **需求文档**：`报表/逾期交货采购件报表-开发文档.md`（订单**明细行级**逾期快照、未入库数量/逾期零件数量固化、外购加工净收货口径、手工清单 apply_source=4 纳入、每日全量删写、导出 11 列）
- 范围：engine-reporting 新 metric `purchase-overdue-daily@v1`（明细行粒度，与既有订单头粒度 overdue 事实面并存）+ listing overdue 事实端点扩明细行查询（或新只读端点，读实态定）；快照口径冻结进 description（跑批归部署期，U2 先例）
- 写入面：engine-reporting 新定义+tests；application/src/listing 只读面最小追加（超面停手）；禁改其它
- 验证：engine-reporting+application 局部全量+tsc 绿

## U9 物料价格台账（S9，code-writer-pro）

- **需求文档**：`物料管理/物料管理模块-开发文档.md`（220-363 行：采购含税单价历史+初始价格+批量当前单价取价 mapCurrentUnitPrices；六源引用删除校验）
- 范围：masterdata 价格台账域——价格历史记录 CRUD（挂 ItemMaster，含税单价分）、初始价格、当前单价查询面、批量取价端点；与 U7 cost_price_entries 的边界：本台账=物料主数据维（采购价历史），U7 表=发料计价维（发料明细），合同头注明互不合并
- 写入面：application/src/masterdata 追加新文件族+方法级最小追加；business-store schema+迁移+RLS+tests
- 验证：application+business-store 局部全量+tsc 绿

## 待办池（本波不做，已排序）

A13 文件管理（横切面，需对象存储 port 化设计）→ A5 项目成本大扩（依赖 S10 原材料关联表+A12 售后报销）→ A8+A10 大屏+日跑批（定制，含 WebSocket）→ S1-S14 子功能增强批次 → B3 货架 → B1/B2 payroll 口径对照 → A12/A4/A14 可选项。呈现层（报表页面/发料页面）统一等合流静止后开波。
