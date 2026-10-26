# 状态快照

更新：2026-10-27 晨②（**【/goal 激活】图文档管理完整实现并交付（调研回传后全量实施）+每小时巡检防额度中断（automation-图文档交付每小时巡检在挂）**；交付物清单+排期裁定见下；上一快照：收版循环 Goal 确立）

## /goal 图文档管理完整交付（2026-10-27 晨②激活）

- **交付物清单**（"完整实现"口径，总控按 goal 授权裁定）：P0 呈现面（验收在途）+P1-a 发布→待办通知（实施在途）+P1-b 工艺路线互链（O1 裁定=最小互链形态做）+P1-c 图号索引端点（O3 裁定=最小端点做）+P1-e 签名引用 URL（O5 裁定=复用 HMAC 基座做）——**P1-d 移动查看页裁定归 M5 统一做（O4）**；#88 v2 不捆绑（O2）；水印/租户许可配置面=P2 对账驱动不在本目标（调研定义）
- **收口判据**：五项全 ACCEPT+全仓 verify exit 0+合流 push 成功 → status.md 登记图文档交付完成+巡检定时自删
- **额度防线**：每小时巡检（[1302] 退避 5 分钟重派/[1308] 读重置点届时自动重派；并发 ≤4）
- 在途：D-24b 验收（收版循环最后一块）/P0 验收/P1-a 实施——三者收敛后腾位派 P1-b/c/e
**【自我驱动主线 Goal】v1.0 收版迭代循环确立：迭代单元=grokbot 测试轮→修复波→合流→复测；收敛判据=一轮零新缺陷+零回归+D-18 数字核对通过；满足即执行收版（版本号+tag v1.0.0+基线宣判+报告归档）。当前第 6 轮在途（仅剩 D-24b 撤销闸门接线）**；上一快照：10-26 晚 fix-wave-6 全线闭环）

## v1.0 收版迭代循环（2026-10-27 确立，总控自我驱动）

- 轮次史：R1（功能测试 115 用例）→R2（SaaS 复测）→R3（retest-541ffff）→R4（retest-8abac21）→R5（retest-e0eabfc）→R6（retest-59c9f8d 终测，在途）——累计 22 项缺陷全闭环
- 本轮（R6）剩余：D-24b 撤销闸门三闸门组合根接线（在途）→ 终验（D-23 转单容器 committed/D-24 撤销端到端/D-25 level2_review/D-21 SSE 权限/O-1 /bigscreen 已全部单项实证）→ 合流 push → grokbot 终验邀请
- 收敛判据与收版动作见循环定义（判据三条同满足才收，不接受"差不多绿"）
**fix-wave-6 全线闭环+PRD 路线图可自主实施项清完宣判：6b 三批（S9/B3/S6）全 ACCEPT 合流；功能补齐波（报表/大屏/派工/质检/A14/S9/B3/S6）累计交付 20+ 功能项；Owner 决策清单+收版建议交付**；上一快照：午⑥ 6a 批合流）

## retest-e0eabfc 消化（2026-10-26 晚③）

- **四项转绿确认**：D-17（三租户 admin 200/无凭据假 token 跨租户 401/viewer approver 403）/D-18（200，A10 日批 08:10 首跑数字明日核对）/D-19（1080p 渲染+待定标注）/报表中心（9 指标 6 源出数与造数逐项吻合）；权限矩阵 299 路由×16 组合零 5xx 零越权；B-2 对上（103/168+14）；回归零退化；D-1 双序重启三租户 200
- **D-21/O-1 ✅ 全链闭环（10-27 晨）**：D-21 authorized() 补 report:read（判定链同源 AuthGuard/401-403 分离/PUBLIC_STREAM 显式旁路）+O-1 /bigscreen 前缀+nginx 窄域回落（含裸路径 302）——验收 ACCEPT（agent_caa046a0，8+10 测试亲跑+对抗用例判权限码非角色）；复证：宿主四态+容器（admin 200/跨租户 401/直开 200）
- **retest-59c9f8d 终测消化**：通过面 D-17/18（格式）/19/20（三租户流=快照）/16/15（三租户 MAIN）/报表/货架/采购价/列偏好/派工批操作导出/特采/批量判定全绿+零回归；**新三缝隙 D-23（装饰器漏转发 transfer）/D-24（PG 缺 revertJudgment）/D-25（多级审批装配无入口）修复在途**（组合态/部署态缝隙模式——单模块测试绿全模块才暴露）
- **O-1（P3）**：前端路由与 API 路径冲突（刷新 401 JSON）→ 随 D-21 同 writer 修（路由换前缀）
- **D-22（P3）确认为已登记待实现**：报表中心导出+web 页（PRD 20 册勘误已记导出零代码；web 页归 web 波）——非新缺陷
- DP-05 被同图号×工序占用互斥拦截=6a-1 件 2 设计内正确行为（grokbot 判定一致）

## retest-8abac21 消化（2026-10-26 晚②）

- **已修待复测**（grokbot 测 8abac21，修复在后续合流 dde51e8）：D-17 大屏鉴权（report:read 零凭据 401）/D-18 A10 装配（200）/D-19 web 大屏页/报表中心 404（控制器+六源 200+出数）——REWORK 批已闭环，拉最新即过
- **D-20/D-16 ✅ 全链闭环（晚②）**：实施（D-20 逐租户包裹+A10 同根因收口/D-16 code 语义+每租户 MAIN seed）→ 验收双 ACCEPT（agent_9c586cb8；全仓 timer 路径完备性核查无遗漏）→ **容器终验**：tenant-b 无仓收货 committed 回落本租户 MAIN；SSE 帧 kpi.inProgressWorkOrders=10 与快照接口一致（grokbot 缺陷场景双口径对齐）。收口坑登记：migrate target 镜像需单独 rebuild（server build 不覆盖）否则 seed 跑旧版；compose 缺省 -MAIN 保空串逃生口（验收裁定维持开箱兜底）
- 复测确认修复：D-14（入库/发料/预占扣减 6→4）/D-15 显式仓路径/移动端 16 页无权限终态/核查预占（幂等+重启存活）——**上轮三残留全部闭环**
- P3 登记：附件签名密钥内存生成（跨重启 URL 404 设计内；**多实例部署需 env 固化密钥——生产前置清单+1**）；B-2 计数再刷（server 103/web 168+14）；WO-09 已登记设计内

## 6b 批收口（✅ 晚，三批合并验收 agent_5c62f593 全 ACCEPT）

- **S9 价格台账**（RREQ-MD-019/020）：台账端点+初始价格——排序合同单点纯函数/PG 零 raw SQL/容器复证 200；costing 联动未扩（U9 教训执行）；组合根接线总控补齐（StorePorts 三处+register 传参）
- **B3 货架**（RREQ-IV-002）：独立两表层级兼容/四级保护/落位解析器 4 处/RLS 106 守恒/容器复证 committed；668+207 全绿
- **S6 三级审批**（RREQ-IS-037）：三级链/或签/实时解析不落库/统一文案/零回归；一级审批人=manager 口径待 Owner 终裁
- **容器复验**：台账 200（分页+初始价格回显）/货架建 committed+列表 200/S6 零回归语义；全仓 verify exit 0
- **路线图宣判**：PRD 506 项中"已定义待实现"的**可自主实施项全部清完**（fix-wave-6 六批+REWORK 累计 20+ 项落地）；剩余待实现项全部带前置条件（Owner 裁定/跨域大项/后续波）——见 Owner 决策清单
**fix-wave-6 波 6a+REWORK 全部闭环：派工五件/质检三件/A14/大屏四项/报表四项全 ACCEPT，全仓 verify exit 0，容器复验五点全过（report-center 200+出数/A10 修复/鉴权 401/列显隐）；6b 最后三批（S9/B3/S6）派发中**；上一快照：午③功能补齐波开工）

## fix-wave-6 6a 批收口（✅ 午⑥，七实施+六验收全闭环）

- **6a-1 派工五件 ACCEPT**（agent_3f09e827）：转单+审计/占用互斥/Excel 导出/批操作+外协行取消——56+168 测试；三处口径分歧登记 PRD 16 册（转单整单形态/done 释放/跨令键）；PG 适配欠账由补齐线收口（202/202+server 消费新 dist 绿）
- **6a-2 质检三件 ACCEPT**（agent_7db584e6）：S5 特采/批量质检（整批原子）/撤销质检（回待检）——631 全绿；撤销组合态接线前恒拒（fail-closed 设计）；双记口径裁定建议留 Owner（推荐特采自动落 disposal 联动合一）
- **A14 闭环**：五项过+装配断链阻塞项总控一行修复（StorePorts 转发——本日第二次同型事故，防再犯护栏=新增可选项必须带转发行+哨兵断言）
- **大屏 REWORK 复审 ACCEPT**（agent_60c64a92）：四项修复三重证据闭环（亲读+亲跑+真实 main.js 复现）；36 条新测
- **报表 REWORK 收口**：控制器注册+六源十键绑定+4 求值测试；**容器复证：GET /report-center/metrics 200、POST query 真实出数（六源 PG 形态激活）**
- **容器复验批（总控，29 模块栈含 screen/column-preferences）**：report-center 200+出数/machining-daily-stats 200（A10 修复前 500）/screen 零凭据 401（修复前公开 200）/列显隐 200/全仓 verify exit 0
- PRD 16/17/20/22 四册增补登记落账；Owner 裁定清单累积：双记口径/批量语义报备/占用三分歧（已登记不改码）/多人报工/撤销完工回退/完工闸门/让步入库联动/D-3 六项
**功能补齐波开工（Owner 点向路线图"并行安排做完"）：第一波三线并行——六张报表 metric/数字运营大屏/低危三件套+在途核查预占接线；按写入面互斥分批滚动至 PRD 待实现路线图清完**；上一快照：R 波修复循环全线收口 0b7cd35）


## 6a 波验收与 REWORK（2026-10-26 午⑤，6a-3 裁决 agent_0217a824）

- **D-15 ✅ ACCEPT 收口**：四件套全过（透传链/null 安全/seed 幂等/三态测试 102 绿），容器全链在案
- **大屏 REWORK（4 项，返工 writer 在途）**：P1 A10 存储装配断链（factory 恒 undefined+`!` 掩盖，端点 500 实锤）/P1 快照端点无鉴权公开 200（AuthGuard 语义：未声明码即公开）/P1 web 大屏页不存在（原登记失真）/P2 screen 零测试
- **报表线 REWORK（4 项，返工 writer 在途）**：P1 ReportCenterController 未注册=死代码（404 实锤）/P1 六源绑定缺失（503 unbound）/P2 新 metric 零求值测试/P2 登记失真（"五张"实 2 条+导出零代码）——PRD 20 册增补 #2 勘误已落
- **验收方法论沉淀**：零 DB 运行时探针（起服实测）抓出 4 个"代码绿但运行断"的装配缺陷——verify 绿≠链路活，装配层验收必须实测

## 容器级复证三件套（✅ 18:15，总控，SaaS 栈 27+screen 模块）

