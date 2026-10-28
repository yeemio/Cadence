# Sol 剩余修复交付（待父级接收）

候选已停写，范围内仓储一致性、真实设备链、具名拒绝/RLS/归拢边界及适用项目检查均已取得证据。**本文件是 worker evidence，最终产品接收由 /root；新设备UI与移动遮挡的可见IAB补验仍待父级。** 不把测试通过或本地隔离运行等同生产发布/真实客户验收。

## 身份、边界与候选

- writer：原生子代理 `/root/cadence_remaining`，`gpt-6.1-sol` / high（原同一writer续行；未派新代理/未建新控制线）。父主控 `/root`，PM任务 `01a17d85-16ec-7c42-a86d-7d42711031a3`。
- 基础HEAD：`0fbaff32d4625869417f37e8d0f8d18fd38649f0`；没有 commit/push/merge/发布。
- 最终产品清单 **105 文件**，SHA256聚合：`39fc159969198fc15104bfd224d8b2604d84cbc524e881c1241e2cfe8bc435e8`。格式与每文件哈希见 [CANDIDATE-MANIFEST.json](CANDIDATE-MANIFEST.json)，路径见 [CHANGED-PATHS.txt](CHANGED-PATHS.txt)。这是实际脏工作区，不虚构提交区间。
- 对 entry 31 个产品文件：21个原字节保留，10个继续有界修改；另74个路径新增到entry差量。精确列表见 [ENTRY-DELTA.json](ENTRY-DELTA.json)。entry的4份旧交付/日志均保持原SHA；PM三文档由父级改动，既定排除，本writer未写。原报告及旧日志不改。
- Owner后续明确授权设备维数据库字段/迁移、工作令真实设备身份与界面/API、listing关联、dispatch传递、IssueDemandSourcePort真实接线；未实现D-LP-01全部统计/进度及D-IS-01桌面发料页。

## 实际修复

仓储根因是质检无item锚时把drawingNo带作入库item，库存收货未验证真实主数据。现在 pending且itemId为空的单可在judge中显式选择本租户有效物料，与判定同一次保存；已有锚不可覆盖，已放行不可重绑。单笔/批量/复检实际发放行路径遵守同一缺锚拒因，合法0合格数量不强迫补入库物料。库存独立校验物料存在/启用、放行非空锚一致，并按inspectionId全量累计已入库量，不能换item绕额度。没有改共享历史错误库存。

质检判定、库存入库、采购收货各用原操作权限的最小选项投影，返回动作所需物料/仓库/可入库放行事实；无动作权限仍拒绝。不为岗位加item:read/inspection:read/warehouse:read。选择器显示编码/名称，质检放行入库自动固定物料，成功清放行选择。

真实设备链新增工作令设备持久化；同租户同工作令复合关联，生产清单显式选择设备，自制part/standard/electrical与外购equipment分开，origin aftermarket不进生产任务。派工携带真实设备集合，指派成功同步相应任务，显式rollup才生成外购设备归拢，无工作令汇总fallback。gap预占按设备/物料分配一次，齐套计入自身有效预占；standard/electrical只核销本设备预占。

已修运行根接线遗漏：workorder模块注入与listing/dispatch同一个PG equipmentStore，不再出现HTTP201内存成功但数据库无行。A/B真实行、归属、服务重启后API读取与PG一致见 `evidence/final-runtime/equipment-pg.json` / equipment.http。

恢复键原递归拼接movement.sourceKey会超过stock.issue的200字符上限。现保留parse/build得到的原工作令/设备/物料锚，后缀使用来源稳定SHA256，不提高上限、不截断ID、不复制旧g/wh/rb后缀。新C两轮恢复键均182字符；旧A超长键故障夹具完整保留。

UI修复含带参数login进入独立登录MPA、移动报工安全区/扫码高度/成功单号与清草稿、采购明细业务表格、AI已选chip对比/粘顶遮挡/时间格式/筛选与工作令深链/人话口径，合法数值0保留。动作/写表单按权限投影；审批成功反馈与徽章修正。原reportingApi的`Promise<void>`签名仍服务离线重放/既有调用者，移动在线报工通过显式返回结果重载读取reportId用于回执，未改变离线队列返回合同。

