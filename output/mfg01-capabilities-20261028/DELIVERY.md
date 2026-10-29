# MFG01 六项能力与质量库存增量交付

状态：**产品源码冻结，交主控验收；新增可见 IAB 尚待主控补验。** 本交付不代表共享环境部署、M2 整体验收或真实客户业务验收。唯一产品 writer `/root/cadence_remaining`，接收方 `/root`，事件 `mfg01-capabilities-v1-resume2`。

基线 `ae7a615a86a84817947cd388edd1c1096c439dc9`，保留已接受 v1 `6362a8a771c1265e0b507ac8ed6ea92fd8d6b03f210761d32465292b2ac7a8f5` 的谱系。最终候选 **`e2823a9924cdd98f47302b2ac76cc5199b27507e26b56c3d7d12ccdd48046f90`**：76 产品路径，其中 v1 的14路径字节未变、5路径为本增量必要重叠，另57路径新增/变更；entry→candidate 共62路径。逐文件清单与差量见 `FINAL-CANDIDATE.json`、`FINAL-CANDIDATE-MANIFEST.tsv`。聚合格式是按 **path 排序** 的 UTF-8 `path<TAB>sha256<LF>` 的 SHA256。PM/output 不进入产品候选。

`FINAL-TRACKED-PATCH.diff` 是 HEAD→候选的已跟踪文件补丁；`FINAL-PRODUCT-SOURCE.tar.gz` 同时保存候选中未跟踪的新源文件。未 commit/push；未改8080/3000/55432、常驻栈、原报告、旧失败夹具或父维护的 PM 文档。

## 已实现和实际证据

| 能力 | 实际结果与原件 |
| --- | --- |
| 联合排程/生产放行 | 实际生产机台、工装、人员、工序技能与时窗；E07草案不占资源，E02批准原子接原派工。机台/工装/人员冲突分别拒绝。原assign/start/report/issue入口消费闸门。`schedule-proof.log` 的故意事件写失败使源派工、控制单、领域事件、Outbox完整回滚；`schedule-recovery.log` 恢复原成功单据，不重复创建。`two-process-proof.log` 两API进程竞争同资源恰一成功，失败源仍draft/version1。 |
| 独立承诺 | 真实工作令保留计划日期，运营承诺/重诺独立事实。已保存原/前次/当前承诺，两个真实分批发货后原迟交标记不抹除。`commitment-proof.log` 后段错误由主控依据已存HTTP完成原值核定，未重发承诺；`shipping-commitment-proof.log` 完成同料分批实扣、原承诺与曾迟交读回。 |
| 净额/E13/需求阈值 | 原含税单价/null不改；明确净价、依据与真实订购数量形成小币种金额。E13复核后≤100000元E02、超过E01，采购/复核人不能凭角色叠加自审。真实listingLineId跨核查快照/PO/供应商累计；手工来源须E13服务器核定真实需求。`purchase-first/second.log` 同需求50000+75000元升级E01，旧E02事实保留。`historical-net-{setup,finish}.log` 旧PO全对象保持、未知历史净额只阻止受影响新增放行、补有据历史净额后正确升级、修正使旧审核失效。`two-process-proof.log` 最终下发与新同需求PO并发，第二单累计120000元仍强制E13→E01。 |
| E02/E10复机 | 实际故障设备与当前修复版本绑定，维修完成不解封，缺签/同人叠角色/旧签名均不能复机；新故障重新会签。`restart-proof.log`。 |
| 报废会签 | 实际NC，未知损失拒绝；正好50000元需E05/E10，超过还需E01。少签、同人、旧版及旧dispose/close入口不能跳过。`scrap-proof.log`。这是NC处置事实；未把NC关闭冒充物理库存报废扣减。 |
| EC冻结/A-B | 明确实际工作令、清单、图纸与工艺快照，SO01/SO03 A、SO02 B。实际report/dispatch/receipt三来源统一解析真实工作令，冻结时单条/批量判定、复检、让步、入库、新派工、旧开工均拒绝且PG前后源量/事件/Outbox不变；未冻结SO01仍正常。运营解冻后原合法三来源继续，新B作业可开工，旧A作业不能借解冻继续。`ec-{freeze,unfreeze}-proof.log`。实际历史报工与外协报价完整对象前后相等。独立A/B PDF实际可打开。 |
| 质量库存 | 真实待检/合格/隔离/未知分账，合格减有效占用才可用；旧无证余额未知。真实采购收货先增物理并待检，QC判定后仓管中性放行 `physicalDelta=0`。不合格进入隔离，返工复检仍同来源。待检/隔离/未知不能齐套、预占或出库；标准件真实库位发料/撤销恢复原质量批次及预占，真实发货扣减。`quality-{first,continue,second}.log`、`issue-quality-proof.log`、`shipping-commitment-proof.log`。桌面/移动消费解析器保留所有质量字段与合法0，未提供字段仍未知。 |
| 当前放行额度 | 不是历史release_facts累加。当前passed且同料/来源有效，额度=min(passedQty,quantity)−同inspection跨仓物理入库及中性放行；同事件审计不重复计。部分消费即禁止撤判。`qa-credit-physical-proof.log`：历史事实4但当前额度2，MAIN/FG各1，选项2→1→消失。`qa-credit-neutral-proof.log`：同批2件只中性转质、错仓拒绝、物理不双增。两段都含未消费撤回重判、消费后撤回零写、超额拒绝、额度0精确operationId重试返回原完整回执、同key异载荷拒绝。外协物理分支在EC续证中另验证上限/撤回。 |