- **大屏**：GET /screen/digital-operation → 200；SSE 流 /screen/digital-operation/stream?token= → "stream open"+snapshot 数据帧推送（?token= 认证为设计内形态，EventSource 无 header）；Docker build 随 npm 网络恢复成功
- **D-15**：全链贯通——采购申请（kind=standard）→订单承接申请→approve→issue→**receipts committed（payload warehouseId 显式路径）**→质检单 `standard_purchase|pending` 自动生成（W3-1 收货→采购质检联动真实落单）。注意口径：无申请来源订单（requestIds 空）不自动建质检单（kind 无法推导跳过，设计内）；建单即 objectVersion=2
- **D-14**：此前已验（SaaS 入库 201）

## 限额窗口总控接手收口（✅ 16:45，[1308] 5h 上限 16:34 触发/19:53 重置——三线 writer 全中断，总控主线程接手）

- **收口成果**：全仓 `pnpm verify` exit 0。逐项盘点：①D-15 四件套 writer 已全部写完（payload warehouseId/装配 env/compose 透传/seed MAIN 仓）+预告 2 处 tsc 已修——总控验证收口；②大屏线：business-store 197/197+tsc 0（守恒计数收口完成）、engine-reporting pack 就绪、application screen 域层五文件就绪——**唯 module 装配层（ScreenHttpModule/parseDailyTenants）未写**，总控回退 app-registry 装配块（注释留位）保 verify 绿，归 19:53 后续做；③报表线：engine-reporting REPORT_CENTER_PACK+application report-center 就绪（陈旧 dist 假红经重建消除）
- **大屏装配收口（✅ 17:05，总控接手升级为"提前完成"）**：writer 实已写完 apps/server/src/screen-http.module.ts+screen-broadcast.ts（SSE 推送+A10 日跑批+双控制器），仅 import 源笔误+缺 parseDailyTenants helper——总控修导入/补 helper/恢复装配块，全仓 verify 复跑 exit 0；**宿主零 DB boot 冒烟通过**：server ready + GET /screen/digital-operation → 200 真实聚合快照（topBar/KPI 出数）。提交 f0ac059 已推 GitHub（网络阻断 16:50-17:00 由 Owner 恢复，期间 3d2a57c 已推、f0ac059 延迟推送成功）。Docker 容器级 build 因 VM 内 npm registry 仍断暂缓（宿主 SSH 已通），归 grokbot 复测环境或网络全恢复后
- **验收欠账**（19:53 限额重置后补）：D-15 验收、大屏验收、报表验收（报表线代码+测试已随 verify 全绿，只差独立验收）；已闭环：D-14（修复+容器复证+验收 ACCEPT）、#38（验收 ACCEPT）、移动端（验收 ACCEPT）、低危三件套（ACCEPT）、大屏装配（总控收口+boot 冒烟）
- 教训复用：跨包 tsc 假红=兄弟包 dist 陈旧（第二线已登记坑），先 build 再判真红

## 功能补齐波（进行中，2026-10-26 午③，Owner 指令"并行安排做完"=路线图点向）

- 滚动策略：按写入面互斥分批，每批回传验收后滚下一批；每批 code-writer-pro 实施+code-reviewer 验收；跨域只读经既有端口，在途域禁碰（缺读面登记不做）
- **第一波（4 线并行）**：①核查预占接线（欠账清偿，listing/inventory/wiring）②六张报表 metric（A1/A2/A4/A6/A7+D-RP-01 导出，standardreports/reporting 域+web 报表页）③数字运营大屏（A8 聚合+推送通道+前端页+A10 日统计，engine-reporting/新装配+web）④低危三件套（D-11 HTTP e2e/404 分叉 e2e/hasPassword 投影，org+server tests）
- **第二批候选**（第一波回传后）：派工深功能批（S1/S2 转单审计+打印版式+D-DP 族）——等 dispatch 域空闲
- **第三批候选**：零散功能批（S5 特采/S9 价格台账/B3 货架/批量质检/撤销质检/多人报工/S6 配件审批/A14 列显隐）
- PRD 各册"已实现"状态升级随批次收口做增补登记（append-only）
**grokbot 测试报告修复循环 R 波：D-8/D-1/D-2 三缺陷全链闭环（修复+容器复证+验收 ACCEPT），wave-2/3 并行在途**；上一快照：PRD v1.0 冻结：13 分域分册+总纲+README+追溯总表，506 需求项全量需求化，验收 ACCEPT**；上一快照：10-26 凌晨②总控收口 0b8566c/109/109/U 波五模块 ACCEPT）

## R 波修复循环（进行中，2026-10-26 午②；grokbot SaaS 功能测试报告驱动，报告源 noodle-test-output/ 三报告）

- **wave-1 ✅ 全链闭环（本线程）**：D-8 P0 RLS 事务原子性（rls-session 扩展接管 $transaction 交互式形态+ALS 同句柄重派；14 域 event+outbox 数组双写全改交互式；business-store 170 测试）+ D-1 P0 权限按租户 enforcer 隔离（application 566 测试）→ 容器复证：tenant-a 工作令 10/10 201+外协 201+event/outbox 守恒 10/10（修复前 500/15v7 孤儿）+D-1 三租户双向顺序验证全 200+rls-session-proof 双对照 → code-reviewer 验收 **ACCEPT**（agent_9859e205，独立运行时探针证实 Prisma 遮蔽机制）→ 低危注释处置 2 条。容器复证时补建三租户 admin 夹具（superuser SQL 复制 default，方式同 grokbot）
- **D-2 ✅ 全链闭环（本线程）**：用户口令（建号可选初始口令 scrypt+PUT /org/users/:id/password 重置+写时全端撤会话+跨租户 404 收口；application 572/business-store 170 测试）→ 容器复证五步全过（建号→登录 201（修复前永不可能）→重置→旧 401 新 201→跨租户 403 原口令未篡改）→ 验收 **ACCEPT**（agent_5d49fea3；低危 4 条登记：hasPassword 投影 P3 后续等）
- **D-9 ✅ 复测确认真缺陷**：派工 10 报工 11 committed 无拦截（总控容器复现）；修复排 fix-wave-4 W4-1（累计有效报工量上界，排除 S14 精算防扩盘）
- **wave-2（侧边栏线程）**：9 项 P2/P3（D-7/D-11/D-4/D-5/D-12/D-6/D-13/B-1/B-2）合同 architecture/contracts/fix-wave-2/，在途
- **wave-3 ✅ 已收口（第三线总控回传 14:40）**：W3-1 intake 双路接线（末道报工→自制质检 + 收货→采购质检，#34~#37 四适配器；组合态 e2e 新场景+64/64）与 W3-2 撤销派工→issue.cleanup（24/24）均 code-reviewer 验收 ACCEPT；W3-3 门禁半面经范围咨询裁定登记不做（listing 工序面未落库+processId 无锚点，强行接线=发明语义；空列表半面已锚定零改动）、W3-4 受限条款触发不做（PG 适配器在 business-store 禁碰面）。实施者 agent_9662223e/agent_0e83ddf9，验收 agent_a923957a/agent_4a53f454+咨询 agent_8ef6e954。总控容器复证：外协回厂质检链全通（insp 单创建+判定负例拒 6>3）——此前疑点解除（系实验漏 start 步）
- **D-9 ✅ 全链闭环（本线程 W4-1）**：报工上界闸门（累计有效报工量≤派工数量，链尾+排除撤销，batch 整批拒；application 577 测试）→ 容器复证三段全过（报 11 拒/6+4 过/满后再报 1 拒，理由逐字吻合）→ 验收 ACCEPT（agent_dec15c08）；audit-edit 上调不过闸门经裁定登记低危（report:audit 受信权限面+可撤销补救，PRD 17 册增补已登记）；并发竞态边界与 S14 精算同批收口
- **合流前必修项已清（总控）**：wave-3 交付的 tests/listing/receipt-inspection-intake.test.ts 8 处 tsc 泛型错误修复（envelope 辅助函数签名收窄+import），application tsc 全绿+3/3 测试过
- **wave-3 交付的 PRD 增补登记（总控，append-only）**：17 册增补#1（开放问题①闭合+闸门半面）；14 册增补#1（RREQ-LP-051 W3-3 裁定）
- **D-3 限额暂停与恢复**：PG 对象存储适配器 writer 首派撞 [1308] 5 小时上限（16:07:31 重置）——已设定时 automation-41edfd32（16:09 一次性重派），装配切换行留合流时总控加
- **wave-2（侧边栏线程）**：9 项 P2/P3 合同 fix-wave-2/，在途（其 capability 2 失败属本波 A-2 approval 改动，wave-3 回传归属笔误已修正）
- **fix-wave-4 合同已预写**：W4-1 D-9（等 wave-3 解锁 reporting）/W4-2 D-3 附件 PG 持久化（等 wave-2 解锁 attachment；定向方案 ObjectStoragePort PG 适配器）
- **BLOCKED 链路预验（总控）**：报工核查 ✓/重复核查幂等 ✓（信封 rejected）/成本重建全链 ✓（costing.model.publish→rebuild 双 committed 快照落账——欠账清单"须先跑 rebuild"实为"先 publish 再 rebuild"）；外协完成→回厂质检单未创建（两实验 0 单）疑点固定——因当前镜像是 wave-3 半成品（正改质检 intake），终态镜像复验后定性
- **D-3 ✅ 三方闭环（15:45 补齐）**：实现主体=第一线 writer（14:46 派，撞 [1308] 限额断在收尾前——PG bytea 适配器+双迁移+RLS 102 表+装配切换全落树）；收尾=第二线（两行计数 101→102：project-cost 断言+rls-proof 常量）；验收 ACCEPT（第二线 agent_fffec981，高危点核实：令牌租户绑定语义经共享 read-reference-tokens 结构性继承）；**容器复证（第一线 15:45）：上传→docker restart→签名 URL 下载内容原样返回 200（修复前 502），attachment_objects 表落行**。装配语义：SMES_ATTACHMENT_DIR→文件适配器（显式覆盖优先）＞DATABASE_URL→PG bytea＞零 DB→内存（诚实回落）
- **wave-2 九项事后验收 ✅ ACCEPT（agent_c2d6827d，15:40）**：逐项亲读 diff+亲跑四包测试（web 143+14/product-ui 130/application 577/server 70）全绿；低危三条登记（TESTING-GUIDE 计数半新半旧已顺手清偿/D-11 无 HTTP 层 e2e 断言/未知租户 404 分叉无直接 e2e 系历史欠账）
- **合流收口（✅ 15:15，Owner 指令"发布到最新 GitHub"）**：全仓 `pnpm verify` exit 0（三跑收敛：①application baseline 事件排序 flaky 根因修复=同毫秒 occurredAt 下 uuidv4 次级键掷骰子，改稳定排序落插入序；②wave-3 intake 测试 8 处 tsc 泛型收窄；③capability e2e 适配 D-11=预置共享 userStore 真实用户身份）。**提交内容分层**：有完整证据链（修复+复证+验收 ACCEPT）=wave-1 D-8/D-1、wave-3 W3-1/W3-2、D-2、D-9；**verify 绿但待验收**=wave-2 九项（侧边栏线程产出，实现亲读过 D-7/D-11 正确）+D-3 PG 对象存储半成品（writer 撞限额遗产，verify 过但无回传证据链，装配切换行未做——定时 16:09 重派收口）。grokbot 补测即外部验收（8 条 BLOCKED+RP-01/D-9 已由本线代复+7 条 N/A 用例修正重跑）