完整逐项P1/P2/P3处置、已修/设计内/未关边界见 [DISPOSITIONS.md](DISPOSITIONS.md)，不是只修P1后抹去其余报告。

## 业务与对抗证据

下列原始业务来自首交候选，未受本次三根因影响的证据复用；同item共享实收守恒的新覆盖见REWORK1段。

| 业务边界 | 实际结果与原始证据 |
|---|---|
| OP-005→报工5→质检→入库5 | `resume1-*` 保留原续接单；设备主链另有同令末道5件完整来源 `equipment-live/06~12`。图号未知物料拒绝、pending未改后显式绑定有效物料。库存同料7→12（本链入库+5），未靠其它仓补库。 |
| 齐套→A/B装配/电气指派→任务 | 主链WO `wo-01a181e9-097e-73e8-b058-1c118d9178d8`；A/B各有part、standard、electrical需求2/3，设备gap预占收敛，kit complete，OP007装配/OP008电气指派成功，4任务6行。见equipment-live/18~23。原旧无设备WO不伪造补设备。 |
| part类别 | A2/B3确认保存真实预占来源拆分快照，库存/预占不动；A撤销/重确认也不做物理扣账。见equipment-live/24~27。自制余量不落库。 |
| standard类别 | A2/B3从loc-seed-main真实扣库并消耗本设备预占，5/5→3/3→0/0；A撤销恢复2/2，重复撤销拒绝零变化。旧A重确认暴露旧递归长键失败，见29~32，保留未修数据。 |
| electrical类别 | A2/B3真实库位扣减5→3→0，预占同向核销。见equipment-live/33。 |
| C恢复键修复 | 独立真实C需求/采购2/预占2/指派自动任务，confirm→revoke→confirm→revoke→重复撤销拒绝→confirm全过；每轮对应库存/预占2↔4，恢复键182/182。旧A超长行前后完全相同，最终全局螺栓2/reserved2仅为旧A失败夹具。见key-recovery-live/RESULT.json及各HTTP。 |
| 外购设备rollup | 真实外购P、equipment行1、合法PO实收1，既有ops sync显式rollup生成单一equipment行；确认记录1，物理库存不变；重同步总5任务不重复。见rollup-live/RESULT.json。此处证明ops同步归拢，未冒称UI新建rollup派工全流程已验。 |
| 不串料/不重复/不越界 | 同item的A/B分派互不串行；用A行确认B任务被拒且库存不变；重复sync任务ID不变；aftermarket99排除。缺设备、错工作令派工/清单/issue同步均拒绝。见equipment-live/23/28，equipment-boundaries/RESULT.json与wrong-workorder-sync.http；跨租户设备服务拒绝测试在application734绿中。 |
| 租户RLS/持久化 | 非登录精确probe角色foreign租户读0，跨租户INSERT触发RLS拒绝、零行；重启后A/B/P的API与PG身份一致。probe角色已精确撤权删除，见final-runtime/probe-role-cleanup.log。 |
| 配件同料发货 | 原链同item002同MAIN仓5→4，原预占2不变；shipped状态、issue-out数量1及parts-request关联完整。见independent-business-result.json与step-*.http。不是拿预占2直接扣走。 |
| 采购实收 | 原PO实收3，item002同仓4→7，reserved2不变；state received与purchase-in3对应。设备链另有standard/electrical真实PO各5和rollup采购1。 |
| AI denied合同 | 专用sol-denied-fixture：有入口缺inspection:read→HTTP200 kind=denied；补业务权限→200 answer；撤业务→200 denied；撤入口→403；最终只恢复入口用于UI。完整UTF8 HTTP、角色前后、plan-role不变读回见denied-*.http / denied-result.json。不含登录令牌。原denied-result.uiPending被后续父级UI PASS覆盖，原文件不篡改。 |