part/equipment 仍按原合同作来源拆分/确认快照，不冒称实时物理扣账；本轮实际物理扣减证据是 **standard 发料** 与 **同料发货**。电气及原设备链已接受证据保持复用，不重跑旧全链。

## PG事务、迁移与保留

只在隔离PG55435应用三项具名迁移：`20261028180000_mfg_control_quality`、`20261028180100_rls_mfg_replay`、`20261028182000_mfg_event_immutability`，新增13表，共121表强制RLS。未重跑迁移。升级前恢复源 `before-upgrade.sql` 保留且按敏感备份处理，不作为对话输出。

`preservation-before.json` 与 `preservation-after.json` 的全部108旧表行数和完整行hash相等；这是迁移即时保留证明。之后只通过真实服务创建本轮合成业务。另有真实旧PO全对象比较，未改旧含税价/null、数量、批准事实；旧A超长恢复键隔离失败夹具不改。

受控命令采用同租户PG事务和事务级 advisory lock；适配器、源投影、事件、Outbox加入同一连接。嵌套换租户拒绝，异常被调用方捕获仍整单回滚。`tx-proof-corrected.log`、`schedule-proof.log`；会话RLS关闭的普通非事务路径保持原行为。`rls-restricted-proof.log` 用真实非superuser证明：off事务外0行、on各租户仅本方、off适配器加入外事务同backend、跨租户插入拒绝零行；临时角色/自建夹具已精确清理。

双进程证明的真实PG等待连接分别为3110与3116，原件 `r2-294-resource-two-pg-waiters.json`、`r2-305-demand-two-pg-waiters.json`，不是进程内mutex。短时3102进程19445已停止。最终3101重启前后所有当前控制单版本/源绑定、职责、质量库存投影、历史报工、PO完全相等，见 `restart-{before,after}.json/.log`。

## 检查与失败保留

命令/退出码/日志完整索引见 `CHECKS.json`。最终application受影响8文件206项、server4文件46项通过。store首次6文件116通过/1失败为旧测试允许事务中换租户，主控批准仅改测试为拒绝、零ops、rollback，补跑该文件16项全过；其它5文件绿结果复用。Web首次5文件44通过/1失败暴露新入口与旧生产组code冲突，主控批准仅改新入口为manufacturing-control及其页面装配引用，原组manufacturing及子项保留；menu文件10项补跑全过，其余4文件复用。product-ui库存解析5项通过。

application/store/server类型与构建、Web类型与Vite构建、依赖边界及边界自测通过，原件 `final-build-types-boundary.log`；最后菜单/测试修改后相关store/web类型与Web构建通过，`final-approved-two-fixes.log`。Vite仅有既有大chunk警告，无构建失败。原失败日志保留原EXIT1，没有改成EXIT0，也不宣称一次全仓verify全绿。