## PRD v1.0（✅ 10-26 午，Owner 指令"对照 73 份开发文档搭建完整需求文档"+三决策：SRS 形态/全量需求化+差异登记/一波全量并行 GLM-5.3）

- **产出**：`architecture/requirements/` 16 文件 4236 行——00-README（体例/编号/冻结纪律）+ 01-总纲（产品定位/角色模型/主流程链/全局约定 10 条）+ 13 分域分册（10-SYS~22-INT，27 模块全覆盖）+ 30-TRACEABILITY（分册总表/109 项↔册映射/73 份源文档逐份落点/差异号全表/实施者身份）
- **规模**：506 需求项（已实现 347 锚点到 file:line｜部分实现 32｜已定义待实现 127=产品补齐路线图）；差异号沿用 A/B/S + 新编域前缀 D 号 106 项（并行裸号撞号由总控合流统一重编）；"部分实现/待实现"全部只登记不派发（扩盘刹车）
- **执行**：总控预制 3 文件+13 册并行 code-writer-pro（GLM-5.3）派发；六册首派撞 429 限流按纪律退避重派成功（13 册两轮）；总控合流（D 号重编/互引修正/计数复核）+ 5 条验收低危全部即时清偿（SYS-055 锚点漂移/DP-013 万分比写法/IV 权限码计数/TRACE 合计/agentId 落点说明）
- **验收**：code-reviewer（GLM-5.3，agent_de0a2a99）**ACCEPT 无必改项**——四问全过：73 份落点无空头（4 份源文档深读原文对照）；41/347 锚点抽样零虚构；6 处关键口径与 m2/m3/u-wave 合同一致无第三套口径词；差异登记诚实（U9 刹车处置、部分实现克制性均核证）。同族验收记账
- **冻结**：v1.0（2026-10-26）——正文不动，变更进各册文末增补登记节（append-only），Owner 保留推翻权；宪法层 README 已补 requirements/ 行；TESTING-GUIDE §5 分层地图已升级指向本体系（需求基线层）
- **体系价值**：需求→合同→实现→测试四层链路闭合；127 项待实现即"从 109/109 到源文档全量"的显式路线图，后续 Owner 点向即从此取材

## 总控收口（✅ 10-26 凌晨②，Owner /goal 授权"统筹合并+提交 GitHub 主线"）

- **提交链**：`4abe16e`（S/T/U 三波全量：96 M+136 新文件——S1 后端 10 项/S2 桌面 61 页/S3-a 管理页/S3 移动 19+1/T 能力子集五项/T2 Playwright e2e/U 波五模块）→ `0b8566c`（并入 lane/m4-final：M4 部署期收尾+M5 收尾）
- **合并冲突三处语义并集**（M2 线预检指南 + 实况扩展）：pg-baseline-stores orderBy 取分支数组形态（双侧各自独立修同缺陷）；pg-dispatch/pg-listing 工厂取分支 RLS client 包裹 + 保留 U5 aftercareClaimStore/U4 processMaterialStore 新行（改喂 client）；**补齐 U1 issue 工厂漏掉的 RLS session 包裹**（其余新模块 T1/U3 均有，U1 独漏——合并期发现并修）
- **终验**：全仓 `pnpm verify` exit 0（server 54/testkit 77 末段亲见，全链无失败）；lane/m4-final+lane/m5-final 分支已删
- **推送**：`git push origin main` 成功（127e353..0b8566c）；工作树零脏文件
- **U 波（文档增量，Owner 全面解禁 73 份开发文档为需求输入）**：issue 发料链路（489 测，含一轮 REWORK 终裁）/ report-center 报表口径包 6 metric+下图统计 / attachment 文件管理（509 测，对象存储纯端口）/ process-material 原材料关联表（96 表）/ aftercare-claim 售后报销（98 表）——五域全 ACCEPT；接线（组合根注册+跨模块端口+exports 子路径+rls-proof 计数 bump 98）归下一波
- **实施者身份登记**：U1 agent_17c268c9（返工同线）/U2 agent_225f94a2/U3 agent_2e9d0024/U4 agent_15f73203/U5 agent_5b5716e1（均 code-writer-pro GLM-5.3）；验收：47eba422/a41c11f6/0a9af908/f19c05d5/aaadf550（均 code-reviewer GLM-5.3 同族记账）
- 总控账本：cadence-runkit-s3（cadence-s3-mobile-lane-20261025）全程 checkpoint 在案；协调账本 cadence-runkit 双线均已终局关闭


## S3 波（✅ 10-26 深夜，五线并行）

| 线 | 结果 | agentId |
|---|---|---|
| a 前端大线 | 六 CRUD 页+audit 页+四报表页（响应自描述动态列，不引后端包守铁律）；boundary 1116→1132 模块零违规 | agent_0879ad12 |
| b 命令链 e2e | **10/10 全过**（15 模块真实栈+页面数据通道+五处 PG 取证+双负行为）；**抓出齐套接线缺口** | agent_05a21272 |
| c 矩阵重排 | 三口径：后端 109/109、桌面 65/80、含移动 74/109（S3 前基线） | agent_d3ad96c3 |
| d 移动 19 项 | **19/19 全就绪**（15 路由码+11 子页，lead 演示身份；7+14 项能力子集与 e2e 深度项如实留档） | agent_b3eec54f |
| e 齐套接线修复 | cross-module-wiring #25/#26 迟到绑定+注册两行；**齐套拦截从"真实栈不生效"到完整缺口驱动拦截**；RUN_E2E 10/10 复证 | agent_d232f81f |

合流终态：`pnpm verify` exit 0——**1132 模块/3574 边零违规、1257 测试全绿**。

**"完整重构成功"剩余**：能力子集 5 项（总览/菜单 CRUD×2/通知中心/审批配置）+浏览器级 e2e 深度+**活系统行为等价对账**（36 场景基线+手册就绪）+Owner 四决策（活系统访问/R7/R8/版本锚 ee16599）。


## S 波（✅ 10-26 晚，满窗口三线+总控微修）

| 线 | 结果 |
|---|---|
| S1 后端 10 项 | 交付→独立验收 REWORK（#91 零工幻影行+ #92 虚假陈述）→返工（口径层根过滤）→总控复证闭环 **ACCEPT**；e2e-backfill 62 断言+四套回归零失败 |
| S2 九模块页面 | **61/61 挂载**（33 页+28 菜单叶，fetch-stub 钉形状；前次中断残留 25 页审计收编）；构建读回过；页面命令链真实 e2e 留 S3 |
| S4 对账基线 | **36/36 场景录制+自洽对跑全过**（录制栈实证）——回归安全网成立；发现 baseline 真缺陷 |
| 总控微修 | **baseline orderBy 缺陷**（泛型 delegate 上 Prisma 6 仅收数组形态→process/routing/outsourcing 读写全 500）：亲测复现→修复→四路径 201/200 复证→baseline 场景重录→5/5 对跑过 |

- **对账基线使用语义**（S4 登记）：reference=录制环境指纹的幂等回放态，重放需按 M2-RECONCILE-GUIDE §4/§9 准备环境（准备链 A–F 或快照恢复）；fresh 栈直跑非回归信号
- **覆盖度**：后端 109/109（100%）；端到端 ~80/109（~73%）——余 S3 批（六 CRUD 页/四报表页/移动 19 项）+活系统对账
- **合流 verify exit 0**：1076 模块/3310 边零违规

**待 Owner 四决策**：①活系统访问（对账执行前置）②R7/R8（决策单 coverage/DECISIONS-R7-R8.md）③版本锚 ee16599 处置（22:05 擅自提交的坏中间态：保留+追加干净提交 / amend / 其他）④S3 批次优先级确认（默认下一波执行）

## R 波（✅ 10-26 午，"完整重构成功"缺口审计与准备）

- **R1 覆盖度矩阵**（agent_10e90474 → architecture/coverage/coverage-matrix.md 339 行 + SUMMARY.md）：109 标准项逐项对照实态（每项带 file:line 锚点）——**后端能力 99/109（90.8%）**；**端到端已实现 13/109（11.9%）**：部分 67（后端就绪缺 Web 管理页面 61 项+能力子集）+未实现 29（后端缺 10：机构/岗位/客户/供应商/计量单位/操作日志/四张标准报表；移动呈现缺 19）。**两个口径都真：里程碑交付口径 vs 109 项端到端口径**——"完整重构成功"的诚实距离以此为准
- **R2 活系统对账准备**（agent_51def2b6 → testkit/fixtures/m2-scenarios/ 36 场景骨架 + scripts/record-m2.mjs + M2-RECONCILE-GUIDE.md）：九模块各 3~5 核心行为场景（含负行为），加载校验全过；映射表草案 76 项如实标"待活系统验证"；**待 Owner 提供活系统访问即可进入清洁室对账执行**
- **R7/R8 决策单**（总控 → architecture/coverage/DECISIONS-R7-R8.md）：R8 建议追认关闭（事实已被 M5 消解）；R7 建议选项 A（Owner 给 9 项明细）或 B（授权 live 只读清点）

**下一波（S 波，覆盖缺口攻坚）泳道取决于 M2 会话收口状态**：后端 10 项 CRUD+报表口径 / Web 管理页面 61 项 / 移动 19 项。

## 总合流验收（✅ 10-26 晨②，M5 收口实证后）

| # | 验收面 | 结果 |
|---|---|---|
| 1 | 全仓 pnpm verify | exit 0：boundary 988 模块/2861 边零违规、六规则自检全拦、全测试块绿 |
| 2 | Web 真实 e2e（RUN_E2E=1 docker 全链） | 4/4（在线落库/幂等/离线重放/门禁——M5 收口实证；默认 skip 为门禁设计） |
| 3 | 四套 server docker e2e | org 35 + approval 31 + mdwb 49 + auth 42 = **157 断言全 PASS** |
| 4 | compose 双形态 --build 终验 | 单机 tenant:default + web 200；SaaS tenant-a 租户贯通 + 未知租户 fail-closed 500 |
| 5 | RLS 双证明 | rls-proof 三面隔离 + rls-session-proof 双对照全过 |

**M0~M5 全部完成**（两线合力）。**待 Owner 三决策：① R7/R8 规格决议（账本挂起）② 首次 git commit（零提交单点风险）③ 收版动作（版本号/tag/基线宣判）**。

## M4 最后一里（✅ 10-26 晨，总控验证收口）

## M2 会话三线（✅ 10-25 夜，验收进行中）——与他线 P/Q 波并行合并