注意：`independent-business-result.json` 当时的assemblyIssue=BLOCKED和旧runner失败是历史真实状态，本轮新设备证据是后续闭合增量；不覆盖原文件假装从未失败。库存未实现批号隔离，来源由report/inspection/receipt/workOrder关联和数量读回证明，不虚构逐批物理锁定。part/equipment没有实时库存扣账；**物理扣账仅standard/electrical及配件直发对应类别**。

## 迁移与保留

迁移仅运行于隔离 `cadence-sol-rem-pg-20261028` 的55435/cadence；共享3000/8080/55432未重启、recreate、down或变更。新增迁移：

- `20261028093000_workorder_equipment_issue_chain`：设备表+工作令复合FK、清单可空equipment_ref与origin、派工设备JSON/rollup、设备RLS。
- `20261028093100_rls_equipment_replay`：108表完整RLS生成快照（符合仓内最新_rls_迁移守恒要求）。

应用checksum与当前迁移文件逐一相符见 `evidence/final-runtime/migrations.json`。升级前备份 `evidence/isolated-before-equipment-upgrade.sql`（仅隔离合成数据，权限600，不在聊天输出内容）。`equipment-upgrade-before.json` 与after精确相等：10表旧行数/旧字段值全保留，共21行；新增字段从比较中剔除，旧6条清单行仍空设备，不补伪身份。完整日志equipment-migrate.log EXIT0。未演练降级恢复，备份为恢复源，不把备份存在当恢复实测。

## 检查与失败保留

[CHECKS.md](CHECKS.md)及各result.json绑定完整命令/退出码。build、typecheck、boundary/selftest及全部适用包测试已分段补齐；**没有一次全pnpm verify EXIT0**，原全命令/后续server失败保留，绝不改写失败退出码。

历史失败含：PG readiness（环境）；替身字段名/脚本相对路径/runner猜响应与必填operationCode/快照猜表名/测试helper名称（harness）；PG equipmentStore根接线遗漏（产品，已真实持久化及重启证明）；递归恢复键>200（产品，C复证闭合，旧A不改）；最终测试缺查询字段、静态表数107、5条旧夹具缺设备/主数据或前置时序（验证维护，主控重评后窄修，原断言不削弱）。原件位于material-focused.log、migrate.log、business-run.log、business-resume1-run.log、equipment-focused.log、equipment-new-tests.log、equipment-live/02~03及32、pnpm-verify*.log、final-tests.log、final-resume-server.log。没有重启旧长runner。

最终app734/web246+14既有skip、store原219有效项+受影响两文件78复证、server243有效项+具名5复证、testkit77；不同段不重复相加冒称新测试数。容器auth:e2e/org:e2e、生产迁移/发布、真实客户试点未验。

## 首交运行与父级接收（历史绑定，当前见REWORK1）

[FINAL-UI-RUNTIME-BINDING.json](evidence/FINAL-UI-RUNTIME-BINDING.json)：web8181/API3101，server PID 86656，30模块health与设备PG/API读回通过；精确产物集合SHA `fe5aa24f8e01bdb76ecd5f81a308132dcb5eb9aae18b48a50195ef11256387af`。隔离运行面为父级接收保留，未清理自己的PG/nginx/失败夹具。

父级已完成8项IAB原件 `evidence/parent-ui/RESULT.json` 继续复用：带参数登录、clarify选择、工作令深链、质量0/状态时间过滤、denied卡、采购业务表格/仓库选项及实收3可见。设备扩展未冒用旧UI证据。最终新设备页、选择器、移动提交遮挡的具体用户名/入口/操作和未验边界见 [UI-ACCEPTANCE.md](UI-ACCEPTANCE.md)。本writer因子任务IAB不可见且平台用户接管已停止fallback，未再碰Chrome。

首交阶段父级剩余动作（后续处置见返工段）：按准确候选独立接收与上述可见UI补验，再更新父维护的PM三文档/总体裁决。SP-5/裁-11、真实身份clearance P2-3/O5、波3多语言、D-18上游、真实客户与其它保留选择未代Owner裁定。writer在本交付后停止产品与运行写入；发现返工由父级具名裁定。

## 接收返工 REWORK1（仅三项，已冻结待再接收）