历史5次验证脚本形状/调用约定错误保留在CHECKPOINT/RESUME1-STOP、原HTTP和日志；成功响应均保存后续接，未重放已成功写入。`r2-170` 是既有活跃工序占用的合法409，原件保留，按主控批准正常完工自有原派工后继续。两个实际产品接线根因（EC质检不存在workOrderId；历史事实误作当前额度）均经主控批准窄修并有上表实际证据。另一次 product-ui 不存在build脚本的纯检查命令选择错误单列，按实际typecheck/test及Web构建修正，无新增脚本。

## 最终运行与主控IAB

`FINAL-RUNTIME-BINDING.json` 绑定源码候选、44个API编译文件及36个Web产物hash。API PID **22462**、端口 **3101**、30模块全开、Postgres；Web **8181** 容器 `cadence-sol-rem-web-20261028` 挂载本次dist；PG **55435**。入口 `http://localhost:8181/manufacturing`；带目标登录 `http://localhost:8181/login?to=%2Fmanufacturing`。浏览器文档导航Accept:text/html读回200；无文档Accept的同路径请求按原规则转API404，未为检查改变代理规则。A/B PDF均200且与source hash相等。

隔离测试用户：mfg-e07计划、mfg-e02运营、mfg-e08采购、mfg-e13财务、mfg-e05工程、mfg-e10品质、mfg-e01总经理。各自服务器真实角色，不绑admin；admin/旧purch01没有新职责，board403证据保留。凭据沿用既有隔离演示来源，不在本交付发送。采购/复核角色叠加负向后已恢复，重启读回职责不变。

主控需补的可见操作（无需重放全部HTTP业务）：

1. mfg-e07进入制造控制台，确认与“制造运营”旧分组身份唯一、页面可达；排程实际派工/机台/工装/人员选择及已有占用与拒因可读。mfg-e02能看到批准/取消及承诺入口，mfg-e07没有运营发布按钮。
2. mfg-e13看采购净额：真实PO选择、独立复核、规范需求核定人/依据、旧PO历史净额核定；mfg-e08仅净价提交；mfg-e01看超过阈值的批准入口。不得把含税null显示成净价0。
3. mfg-e02/mfg-e10看当前故障版本会签；mfg-e10/mfg-e05/mfg-e01看已保存实际报废单的签署历史、金额与角色按钮。数据单据保留，不另造设备/NC。
4. mfg-e05工程变更页看工作令适用版本A/B/A、明确图纸/工艺/清单；B图纸仅SO02。浏览器直接打开 `/fixtures/mfgcap-drawing-A.pdf` 与B对应文件。
5. mfg-e10质量库存页及wh01库存页 `/inventory/stock`、移动 `/m/stock` 核质量字段真实显示。MFGCAP-STANDARD当前总量8、合格6、未知2、有效占用6、可用0；MFGCAP-EC-PART跨MAIN/FG总量4且合格4；MFGCAP-EC-IN总量4且合格4。0须保留，缺字段才显示未知。质检放行选项不再显示已耗尽两张额度专用IQ。

准确对象ID见 `UI-FIXTURES.json`。父此前v1六项IAB与sol-remainder原UI证据继续有效；本增量新增控制台/质量字段/菜单编号需新读回。此writer不具本聊天IAB，未尝试Chrome或用户接管路径。

## 明确边界

- 当前控制写按租户串行，换取跨适配器与多进程原子性，存在吞吐取舍；没有将所有普通项目读写全局串行化。
- E13人工需求核定是有据业务责任，系统不能识别没有任何证据的隐匿同需求。跨PO/供应商累计只针对相同规范需求，未任意合并全供应商历史。
- 历史无证库存仍未知。未凭迁移伪造合格，也未修旧共享库存。新明确人工质量核对入口要求E10、真实库位、数量和依据，不能用它跳过采购来料来源。
- 旧成本表在隔离库无历史样本。本轮未写成本表，迁移旧行保留、代码无成本回写可核；**没有历史成本快照前后业务样本**。实际报工和外协报价历史比较已完成。
- 旧中性放行事件在引入完整回执缓存前只存原事实与请求hash，其重试仍返回该原事实；新受控物理/中性放行均持久化完整原回执并已证明耗尽后重试。未伪造过去未保存的库存展示快照。
- 新控制链为实际PG运行接线；未声称无PG的旧内存测试装配具有全部新增持久化业务保证。未接外部财务/付款/真实物流，CLM01与D-18新范围未纳入。

产品源码和最终运行已停止变更，保留供主控接收；IAB及产品最终接受由主控完成。