- **M4 首波**（agent_e6c522a6）：双镜像实 build（server/web Dockerfile+per-Dockerfile dockerignore——.env 裁剪不进镜像）/compose 生产要素（healthcheck**探针 Host 感知修复**——saas fail-closed 会拒 127.0.0.1 探针，fetch 禁改 Host 头坑）/verify:rls 根 script（三面 PASS 可复跑）/main.ts SMES_TENANT_MODE 开关（single-node 零回归 37/37；saas fail-fast 三条件+未知值拒启）。**与他线"最后一里"同期各做 hostBased——合并态 main.ts 单接线块语义完整（tsc 0）**，双写去重清单归验收
- **M5 首波**（agent_6063cb0b，**他线 Q1 已裁 M5 归属本会话**）：/m/* 移动路由组（MobileLayout 底部导航+四页：工作台/报工/我的工时/库存查询）+reportingApi laborMinutes 草稿直传（缺省移除）+scan-report 原位升级；product-ui hours/inventory 视图 +8 测试（89）；web 41+4skip、build PWA 13 entries；**离线全链 e2e RUN_E2E=1 实跑 4/4**（在线 committed→幂等拒→断网入队→停服重启 FIFO 重放→落库 3 行）；**他线三件收口已完成**（e2e-scan-report laborMinutes 夹具/tenantId bug/admin 混淆三修）
- **活库冒烟扩展**（agent_c4c46270）：e2e-live-db 14 模块 **74 PASS/0 FAIL**（payroll 35000 分+sourceRefs+xlsx/maintenance due-scan 幂等/drawing 同形 404/metric-pack 六源）；**六源物化活库断言关闭低危#1**（90 双计数/93 准时率=1/94 未入库=10/97 外协 150000 分——真实命令造数零 SQL 直插）；两处诚实真值断言（95 收货仓装配缺口/97 工时金额化待 R-M3-1）留对账
- 合流：**全仓 pnpm verify exit 0**（16 包——business-store 133 含他线 RLS session、web 41 含双方 M5）；server 37/37 零回归
- 验收：code-reviewer 只读验收（agent_f20def6e）**ACCEPT 无必改项**——四问全过：M4 合并正确性（**单一接线块无双写**：全仓 grep 证实两条 hostBased 路径未同时接线；runWithRlsTenant 与他线 rls-session $extends 为**互补必需件**（ALS 桥接）非冗余；verify:rls 独立复跑三面 PASS）；M5 质量（离线 e2e 独立复跑 4/4；对他线三处修复全部判定正当且无回归）；活库冒烟（74 PASS 复跑 3 次稳定；两源手算核对正确；两处诚实缺口定性属实）；回归纪律（全仓 verify 独立复现 exit 0；无密钥泄漏——.env 裁剪/pg-init 绑定变量均核）。**双写去重清单五项登记**（探针三处重复/proof 脚手架互复写/rls-session 头注陈旧/e2e 脚手架三持/TenantResolutionError 500→宜 4xx）——后续波顺手清
- **三线 ✅ 完成态：M4 首波 + M5 首波 + 活库冒烟（低危#1 关闭）全部验收闭环；两会话并行合并树全仓 verify exit 0**


- 接线本体已由并行会话在 apps/server/src/main.ts 完成（SMES_TENANT_MODE 开关/hostBasedTenantResolver(SMES_DOMAIN, SMES_TENANTS 静态清单)/runWithRlsTenant RLS 电流贯通/未知配置 fail-fast）——总控按不重复纪律转为**验证收口**
- **双形态业务读回全过**（SaaS 栈 `--build` 重建后）：Host `tenant-a.smes.example.com` → `/health {"tenant":"tenant-a"}`、tenant-b 同理各自租户；**未知租户 tenant-x → 500（fail-closed）、域外 Host → 500**；单机形态复验恒 'default' 零回归；rls-session-proof 双对照 20 PASS；server 37 测试绿
- **教训登记**：栈验证必须 `--build`（首轮旧镜像导致三面假失败：恒 default + 未知租户 200）
- M4 全景闭环：RLS 80 表行级隔离 + session 接线四工厂 + Dockerfile×2 + compose 双形态真实栈 + 迁移工具骨架 + Host 租户解析贯通——**ADR-0005 双形态（买断单机 ↔ SaaS 订阅）技术路径全线打通**；剩余属部署期（真实 DNS/TLS）与后续波（租户管理流程/异步查库 lookup/余 14 工厂接线）

## Q 波（✅ 10-26 凌晨②，账本 D6 点名 he 线承接 M4/M5 正式）

| 线 | 内容 | 实施 | 结果 |
|---|---|---|---|
| Q2 M4 收尾 | rls-session 上提 src/ 顶层（跨域引用六处更新、公共 API 零变化、133 测试零回归）+ **SaaS profile 真实起栈**（Host 头子域名路由经 proxy → server 200、单机形态复验不回归、双向 down -v 干净）+ 陈旧注释修正 | agent_2c80185a | 全过；rls-session-proof 复跑全过；边界如实（DNS/TLS 属部署期、server 租户解析接线为 M4 后续接缝） |
| Q3 迁移工具骨架 | deploy/migration/（26 文件 37 单测）：源端口（CSV RFC4180 流式/JSONL）+ 映射引擎（类型转换/常量注入/双模式错误处理）+ 目标端口（内存/dry-run/主数据鸭子适配）+ CLI 报告 + **testkit 对账衔接**（迁移→导出夹具→ReconcileHarness 2/2 零 diff）；**零硬编码源 schema**（清洁室：源 schema 是运行时配置不是代码，73 份文档禁用重申） | agent_1a0a7cf9 | 七条 Done-when 全实证 |
| Q1 M5 正式（部分交付+裁决） | reportingApi 真实通道（report:submit 六文件对齐）+ ShellLayout 抽屉桌面响应式 + verify-pwa.mjs 24 断言 + e2e beforeAll/门禁——**与 M2 会话的 M5 首波撞线**（对方 /m/* 移动路由+MobileLayout 先占且更贴 M5 本义），Q1 按纪律停手上报 | agent_c3b4d2e7 | 总控裁决：**M5 owner 归 M2 会话**；Q1 三项贡献保留在位（通道主体对方已继承）；menu.test/e2e 三测试/README 归 M5 owner 收口 |

合流 `pnpm verify` exit 0：boundary **989 模块/2865 边**零违规、16 测试块全绿（含双方 M4/M5 改动）。RunKit checkpoint cp-qwave-20261026。

## P 波（✅ 10-26 凌晨，三线并行 + 总控接线裁定）

| 线 | 内容 | 实施 | 结果 |
|---|---|---|---|
| P1 M4 正式核心 | RLS session 接线（Prisma $extends：每操作事务内 SET app.current_tenant，门控 SMES_RLS_SESSION）+ server/web Dockerfile（914MB/78.5MB，multi-stage）+ compose 真实栈（migrate+seed+REVOKE 台账+\set 口令+127.0.0.1 绑定）+ 生成器 dedup 守卫 | agent_ad51619a | 双对照 proof 全过；**总控裁定 ESCALATION-1 后亲自接线 masterdata/workbench/approval 三工厂**（各一行），proof 探针转正式断言全过；**compose 终验全绿**：app_user+RLS 下登录（scrypt+会话穿 RLS）→ 全模块 200 → web 双入口 200 |
| P2 低危清偿 | testkit filter 空命中守卫 + recordedAt 严格 ISO 校验（堵 Date.parse 假阴性）+ path `//` 协议相对防护 + CI reconcile --max-age-days 30 + OfflineQueue maxItems=1 测试锚 | agent_7a390c65 | testkit 77 + product-ui 81 测试绿；示例夹具无损 |
| P3 M3 缺口闭合 | maintenance/drawing e2e 51 断言（版本链/幂等账本/钉版本/游标通知/双租户收口/重启存活）+ RLS 表数 36→80 补登与全量重放迁移 + README 装配节 | agent_510af2c3 | 51/51 全过；rls-proof 18/18（80 表）；**发现另一会话已落地 M3 组合根面（R-M3-3 裁定：专业包零框架耦合，控制器归组合根）**，总控裁定 P3 采纳该形态与草案权限码 |

总控裁定记录：①ESCALATION-1 泳道扩展（M1 稳定目录三工厂接线，总控亲自执行）；②P3 REST 形态采纳 R-M3-3；③P3 权限码以草案冻结集为准。遗留：rls-session.ts 物理位置上提（现 org/ 下被跨域引用）；SaaS 请求级租户 DI 接缝（server 侧，M4 后续）；ESCALATION-2 注释已留。

## M5 预研线（✅ 10-25 深夜）：PWA 骨架 + 离线策略形状 + 扫码报工页形状

## M3 三包（✅ 10-25 午，实施+接线完成，验收进行中）

- maintenance（agent_92c1503c，20 测试）：任务状态机配置化（scheduled→executing→done/cancelled，G2 先落投影）+due-scan 信封命令（幂等三防线：确定性 operationId+faultRef 去重扫描+内存消费位）+故障联动结构同形镜像（零 import baseline，组合根粘合 #22）+五品牌 ID；business-store 结构同形 PG+迁移 070000
- drawing（agent_4da39010，20 测试）：drawing.publish.v1+钉版修订链（DrawingRef）+**查看留痕不变量（fileRef 唯一取得路径=留痕后）**+**超等级与不存在同形 404**+保密两级（public/restricted）；迁移 080000
- metric-pack（agent_e0123033，29 测试）：**六主口径+两明细**（88/90/93/94/95/97 行为重述定义，对账阶段校准数值）+MetricPackActivation 冻结快照+版本复算+六源 PG 适配器束；迁移 090000
- 组合根接线（agent_0b4324a3）：三 HTTP 面（**逐路由 @RequirePermission**）+三过滤器+注册/StorePorts+wiring **#22 故障联动**（FaultResolved 悬挂不自动同步）/ **#23 附件钉版编码 drawingId@vN** / **#24 六源租户收口**（每租户 MetricPackService 缓存）+boot **14 模块**场景+e2e 四正路径（含同形 404/求值出数）
- 总控预置：.dep-cruiser.cjs metric-pack 白名单（R-M3-4 闭合）+boundary-selftest 三夹具（6/6）+正式 install（maintenance engine-flow 链接收录 lockfile）
- 合流证据：business-store **123/123**（80 表 RLS 三次重放链守恒）+ server **37/37** + depcruise **958 模块零违规**；**全仓 verify deferred**（他线 testkit cli WIP 活跃——filter 空命中守卫，非本线面；RunKit 已登记）
- 验收：code-reviewer 只读验收（agent_8d245f5f）**ACCEPT 无必改项**——三包合同逐条落地真实（差异表全行有代码+测试锚点）、pro-pack 依赖面亲查零违规、G1/G2 抽查过、RLS 80 表三次重放链守恒亲验、**组合根 30 条路由逐条亲数全挂权限**、#22/#23/#24 接线语义正确（幂等三防线/钉版编码防泄漏/租户收口亲查六源 where tenantId）、e2e 四用例断言质量核实、全部数字独立复现、payroll 零回归。低危四项登记：六源物化逻辑活库测试挂对账 backlog / rls-conformance 用例名文案 / 每租户 PrismaClient 连接池（M4 评估）/ depcruise 计数漂移知悉
- **deferred 全仓 verify 已关闭**：他线 testkit WIP（filter 空命中守卫）收口后补跑 `pnpm verify` **exit 0**——16 包全绿（testkit 77 含他线新用例），M3 四包+接线全部纳入
- **M3 ✅ 完成态**：payroll + maintenance + drawing + metric-pack 四包 4/4 实施、接线、验收闭环；6 张口径数值校准挂对账阶段（合同明示）

## 分面动态增补（10-25 午，Owner 指令"线程开满继续"）

- **本线认领 M4 首波（双形态部署正式化）与 M5 首波（移动端页面对接）**——Owner 已下"继续/开满"指令，D6 推荐分工（他线承接 M4/M5）就此由本线承接改派；**他线开新 WorkItem 前先对账**（M4 写入面=deploy/**+apps/server Dockerfile+main 租户解析开关；M5 写入面=apps/web/**+product-ui/**）
- 并行第三线：活库冒烟扩展至 M3 四包（apps/server/scripts/e2e-live-db.mjs）

## 收版与并行加速（✅ 10-25 夜，Owner 授权全部建议后执行）

- **D7 闭环：首次 git commit `ee16599`**（M0~M5 全量初版，16 包 verify exit 0 状态入库，工作树干净）
- **并行加速（Owner "分出新的主窗口"）**：git worktree 两新主线就绪——`../Cadence-wt-m5`（lane/m5-final：性能验收/PWA 图标/4xx 映射/预研低危）与 `../Cadence-wt-m4`（lane/m4-final：双写去重五项/租户管理骨架/14 工厂 RLS/迁移工具骨架），各带 START-HERE.md；Owner 各开新 ZCode 窗口即独立主线（真隔离零踩踏，收口后并回 main）
- **剩余硬项不变**：对账阶段（等活系统环境）；R7 清单 9 项内容

## Worktree 两线收口并入 main（✅ 10-25 深夜）

- **wt-m5（agent_b679278f）**：性能验收 PERF-M5.md（组合冷加载 p95 20.6ms/核心 API p95≤2ms/起服 429ms，基线 5~25 倍余量）；PWA 5 PNG 零依赖生成+start_url /m+深链回落修复（mobileRouteFallback+nginx 同形）；business-core reason 结构化+6 锚测试；低危四项清理（precache 15 条唯一+断言锚）
- **wt-m4（agent_9b7392a3）**：探针单份 healthcheck-probe.ts（Dockerfile/compose/main 同源+二进制 smoke）；harness.mjs 抽取；**18 工厂 RLS session 全接线**（3 态×18 单测+容器双对照 22 PASS）；TenantResolutionError→421（全局错误中间件+e2e 6 用例+活体）；**合同外修复：pg-baseline-stores 两处多键 orderBy 潜伏缺陷**（Prisma 必拒，容器路径首次暴露）；迁移骨架判定基线已满足（25 文件 37/37）
- **合并前验收 ACCEPT**（agent_85f0c4d9）：全部证据独立复现（容器 proof 全量复跑/双线活体/深链实测/五套测试面）；合并裁定=租户错误取 wt-m4 全局 421 中间件（测试锚定决定性）+reason 结构化保留+wt-m5 窄捕删；合并活体实证 200/421/421
- **并入 main：`3782c1d`**（ee16599→M4/M5 收尾双 commit→合并 commit）；**全仓 pnpm verify exit 0**（16 包）
- 登记项：内联 404 分支实证不可达（INFO）；逐家容器电流实证 backlog（按域投产时补）；=on 事务原子性边界（costing/payroll 投产前"事务感知扩展"应先行——验收者优先级建议）

## 终版裁定（2026-10-26 晨，Owner 指令"要什么活系统，我们是完整重构，全新的"）

- **对账阶段取消**：新系统为全新产品，不做与活系统的行为等价比对（交接文档清洁室纪律 3 的对账条款就此作废）；**R7 同步失效**（live 清单 9 项不再相关）。规格依据=本仓开发文档体系（m2/m3-drafts 合同+四件套规格源）；73 份雇主文档 IP 红线不变
- **重构工程完成（Owner 定义口径）**：M0~M5 全部实施验收，main=3782c1d，16 包 verify exit 0，两 worktree 线已并入
- 仅余部署期动作：D8 `pnpm approve-builds`（push 启 CI 前交互确认）+ 远端仓库与 push（待 Owner 提供远端/指令）
- **待办合并（给 M1/M4 线）**：worktree 两线成果在分支 `lane/m4-final`（HEAD 3782c1d，含 M4 部署期收尾+M5 收尾双 commit+合并 commit，全仓 verify exit 0 已验）——main 合并被本会话在途 WIP（server/web 同文件）阻挡属正常协调；**你线波次 commit 后请执行 `git merge lane/m4-final`**（**重叠面已预检：仅 3 文件**——①apps/server/src/main.ts：保留你线版本为底，合入分支的 tenantResolutionErrorHandler import+app.use 注册+healthcheck-probe 的 parseKnownTenants 复用（租户错误=分支 421 机制，活体实证过）；②packages/business-store/src/baseline/pg-baseline-stores.ts：**必须取分支的 orderBy 数组形态**（多键对象 Prisma 校验必拒的潜伏缺陷修复，容器路径实证）；③deploy/scripts/rls-proof.mjs：取分支版（改引 harness.mjs 共享脚手架），若你线也动了它则以 harness 引用方式手工合成。分支验证记录见上方"Worktree 两线收口"节），合并后跑全仓 verify 并删两分支

## 待 Owner 决策清单（一站式，2026-10-26 晨；两线自有工作穷尽，全部阻塞于此）

**回复"全部按推荐"即可一次解锁；单项逐条回复亦可。**

| # | 决策 | 推荐 | 解锁什么 |
|---|---|---|---|
| D1 | R7 功能清单刷新（live 比 0920 多 9 项） | 暂缓：等你提供 9 项内容后升 m2-drafts v1.2 映射 | M2 映射完整性 |
| D2 | R8 扫码报工 +12 人日 | 并入 M5 正式线（M5 预研已含扫码报工页形状；M2 已收口不扩盘） | M5 排期口径 |
| D3 | R-M3-1 M3 人日核定（决策簿 30 vs 口径层 25 vs 预热预支） | 按 m3-drafts 建议：payroll 6 / maintenance 8 / drawing 7 / metric-pack 9 = 30 | M3 实施派发 |
| D4 | R-M3-3/4 专业包接线方向 | 组合根适配器（M2 接线已实证同款）+ 事后立 ADR；dep-cruiser 补 metric-pack 名随实施首波 | M3 实施首波 |
| D5 | R-M3-5/6 payroll 与 costing 双口径隔离；图纸保密等级 | 默认不同源；图纸 v1 两级（公开/受限）+查看留痕 | 合同定稿细节 |
| D6 | **M3/M4/M5 实施启动与两线分工** | 本线（M2/M3 规格线）承接 **M3 实施**（消费链就绪）；他线（预研地界）承接 **M4 正式**（deploy/rls）→ **M5 正式**（PWA）收尾 | 下一波开工 |
| D7 | 首次 git commit | 建议尽快（当前全树 verify exit 0、零提交无版本锚点，风险持续累积）；commit 粒度与消息风格由你定 | 版本安全 |
| D8 | pnpm approve-builds | 首次 push 启 CI 前必须交互式跑一次（已知事项） | CI 启用 |


泳道对账干净后派发。实施：code-writer-pro（GLM-5.3，agent_29cf98f5）；验收：GLM-5.3 只读模式（agent_c9b051ce）—— **ACCEPT 无必改项**。

- **PWA 骨架**：vite-plugin-pwa@2.0.0（MIT）——manifest/standalone/SVG 占位图标；SW=导航 NetworkFirst(4s)+PrecacheFallback 离线壳（**关键修正：插件默认 navigateFallback 显式置 null**，否则其 NavigationRoute 注册在先吞掉全部导航——插件源码级证实）；dev 禁用；构建产物 manifest/sw/offline/workbox 齐全（总控亲测）
- **离线形状**（product-ui/offline.ts，80 测试含新用例）：OfflineQueue（幂等 keep-first/FIFO/markFailed 原位/序列化 localStorage 往返容错/drop-oldest）+ NetworkStateModel 三事件
- **扫码报工页**：useScanSession 自 ScanPage 抽出零复制复用；扫码→草稿→在线 mock 提交/离线自动入队+恢复重放；页面码 scan-report/report:write（三问记录，report 在 ADR-0010 白名单）；M2 对接点隔离（reportingApi 单点替换）
- bundle 纪律：登录块 2.4KB 零污染（SW 注册只内联在 html）、html5-qrcode 懒块不变
- 验收后处置：evicted 反馈文案歧义修复（复证 23 测试+build 绿）；低危记录（precache 双路冗余/maxItems=1 测试锚/双标签页队列覆盖/SVG 图标安装横幅——M5 正式线）
- 未验证边界（如实）：浏览器级真断网走查留 M5 正式线/Owner 实览

**本会话规划内无撞面工作已穷尽**：M0~M5 中可独立预研/预备的全部完成；剩余全部依赖 M2 规格定稿（**R7/R8 待 Owner 决议**——账本挂起项）与 M2 实施收口（另一会话，listing/inspection 已落地、dispatch/reporting/inventory/hours/costing 在途）。

## M4 预研线（✅ 10-25 深夜）：RLS 租户隔离 + SaaS 解析形状 + 双 profile 部署骨架

实施：code-writer-pro（GLM-5.3，agent_dd91d29e）；验收：GLM-5.3 只读模式（agent_33ea6090）—— **ACCEPT 无必改项**（数据隔离安全域标准）。

- **RLS 策略生成器**（business-store/src/rls/）：纯函数生成（USING+WITH CHECK 双设、TO PUBLIC、FORCE、标识符注入防护、幂等 DROP+CREATE）+ RLS_TABLES 守恒（schema 双向，M2 落表自动触发红）
- **三面容器实证**（deploy/scripts/rls-proof.mjs，总控两次独立复跑全 PASS）：superuser 零破坏（跨线安全）/受限用户无变量 fail-closed 全拒/设租户变量仅见本租户、跨租户读写冒充全拒
- **租户解析形状**（business-core/src/tenant/）：resolveTenantFromHost fail-closed + 单租户恒 default + hostBased 工厂；与 application TenantResolver 结构兼容锚点
- **deploy/ 双 profile**：compose.yaml（缺省=单机直接 up；saas profile 叠加子域 proxy）、pg-init 建受限 app_user（无 BYPASSRLS）、README 双形态差异表 + 威胁模型限定句
- **跨线同步实录**（M2 listing 8 表落库 → RLS 守恒触发红 → 总控补登 + 全量重放迁移 20261025210000（幂等设计正为此）→ 87 测试绿 + 36 表三面实证复过）
- 低危记录：_prisma_migrations 对 app_user 的 DML 溢出（M4 打包线 REVOKE）、pg 宿主端口/开发口令（生产收口）、heredoc 口令转义、生成器重复表守卫；镜像未 build（M4 正式线）

## M3 预热线（✅ 10-25 深夜）：报表口径引擎骨架 + 专业包端口草案

泳道对账无占位后派发。实施：code-writer-pro（GLM-5.3，agent_80413f57）；验收：GLM-5.3 只读模式（agent_85e19924）—— **ACCEPT 无必改项**。

- **engine-reporting 真实化**（35 测试）：MetricDefinition 版本化纯数据（timeBasis 三选对齐证据标准+缺列回落）+ MetricPack（口径包=可售卖单元形状）+ MetricSource 端口（行形状对齐 EvidenceColumns）+ evaluateMetric 纯函数（正确性归属引擎、下推只是优化，双路径等价专测）；移除占位期 application 依赖
- **三专业包端口草案**（10 测试，零实现零注册）：payroll（计时/计件通用化、VerifiedLaborFact 形状引用）、maintenance（三态记录、ResourceRef 形状引用）、drawing（版本化修订+DrawingRef 钉修订号）——各含 ADR-0010 三问表
- **总控铁律裁定落地**：新增 pro-pack-tier-edges（专业包→仅 core+engine-*）+ engine-tier-edges 收紧（禁 engine→application，对齐 ADR-0011）；**三规则自检固化** boundary-selftest（core/pro-pack/engine 夹具全拦实证；修掉夹具相对路径层级坑，与 M0 同款）
- 验收后处置：注释措辞修正（两时间列+occurredAt）；低危记录（engine/专业包互依豁免出现事实时按 ADR 处置；倒置时间窗静默空集；distinct-count 死分支）
- 全树 boundary 552 模块/1386 边零违规；四包局部 45 测试绿

## M2 预备线（✅ 10-25 深夜）：施工对账工具基建（决策簿 ~10 人日规划项）

M2 规格未定稿时的无依赖预备。实施：code-writer-pro（GLM-5.3，agent_68989ba7）；验收：GLM-5.3 只读模式（agent_8e6352fd）—— **ACCEPT 无必改项**。

- **packages/testkit 真实化**：ReconcileHarness 三端口（TargetAdapter/ReferenceSource/Comparator）+ 字段级比对（相对/绝对容差、glob 忽略、数组有序/无序按 key/按值、时间戳时刻归一、diff 精确到路径；**无策略=全精确**从严默认）+ 夹具格式 `smes.reconcile-fixture@1`（fail-fast 校验）+ 录制器（默认脱敏、recordedAt/max-age 门禁）
- 67 测试；零运行时依赖；三示例夹具真录制（health/workbench-summary/auth-login）
- `pnpm reconcile` / `reconcile:record` 根脚本；CI 独立 reconcile job（PG service 全链路，无静默跳过）
- **总控亲测**：全新 docker 环境 migrate+seed+server 后 3 场景全 PASS exit 0
- lockfile 最小偏离（testkit 3 条 devDeps 同版本零新包）总控裁定接受
- 低危 8 项记后续（strategy 文档措辞、reconcile filter 空命中假绿守卫、recordedAt ISO 校验、`//` 前缀 path 防护、循环引用 fail-loud、CI max-age 开关等）——归 M2 对账工具迭代批次

## 分面动态（双会话，RunKit 账本协调）

- M2 规格线（wi-m2-spec-prep，zcode-cadence-m2-spec）：m2-drafts **v1.0 已冻结**（code-reviewer 审读修复后裁定，R1~R6 采纳、Owner 保留推翻权；R7/R8 开放不阻塞）
- M2 实施线（同会话承接）**已全部收口**：Wave-1~4 九模块 9/9 验收 ACCEPT + M2 后第一增量（19+1 跨模块接线/边缘适配/活库冒烟）ACCEPT + 低危清理批次 ACCEPT；全仓 verify exit 0（application 396/server 32）。写入面维持 application 九模块目录 + apps/server 接线文件
- M3 专业包规格线（本会话新认领，10-26）：产出 `architecture/contracts/m3-drafts/`（消费他线预热端口草案）——纯规格零代码；M3/M4/M5 实施分工待 Owner 编排（他线四条预研线均已 ACCEPT，其"M2 实施收口"依赖已满足）

**M3 专业包规格 ✅（10-26 晨，v1.0 冻结）**：`architecture/contracts/m3-drafts/`（agent_fc44e51a 产出：README 映射 13 项全核 + 薪酬/维保/图纸/口径四包合同，体例沿 m2-drafts，与预热草案差异逐条有据，端口对称与 M2 被依赖节互证）；code-reviewer 审读（agent_4f276c04）**ACCEPT**——四问全过（13 项映射逐条对上/边界双向对称真实/差异表逐行属实/清洁室与 ADR-0011 实证合规），两处引文低危已修，冻结 v1.0（Owner 保留推翻权）。**R-M3-1~6 开放待 Owner**（人日对账/租户级 flag/接线方向 ADR/dep-cruiser 补 metric-pack 包名/payroll-costing 同源/图纸保密等级）。M3 实施启动与两线分工待 Owner 编排
- 本会话 M1 实施线已收口（wi-m1-remaining completed）；根 verify 在 M2 各波合流点由 M2 线统一跑（当前因 engine-reporting 他线 WIP 而 deferred，见 RunKit）

## M0 立桩（12 人日）—— ✅ 全部完成（2026-10-24）

骨架 / 依赖铁律 CI / 品牌化 ID / CommandEnvelope / ADR-0001~0008 / 快格云 spike（ADR-0009 参照定案）。

## M1 基础层（35 人日）—— ✅ 全部完成（增量 1/2/3/收尾波，均验收 ACCEPT）

### 收尾波（✅ 10-25 深夜，三线；前置 ADR-0011 引擎/边缘包依赖方向 + 铁律三规则修订）
合流终态 `pnpm verify` exit 0：boundary **413 模块/996 边**无违规、14 包 **446 测试**全过；org/approval/mdwb/auth 四套 docker e2e 全部独立复跑通过。RunKit 账本 checkpoint cp-m1-wave12-complete-e。

| 线 | 内容 | 实施 agentId（pro/GLM-5.3） | 验收 |
|---|---|---|---|
| ① 审批纵贯 | approval 模块（案件/决策/事件 API，approval:read/write）+ 事件账本事实源（act 重放对账 409 显式暴露 + PG (aggregate_id,revision) 唯一索引 DB 级乐观锁）+ 待办联动（共享 TodoStore：进待审派待办、决策后本人幂等 done）+ 三表迁移 + 六模块注册 | agent_aa66f4fe | e2e 29 项独立复跑全 PASS；agent_8280ddbe ACCEPT |
| ② 扫码/IM 接线 | tier1 摄像头真实适配器（html5-qrcode 懒加载+会话令牌守卫+白名单错误映射）+ product-ui ScanSessionModel（泛型依赖倒置，零 integration 依赖）+ web 扫码页（三档降级 UX+扫码枪键盘监听+IM 容器横幅） | agent_aec3c07b | 同上 ACCEPT（ADR-0011 新边合法实证） |
| ③ 真实认证 | scrypt 密证（格式自述可升级）+ opaque 令牌（256bit、**库存 sha256 摘要**、8h TTL/7d 绝对刷新上限）+ Bearer 鉴权（401/403 分离、SMES_DEV_AUTH 显式回落）+ users.active 启停（写时全端撤销+双保险）+ web 真实登录流 + 会话保活三规则（临期续期/失败不清会话/可见才计空闲）；零新依赖全 node:crypto | agent_1011f218 | auth e2e 独立复跑全 PASS（同态拒绝/撤销即时/停用全撤/重启存活/dev 边界）；安全验收 agent_ca117e38 ACCEPT |

验收后总控处置：Wave1 低危夹具通用化（"轴承"→"物品"）；Wave2 低危 L2 修复（verifyPassword 越界参数 try/catch 收敛 false，复证 85 测试过+实测收敛）。

**M1 低危遗留（M2/部署阶段处置，不阻塞）**：scrypt N 提至 2^16；token localStorage→httpOnly cookie 权衡；登录速率限制+改密端点（公网部署硬前置）；多审批人终态遗留待办清扫（M2 会签场景）；审批决策权粗粒度（approval:write 即可决策，M2 细化）；内存事件存储无唯一索引（仅零 DB 演示形态）；boot.e2e 补零 DB 待办同源断言；认证线浏览器层走查（服务端全流程已覆盖）。

### 增量 1（✅ 10-24）：NestJS 组合根 + 应用注册表 + TenantContext
code-writer（Flash，agent_c5627dc7）｜验收 agent_a06a1b0c ACCEPT

### 增量 2（✅ 10-24，三线）：business-store 基座 / casbin RBAC / 前端壳（MPA+refine）
A agent_b8254ad5｜B agent_e64b9ce7｜C agent_b01b869a｜合流验收 agent_1360476e ACCEPT
追加：前端审美层（shadcn 手工 copy-in，agent_e403e2d6，Owner 视觉验收）

### 增量 3（✅ 10-25，五线并行，Owner 指令"扩散到多线程"）
全部 code-writer-pro（GLM-5.3）。合流 verify exit 0：boundary 266 模块/570 边、selftest 过、11 包 **245 测试**全过。

| 线 | 内容 | 实施 agentId | 关键证据 |
|---|---|---|---|
| D 组织管理纵贯 | users/roles/policies 三表迁移 + PgPolicyStore（B 线端口落地）+ org 模块（user:read 等四权限码）+ Web 用户/角色管理页（真实 API）+ seed 幂等 + 无 DB 内存回落 | agent_ad04c5d1 | 总控独立容器复跑 e2e **35/35 PASS**（403/200 门禁、期望态授权幂等、**重启后用户与策略存活**、模块开关、缺 core 拒启） |
| E engine-flow | XState v5 审批引擎壳：配置驱动状态机工厂（**ADR-0010 状态集配置分离首个落地**，自定义 5 态配置行为差异实证）+ DomainReview 对齐审批记录/事件 + 29 测试 | agent_4bb84f0c | 依赖仅 xstate@5.33.3（MIT） |
| F integration-scan | 三档扫码端口 + 降级决策纯函数（白名单降级语义）+ 扫码枪键盘串入解析 reducer + 46 测试，零新增运行时依赖 | agent_59a66fe6 | html5-qrcode 留懒加载接线点 |
| G integration-im | IMessageChannel 端口 + 企微/飞书双适配器（ImTransport 注入式、可逆映射构造期拦截）+ JS-SDK 签名端口 + 回调验签 + 32 测试，零新增运行时依赖 | agent_63824faf | 厂商词汇封死在边缘包内 |
| H CI boot smoke | boot.e2e（真实起 Nest 随机端口读回 health/modules/ping + MODULES_ENABLED=core 场景）+ vitest tsc 转译修复 | agent_3517ec48 | 失败自证（改错断言即红）；耗时 71ms |

合流验收：code-reviewer（GLM-5.3，agent_13bd6699）—— **ACCEPT，无必改项**。ADR-0010 词汇纪律全量扫描通过（行业词仅存于注释层引用）。验收后总控处置：清除 scan/im 包未使用的 @smes/application 死依赖（reviewer 低危项 ×2），复证 verify exit 0。

### 增量 4（✅ 10-25，三线：基础数据+工作台 / engine-flow 深化 / 打印边缘包）
合流 verify exit 0：boundary **357 模块/794 边**无违规、selftest 过、**13 包 351 测试**全过。全部 code-writer-pro（GLM-5.3）。

| 线 | 内容 | 实施 agentId | 关键证据 |
|---|---|---|---|
| I 基础数据+工作台纵贯 | Item/Resource 主数据 + TodoItem 待办（端口+内存/PG 双实现+迁移）；REST 带 RBAC，Todo 存储层 (tenant,assignee) 双键收口；Web 工作台首页+物品/资源页；注册表五模块 core,org,masterdata,workbench,demo | agent_0d8cc790 | 总控独立容器复跑 e2e 全 PASS（门禁/冲突 409/仅本人完成/幂等/重启存活/无 DB 回落/模块开关/缺 core 拒启）；org:e2e 回归过 |
| J engine-flow 深化 | ApprovalRecord/EventStore 端口（EvidenceColumns 映射）+ TimerPort 假时钟超时迁移（autoAfterMs，到点同一 evaluate 路径，无孤儿定时器）+ quorum/role/version 守卫库；既有 29 测试零改动 | agent_46a7c816 | 59 测试全绿，零新依赖 |
| K integration-print | PrintJob/PrintPort/PrinterRegistry 端口 + TSPL 生成器（定界注入构造期拒绝、EAN/UPC 校验位锚定、COPY=追加重印）+ pdfmake 真实引入（懒加载、structuredClone 防改写、安全默认拒绝、真实渲染测试） | agent_ee8609de | 47 测试全绿；lockfile +pdfmake 树 |

合流验收：GLM-5.3 只读验收模式（载体 code-writer-pro，agent_3601a36c）—— **ACCEPT，无必改项**。总控处置低危 ×3（两 README 登记补齐、演示文案通用化），web 复证绿。

## 已知事项

- **双线分面协调（2026-10-25，Owner 指令"各干不重合的"+启用 RunKit）**：原交接线程继续 M1 剩余实施，写入面 = packages/ apps/ .github/ scripts/ 及根构建文件，全仓 install/verify 由其收口时统一跑；新会话开 M2 规格拆解线，写入面仅 architecture/contracts/m2-drafts/，不碰代码、不跑 install/verify。两线写入面不相交，不得越界改对方文件。协调账本 = RunKit `owlrunkit@0.23.0`，控制目录 `/Users/yeemio/AI/gitrep/cadence-runkit`（项目 `cadence-dual-lane-20261025`；owlrunkit 为 GPL **禁入本仓**，故账本置仓外，本仓内不得出现 .owlcoda/ 或 owlrunkit 依赖）；任一线开新 WorkItem 前先 `cd /Users/yeemio/AI/gitrep/cadence-runkit && npx --no-install owlrunkit project status --workspace .` 对账防重复；控制产物不纳入 delivery changed files
- pnpm ignored-builds：**独立 `pnpm install`（含 --frozen-lockfile）因 ERR_PNPM_IGNORED_BUILDS 退出码 1**（verify 链不受影响、CI 尚未运行因零 push）；pnpm-workspace.yaml 的 ignoredBuiltDependencies 清单不足以消码——**首次 push 启用 CI 前须跑一次交互式 `pnpm approve-builds` 生成裁决**（2026-10-25 已试三种清单写法均不消，勿再试清单法）
- **本机 shell PATH 可能缺 nvm node**（2026-10-25 遭遇）：命令前 `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"` 恢复
- git 已 init、**零 commit**（首次提交待 Owner 指令）
- 同族验收记账：全链路 GLM；跨家族独立验收须 Owner 外发
- Web 组织管理页未做浏览器自动化走查（自动化通道对该页劣化）；Owner 可在 preview 实览

## M1 剩余（后续增量）

engine-flow 注册进组合根（审批 API + 与 casbin/业务对象联动，J 线端口已备好）、scan/im 真实适配器接线（UI + 懒加载；K 线 pdfmake/pdf 渲染已可用）、真实认证（OAuth/密码）替换 mock 身份、会话保活规则（ADR-0009 参照清单）、users.active 启停端点、多实例策略失效广播（推迟 M4 一并）。

**M2 九模块合同已冻结 v1.0**（2026-10-25，M2 规格拆解线，`architecture/contracts/m2-drafts/`：README 映射矩阵 137 项全覆盖 + 九模块合同 + 裁决记录）。冻结依据：code-reviewer（GLM-5.3，agent_bc39fc52）只读审读四问通过、7 项必改全部修复（含 ADR-0011 依赖方向对齐）；R1~R6 边界裁定采纳（采购归 listing、齐套归 workorder 等，**Owner 保留推翻权→v1.1**）；R7（清单 9 项刷新）/R8（扫码报工并入 M2）开放不阻塞。生成顺序见 m2-drafts/README。

**M2 Wave-1 派发（10-25 深夜，M1 收口 gate 开启后）**：M2 规格拆解线总控按 v1.0 派发前两模块实施——W1 workorder 全量、W2 baseline P1 件（工序库/物料校验/外协计价/设备档案），均 code-writer-pro（并发 2）。占用面：`packages/application/src/workorder|baseline/**` + testkit 夹具；**app-registry 注册行由本线总控合流时统一追加**，全仓 verify 亦由本线合流收口统一跑。代码线（M1 已收口）如继续开工请先到 RunKit 账本对账认领剩余模块，勿重复此两模块。

**M2 Wave-1 实施 ✅（10-25 深夜，合流接线完成，验收进行中）**：
- W1 workorder（agent_a8352b89，13 文件 + 迁移 + testkit 夹具，33 测试绿；九态 19 规则=主干 8+跳态 5+回退 6，配件机 5 态）+ W1 返工 PG 适配（agent_906d8d0e：schema 六 model、pg-workorder-stores 七端口、conformance 24 表、tests 归位，business-store 64 测试绿）
- W2 baseline P1（agent_57c36886，12 文件 + PG 适配 + 迁移 + conformance，37+122/60 测试绿；物料校验确定性判定：编码精确+归一化 Dice 阈值 0.9/0.7 可注入，名称路径永不判 matched；计价 half-up 到分）
- 总控接线（本会话）：app-registry 双模块注册（按需启停不进默认清单）+ 共享实例裁决（ItemStore 同源 masterdata/baseline、TodoStore 三方同源）+ main.ts connect 接线 + 两域错误过滤器 + boot 冒烟新场景（core,workorder,baseline 装配+401 门禁）；修两处合流问题（baseline 控制器 import type→值导入使 Nest DI 可解析、app-registry 测试样例名避让）
- 证据：application 155 测试 / business-store 64 / server 14（含新冒烟）/ testkit tsc 0 全绿；**depcruise 终态 529 模块/1358 边无违规**；零新增运行时依赖
- **全仓 pnpm verify 推迟**（RunKit deferred verification 已登记）：engine-reporting 为另一会话 WIP 中间态 typecheck 暂红，非本线写入面；该线静止后补跑
- 验收：code-reviewer 只读验收 **ACCEPT，无必改项**（agent_ae8d8ef8，四问全过、申报数字独立复跑证实）。低危处置：① transition.v1 拒绝直达 closed（守卫+测试，close 权限码语义恢复，application 156 测试绿）✅；② 两模块幂等记账口径差异（各自自洽已文档化）→ 后续统一，记待办；③ material-validation:read 增补权限码 → 合同升 v1.1 时登记；④ 记账口径修正（workorder 12 文件；depcruise 模块数以复跑时点为准——并行线 WIP 使数字浮动，终态 552 模块/1386 边无违规）。
- **M2 Wave-1 ✅ 完成态**：workorder + baseline(P1) 两模块实施、接线、验收闭环；全仓 pnpm verify 仍待另一会话 engine-reporting 静止后补跑（RunKit deferred 在案）

**M2 Wave-2 实施 ✅（10-25 深夜，合流接线完成，验收进行中）**：
- W3 listing 全量（agent_44a0b267）：四类清单/缺口核查/三类采购申请/订单五态（配置化）/退货/逾期事实；**ExcelPort 端口化**（json-tables 内建实现，表头别名+错误行行为已锚定测试；ExcelJS 适配器待统一装依赖接线）；45+17 测试绿
- W4 inspection 全量（agent_aab3b574）：四类质检机/不合格闭环三态/放行事实事件/闭环超时 72h 点名（配置化）/四类来源触发幂等双保险；30 测试绿
- 总控接线（本会话）：app-registry 两模块注册（M2 模块群五模块按需）+ todoConsumers 五方共享 + main.ts connect 映射 + 两域错误过滤器 + boot 冒烟五模块场景
- 证据：application 全包 **231** 测试 / business-store **87** / server **14** 全绿；depcruise exit 0；零新增运行时依赖（ExcelJS 特意端口化延后）
- 实施者裁定点（对账阶段校正，验收复核中）：purchase.overdue.scan.v1 新命令、申请随订单两步推进、inspection 混合判定进 failed/复检不重建明细/closed 无放行量
- 验收：code-reviewer 只读验收（agent_404e6c24）初裁 **REWORK**——抓出全部测试绿之下的落账顺序缺陷（submitOrder 机器事件先于投影行落账，PG 账本按投影行解析租户 fail-fast → 设 DATABASE_URL 时订单首命令必 500；同型隐患 Wave-1 配件提交亦有）。返工（code-writer-pro，agent_7e17f36a）：listing submitOrder 与 workorder requestParts 改"先落 draft@v1 投影再驱动迁移"（PG fail-fast 合同全量保持），inspection 超时点名信封化 `inspection.overdue.scan.v1`；加两条"PG 投影租户解析语义"锚点（负向验证有效）。**终裁 ACCEPT**（四问闭合，application **234**/business-store **87**/server **14** 全绿，depcruise **644** 模块无违规）。
- **M2 Wave-2 ✅ 完成态**：listing + inspection 两模块实施、接线、验收闭环（**4/9 模块完成**）。残余注记（不阻塞）：守卫拒绝路径残留 draft 投影行=等价草稿单；活库首命令冒烟待 Wave-3/首个活库环境补口；ExcelJS 适配器待统一装依赖接线（端口已锚定）；跨模块端口（workOrderFeed/inventory/receipt/materialValidation）Wave-3 接线