上一候选 `1c1e9a42173584e7e780d8be93c3023bd137be13227cfef7f3a8cc5b47f4f597` 的原DELIVERY/CHECKS/MANIFEST/RECEIPT及102文件源码、binary patch已保留在 `evidence/rework1-before/`，SNAPSHOT.json绑定SHA。当前105路径相对上一候选6路径修改+3路径新纳入（其中listing.test.ts是原跟踪文件本次变脏，另2个为新增测试），无删除；见 REWORK1-DELTA.json。聚合明确为**按path排序后编码每条SHA/path记录**，不是把完整记录按SHA开头排序。

1. **实收重复投影**：确认根因是每个同item清单行都复制PO累计实收。按本轮产品接收责任人裁定，production equipment同令同item共用实收池，不主张PO与清单行专属对应。当前有效已发按item+sourceLineId优先占用，剩余按稳定sourceLineId分配至各行需求；新增行/重复同步不挤走有效占用。确认前按同item全部有效记录和本次多行总量封顶，撤销只移除有效占用，旧快照不改；真实实收减少到已发以下时后续可发0。aftermarket与其它类别不参与分配，其它item独立。root投影和IssueService读写同一issueRecordStore，无新schema/伪采购关联字段。源数据没有真实利库字段时仍是0，未编造供给。
2. **外购类型约束**：equipment显式关联仅准同租户/同令purchased；self-made、跨令、跨租户拒绝，零清单/行写入。原可选null保留；自制三类仍必须选择self-made。新增测试还证明update到错误类型时原purchased锚不变。
3. **可选空值/切类**：addListingLine把空白/空串/未提供的equipmentRef规范为null；有效ID保留。AddLineCard在工作令或实际类别变化时清除旧设备选择，避免跨类型残留；自制类HTML required与服务端必选闸保留。

具名共享池验证在 `apps/server/tests/equipment-receipt-pool.test.ts`，用真实应用服务与内存store，无DB写入：同item两外购行、实际实收1投影1+0；一次多行超额拒绝零记录；先发0.4再跨行0.7拒绝、原行续发0.6合计1；新增较小sourceID+重sync后原有效已发仍占1；撤销0.4后仅释放0.4，新来源重发0.4仍合计1；另一item可发1；实收退回到0时已发1原事实保留、新增发料拒绝。parent原REWORK-PROBES保持原失败，不覆盖。

**并发边界**：上述证明和接收按既有串行命令模型。多进程不同operation同时确认的同池原子封顶未提供；IssueRecordStore仍是先读校验后写记录。本轮未加进程内mutex掩盖，也未扩事务/锁/schema；不得据此宣称“永不超发”或多实例整体生产完备。该风险已由主控明确保留。

针对性closeout：application listing/issue **73/73**、web载荷 **4/4**、server共享池+既有u-wave/cleanup **17/17**；三个受影响包typecheck与build均EXIT0，完整命令/退出码在 `evidence/rework1/*.log` 和result.json。未重跑其它已绿业务或全仓verify。源码检查后仅需求/交付文档改动，运行源码未再改。

运行冻结由父级解除后，仅重建受影响application/server/web并重启本轮隔离API。新绑定 `evidence/REWORK1-UI-RUNTIME-BINDING.json`，PID 89992，web8181/API3101，health/30模块/PG持久设备读取通过。原 FINAL-UI-RUNTIME-BINDING.json 与FINAL-RUNTIME-FILES.json不覆盖，属于首交版本；本次精确产物在 REWORK1-RUNTIME-FILES.json。

父级已在首交运行补验设备A/B/P、各类清单选项、装配/电气设备与rollup、390×844移动提交完整可见、质检物料和入库物料/仓库选项，证据在 `evidence/parent-final-ui/`；未作库存/报工业务写入。这些未受本次源码影响的可见结果复用。本次仅清单可选空值/切类受影响，父级在新绑定上补该项即可。具体操作见 UI-ACCEPTANCE.md 最后的REWORK1段。

当前worker状态：停止产品及运行写入，READY_FOR_PARENT_ACCEPTANCE，等待父级同候选再接收；无commit/push/共享栈/额外迁移。