**M2 Wave-3 实施 ✅（10-25 凌晨，合流接线完成，验收进行中）**：
- W5 inventory 全量（agent_3fd824b2）：仓库库位主数据/出入库流水/**可用量=总量−预占恒等式**（service 层计算+PG 原子守卫双防线）/盘点四态/发货三态/**receiptKey 幂等去重**（(tenant,source_key) 唯一约束+回查）/放行咬合（release_facts 幂等登记，inspection 放行校验）/负库存默认硬拒绝；42 测试
- W6 dispatch 全量（agent_9967b0ad）：六类派工机（draft→assigned→executing→done+撤销）/**齐套 fail-closed 拦截**（装配/电气无核查记录或未齐套一律拒建）/外协实时取价（10000×1.15=11500 分锚点）+补录（OutsourcingPriced→costing 信号）/外协 done→inspection 回厂触发（通知式）/打印端口/工艺属性随单快照；28 测试
- 总控接线（本会话）：app-registry 七模块注册 + todoConsumers 六方 + main.ts connect + 两域过滤器 + boot 冒烟七模块场景（修 3 个类型名笔误）；**删除冗余中间 RLS 重放迁移 20261025220010**（dispatch 线产物，被 20261025230000 五十一表全量覆盖，business-store 94 测试复证绿）
- **deferred 全仓 verify 已补跑关闭：`pnpm verify` exit 0**（application **304** / business-store **94** / product-ui 80 / testkit 67 / integration-scan 60 / print 47 / web 23 / server **14** 全绿，含他线 engine-reporting 终态；RunKit deferred verification 已按 verified 关闭）
- 实施者裁定点（验收复核中）：盘点双口径（调账 movement=实盘−当前账面、审计差异=实盘−开单快照）、库位级盘点不做、shipping 无取消命令、供应商直推待办端口缺口（合同未定义，未私设）
- 验收：code-reviewer 只读验收（agent_c60dcc81）**ACCEPT，无必改项**——四问全过（含盘点双口径=唯一账务正确解、齐套 fail-closed 缺省=唯一安全缺省、总控删冗余 RLS 重放处置独立核对认可、全仓 verify exit 0 复现）。低危处置：#1 悬空引用已补（本行下方待办锚点）、#2 两处陈旧注释已修、#3 幂等口径差异并入既有统一待办、#4 totalBefore 措辞与 #5 信息项记档；供应商直推待办登记为合同 v1.1 议题。
- **M2 Wave-3 ✅ 完成态**：inventory + dispatch 两模块实施、接线、验收闭环（**6/9 模块完成**）。
- **跨模块端口接线待办** → 已由 Wave-4 交付，升级为下方"验收登记项"中的跨模块接线增量。

**M2 Wave-4（收口波，✅ 10-26 凌晨，验收 ACCEPT）——M2 九模块全部闭环（9/9）**：
- W7 reporting 全量（agent_8181ef89，28 测试）：三态机+撤销旁支、修正版 supersedes 链（list 只返回链尾）、批量整批校验、**ReportVerified 事件形状冻结**（工作令维度+整数分钟量纲）；hours.ingest.v1 为合同外新增命令（feed 触发面，同 overdue.scan 先例，登记待对账复核）
- W8 hours+costing 双账本（agent_ac85843e，27 测试）：冲销净额恒等式（reverse 取账本末轮值）、月度重算幂等（两次重算零漂移实证）、口径版本 supersedes+**delta 条目永不改原行**、快照幂等、金额化在口径层（R6）、导出端口化（ExcelJS 留位）
- W9 baseline P2/P3（agent_015e84d0，新增 29 测试）：工艺路线版本链（图号业务键）、额定工时（秒量纲三处一致标注）、故障三态机（含 REJECT 回退配置）+待办/IM；**P1 37 测试零改动全绿**（零破坏达成）
- 总控合流：九模块注册（todoConsumers 七方）+ 五 connect + 三新过滤器 + boot 九模块装配冒烟；**补 hours/costing 7 表 RLS 漏登**（实施线漏登，66 表终版重放 20261026050000，rls-conformance 逐字节守恒——验收者独立核对认可）
- 验收：code-reviewer 只读验收（agent_30830539）**ACCEPT 无必改项**；12 条裁定点全判合理；**全仓 pnpm verify exit 0 复现**（application **388** / business-store **109** / server 14；depcruise 819 模块零违规）
- **验收登记项（M2 后第一增量与接线前必修）**：①跨模块端口组合根接线增量（validDispatch/reportFeed/三成本源/kitCheck/priceSource/inspectionIntake/workOrderFeed/materialValidation/预占放行收货适配——当前全缺省 fail-closed，"verified 工时实时进工时账"组合态尚不可演示，模块级有测试背书）+活库首命令冒烟+ExcelJS 装依赖同批；②**hours/reporting 工种类词汇表失配（接线前必修）**：hours-config after-sales/misc ≠ reporting aftermarket/oddjob，`?? 'misc'` 兜底会错归零工+分钟→小时换算适配缺；③低危：幂等口径统一（hours/costing/baseline claim 先行 vs reporting parse 先行）、P1 恒真断言修复（baseline-module.test.ts:61-65 改直读 dynamic.controllers + org.test.ts:330 同型）、迁移头注 59→66 已修
- **M2 ✅ 完成态**：九模块（workorder/baseline 全量/listing/inspection/inventory/dispatch/reporting/hours/costing）全部实施、接线、验收闭环；接线增量/活库冒烟/ExcelJS 为 M2 后续增量；M3 专业包由另一会话推进中（payroll/maintenance 包已出现）

**M2 后第一增量（✅ 10-26 晨，三线交付，验收进行中）**：
- 窄修（agent_9688cac9）：hours/reporting 工种类词汇对齐（aftermarket/oddjob）+ 删静默兜底（未知类别整批 rejected 三道门禁）+ minutesToHours 导出锚定；testkit/index 同步
- 跨模块接线（agent_7955bd45）：**19+1 条端口全接**——store 级适配优先 + 迟到绑定机制（bindCrossModuleWiring，NestFactory.create 后回填）+ verify/revoke 后拦截器联动 hours ingest + 手动重放端点；组合态端到端链已演示（报工 verify→hours 1.5h→costing 9000 分非零+幂等重算；齐套拦截组合态生效）；materialSource 金额口径初版（issue-out×PO 最新已定价单价，未定价不归集，对账阶段校正）
- 收尾（agent_0b853777）：ExcelJS 真适配（语义层零复刻，委托 application 纯函数）+ print 受理 sink（integration-print）+ IM 装配降级 sink（integration-im，无配置不炸 boot）+ **活库冒烟 e2e-live-db 26 PASS**（随机端口容器/22 迁移/67 表/九模块起服/**purchase.order.submit.v1 首命令 committed——Wave-2 缺陷活库实证闭合**/ExcelJS 活链/工时链 1.5h/干净 teardown）；`pnpm smoke:live-db` 可复跑
- 总控：装依赖 exceljs@4.4.0（MIT，D13 白名单）+ @smes/integration-print/im（workspace）；**全仓 verify exit 0**（application 391 / server 31 / depcruise 834 模块零违规）
- 验收：code-reviewer 只读验收（agent_a3725c19）**ACCEPT 无必改项**——申报证据全部独立复现（含验收者本机自跑活库冒烟 25 PASS/0 FAIL、全仓 verify exit 0、depcruise 834）；修正版链双入账疑点被主动复核解除（audit-edit 仅链尾可编辑→一链至多一 verified 事件）。低危登记：①申报计数口径（冒烟 25 非 26、迁移 21 个——后续以工具原文计数）；②"𫟼"生僻字笔误（回执）待顺手清理；③事件形状防御静默不投递 vs 整批拒绝的口径不一致（不可达路径，对账阶段统一）；④双触发幂等组合态断言缺口；⑤feed 全量扫描性能（消费位持久化属对账阶段）
**M3 首波 payroll（✅ 10-26 晨，实施+合流完成，验收进行中）**：
- 实施线（agent_16e46d8a）：payroll 包全量（22 测试：四档匹配优先级/幂等重算三面零漂移/PayRun 历史复算/half-up 量纲/sourceRefs 下钻/激活开关=仅显式 MODULES_ENABLED）；PG 适配 business-store/src/payroll **结构同形镜像不 import**（store-tier-edges 不许 business-store→payroll——PayrollConflictError 同名镜像+isPayrollConflict 防线）+70 表 RLS 全量重放；既有 4 测试按合同 §8 改名做最小形状适配（意图全保留，总控裁定接受）
- 总控合流（本会话）：①**接线前必修：PayrollLaborRequest 补 tenantId**（纯包端口无租户=多租户漏洞）②组合根 HTTP 面（payroll-http.module：3 命令+9 查询端点；**12 个 @RequirePermission——初版漏挂被自家 boot 401 探针当场抓红后补齐**）③wiring #21（store 级事实源：hours 条目按月聚合净工时+trade→工种词逆映射；ExcelJS 同实例导出）④注册/过滤器/connect/十模块装配冒烟
- 证据：**全仓 pnpm verify exit 0**（payroll 22 / business-store 113 / server 32 / application 396；depcruise 851 模块零违规）
- 验收：code-reviewer 只读验收（agent_3c91999c）**ACCEPT 无必改项**——四问全过（差异表 7 行亲读核实/G1 claim 时机逐点/RLS 70 表逐字节守恒/tenantId 窄修完备/12 权限装饰器亲数/全仓 verify 独立复现）。**两条中危已由总控即时补齐**：payroll 全链 e2e 落 cross-module-wiring.e2e（差分断言不依赖共享状态；逆映射 machining→part 错词即红；direction 冲销→重算回落基线证"净额零不投递"；xlsx-base64 导出链；非法月份 400 过滤器映射）——server 33/33、**全仓 verify exit 0**。低危登记：①适配器未知 trade 静默跳过 vs 整批拒绝口径（不可达分支，词表演进时对齐）②testkit FixturePayrollLaborRequest 无 tenantId（类型面易漂移）③PG/内存两形态 hours 未装配时事实源不对称（知悉）④文件计数口径 ⑤claim 后非冲突异常 500（与 hours/costing 同取舍）
- **M3 首波 payroll ✅ 完成态**：专业包 + 组合根接线 + 验收 + 中危补测全闭环

- **M2 后第一增量 ✅ 完成态**：词汇失配修复 + 19+1 条跨模块接线（组合态全链可演示）+ ExcelJS/print/IM 边缘适配 + 活库冒烟脚本（Wave-2 缺陷活库闭合）。剩余登记项见低危待办与 R7/R8

**低危待办包批量清理（✅ 10-26 晨，验收 ACCEPT）**：
- 实施（agent_df576463）：①**幂等记账口径统一 parse-first**（hours/costing 12 handler baseline/inventory 收发四处；被拒不占 operationId；inventory 例外序 sourceKey 去重最先——自纠发现：先行深校验会误拒合法幂等重发；新语义"committed 后同 id 且状态已变→状态拒"文档化+锚定；5 条三段式新测试）②恒真断言修复（直读 dynamic.controllers+能红验证，验收者独立反例证实可证伪）③𫟼→回执 5 处 ④双触发幂等组合态断言（自动 ingest 后手动重放 ingested=0）
- 总控：**合同 v1.1 增补登记**（m2-drafts/README 新节：通用纪律 G1 幂等口径/G2 落账顺序、命令面四增补、material-validation:read、词汇量纲冻结、开放议题、实施裁定口径清单；v1.0 正文版面不动）
- 验收：code-reviewer（agent_e1d781ed）**ACCEPT 无必改项**——claim 时机逐行亲读、retrySafe 语义保持确认、v1.1 三条抽查对上实现、数字全部复现
- 证据：application **396** / server **32** / business-store 109 / depcruise 834 零违规 / **全仓 verify exit 0**
- 本线登记的低危待办至此清零（保留项：feed 消费位持久化与事件形状防御统一=对账阶段；reporting 修正链 hours 联动自动化=v1.2 候选）

## 规格源提醒（清洁室）

M2 起九模块生成输入 = 功能拆解 V2 / 流程拆解 / 决策簿 / 交接文档（§10）；
`AI/gitrep/sieracMes-AI/docs/开发文档/` 73 份雇主文档禁用。

---

## V 波（✅ 10-26 深夜③，本会话质量纵深域收官——双总控域分流：另一会话主攻 U 波实施，本会话质量纵深）

- **V1 浏览器 e2e 深度扩展**（agent_057630c6）：12→**61 测**（桌面 42 页走查+**UI 版真实操作链 7 测**——建物品→建令→流转→骨架→缺口核查→入库→库存读数→齐套看板→总览全程真实点击+移动 7 页）；51 截图；retries=2 flaky 策略；3 fixme 如实（T1 三模块未进走查栈，断言体已备）。亲测复证闭环（含 U 波在途干扰的静止窗口重试模式实证）
- **V2 矩阵终排+性能基线**（agent_c67ca640）：**109/109 逐项双锚点核证**（41 处抽查全活+机检行数=109 整）；U1~U5 增量登记节；**API 性能基线立锚**（五端点 p95=1.8~3.4ms，无阈值判定如实——决策簿 p95 目标未定）；perf-baseline.mjs 可复跑
- **终验**：verify exit 0——**1324 模块/4351 边零违规、1442 测试全绿**（U 波静止窗口）

本会话线（M0→M1→预备/预热/预研→S→T→V）至此全量收官；U 波实施归另一会话持续推进。
