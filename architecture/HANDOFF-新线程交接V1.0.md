# Cadence 新线程交接包 V1.0（Transfer）

日期：2026-10-26 晨｜出让人：总控会话（zcode-cadence-s3-mobile 线，session_cf920580）｜依据：Owner 指令"写一个完整的交接文档，我们换一个新线程"

## 1. Purpose / Goal / Done-when

Cadence = **自研一套完整可交付的机加工 MES 产品**（Owner 原话定性"全新产品，自己做一套，不是替换任何现系统"）。判定口径 = 0920 清单 **109 标准项端到端**（每项=后端+呈现）+ 全链路验收证据。

**Done-when 已达成**：109/109 功能覆盖（M1 线终态矩阵 cp-st-wave-final）+ 全仓 verify exit 0 + 全量推送 GitHub + 部署栈实览可用。当前处于**交付后运维/测试阶段**。

## 2. Why Transfer Is Required

Owner 明确指令换新线程（本会话上下文极长，跨 M0~M5→S/T/U 波→部署→测试交接全周期）。语义边界：同一项目、同一 Owner，控制器换会话承接；无目标变更。

## 3. Current Verified Truth（全部有实证，非转述）

- **GitHub**：`https://github.com/yeemio/Cadence`（私有），main = **`baedb19`**，本地=远端，**工作树零脏文件**。
- **提交链**（12 个）：ee16599（M0~M5 初版）→ 127e353（D8/approve-builds/CI 对账门禁移除）→ 4abe16e（S/T/U 三波 232 文件）→ 0b8566c（并 lane/m4-final，3 冲突语义并集）→ 54ac017 → d310a6e（U6 接线波）→ 4835e2e（U7 项目成本）→ cf803ae（U8 逾期口径）→ 50aa8a5（部署修复）→ 56bae00（登录文案）→ baedb19（TESTING-GUIDE）。
- **测试基线**：全仓 `pnpm verify` exit 0（application 549 / business-store 164 / engine-reporting 49 / server 65 / web 117+14skip / product-ui 123 / testkit 77）；六套容器 e2e + 活库冒烟全 PASS 历史（apps/server/package.json scripts `*:e2e` / `smoke:live-db`）。
- **U 波（文档增量八模块）全部实施→独立验收→落地**：issue 发料（含一轮 REWORK 终裁）/ report-center 口径包+A9 / attachment 文件管理 / process-material / aftercare-claim 售后报销 / T1 三域接线 / costing 六块成本 / 逾期报表口径。**U9 物料价格台账已中止并清除**（Owner 扩盘刹车）。
- **部署栈正在运行**（单机形态，27 模块）：cadence-pg/server/web 三容器 healthy；web http://localhost:8080（移动 /m）、API :3000、PG 127.0.0.1:55432；账号 admin / demo-admin / approver / viewer，口令统一 `demo-password`。SaaS 形态起法见 TESTING-GUIDE.md §3。
- **grokbot 测试交接就绪**：`TESTING-GUIDE.md`（仓根）——安装/验证链/六套 e2e/部署/账号/设计内行为/分层地图/纪律。

## 4. Candidate / Runtime / Gate / Writer / Authority / Cwd / Worktree

- **Candidate**：无在途候选；全部已验收落库。**Writer**：新线程总控（唯一 writer 纪律）。
- **Authority**：GitHub push 已由 Owner /goal 显式授权（本仓既有事实）；**不 force push、不改 git config**。版本 tag/收版动作仍待 Owner 指令。
- **Cwd/Worktree**：`/Users/yeemio/AI/gitrep/Cadence`（main，干净）；两 worktree 目录（../Cadence-wt-m4、wt-m5）已空置，lane 分支本地已删（远端 lane/m4-final、lane/m5-final 仍在，内容已并入 main，可删未删）。
- **协调账本（RunKit，GPL 禁入本仓，控制目录在仓外）**：dual-lane=`/Users/yeemio/AI/gitrep/cadence-runkit`（M1/M2 两 WI 均 completed）；S3/T/U 线=`/Users/yeemio/AI/gitrep/cadence-runkit-s3`（WI completed 1/1，s3-merge 门已过）。用法要点：测度型 checkpoint 必须带 `--completed-units`；WI 单 assignment 模型不收并行第三线；跨工作区借用 CLI 会 binding mismatch 拒。
- **定时器**：全部已撤（CronList 空）。**子代理**：全部终止，无遗留。

## 5. What Not To Reopen / Valid Evidence（Owner 裁定，新线程勿翻案）

1. **自研定位**：不是替换任何现系统；"活系统"字样勿再用"被替换旧系统"表述。
2. **对账取消 + R7 失效**（Owner 终版裁定，ckpt-merge-pending-handoff 在案）。36 场景包（testkit/fixtures/m2-scenarios/）保留可作自比对回归，不再作验收。
3. **73 份开发文档全面解禁为需求输入**（`/Users/yeemio/AI/project/sieracMes-AI/docs/开发文档/`，注意在 AI/project/ 不是 gitrep/）；仍有效红线=零搬运现系统源代码 + 许可证白名单 MIT/Apache/BSD/PostgreSQL。
4. **扩盘刹车（最重要）**：Owner 原话"一个企业能做的功能多了去了……你查的远了"——**待办池只做 Owner 点向项，不自动挖需求派发**。
5. U1~U8 验收裁决（各 code-reviewer ACCEPT 记录）不重开；U9 已清除勿复活。

## 6. Dominant Gap / Unique Next Action

**唯一主线 = 等 grokbot 测试报告 → 按报告派 code-writer-pro 修复 → 验收 → verify → push（修复循环，Owner 已授权的迭代模式）**。次级（均等 Owner 点向）：待办池（A4 采购件汇总/A8+A10 大屏/列显隐 A14/S 增强 12 条/B1-B3）；收版三件套（版本号/tag/push 节奏）；本机遗留容器 `cadence-s4fix2`（S4 线遗留调试 PG，端口 55498）可清。

**已知技术欠账清单**（不阻塞，修复波顺手清）：upload-stats PG 计数面未接（409 显式拒）；costing 需先发 rebuild 命令才有快照；IssueMaterialPort.reserveStock 无创建方（核销空集）；撤销派工→issue.cleanup 钩子未接；process-material 派工门禁/空列表不覆盖未接；attachment 对象层无租户前缀（接 MinIO/S3 时必须补）+upload 建议换 raw/multipart；报表跑批调度全部归部署期（口径已冻结在 description）。

## 7. Observable Stop Condition / Recovery Source

- 每轮修复循环的停止条件：`pnpm verify` exit 0 + 验收 ACCEPT + push 成功。
- 恢复源（按序读）：本文件 → `architecture/status.md`（仓内进度事实源）→ `~/.zcode/cli/memories/projects/cadence-733ba79f874d6830/memory/cadence-project-identity.md`（跨会话记忆）→ 两账本 `project status`。

## 8. Important Files / Receipts

- `TESTING-GUIDE.md`（grokbot 手册）｜`architecture/RUNBOOK-总控收口.md`（收口序列，含合并预检）｜`architecture/contracts/u-wave/CONTRACT.md`（U 波合同+待办池排序）
- `architecture/coverage/DOCS-INVENTORY-DIFF.md`（73 文档→实现映射+差异登记）｜`deploy/compose.yaml`+`deploy/README.md`（双形态）
- 验收记录：各 checkpoint（账本）+ status.md 段落；实施者身份均登记（代理+模型+agentId，同族 GLM 记账）

## 9. Starter Prompt（新线程首条可直接粘贴）

> 读 /Users/yeemio/AI/gitrep/Cadence/architecture/HANDOFF-新线程交接V1.0.md 接任总控。先读交接包→status.md→记忆文件恢复上下文。当前唯一主线：等待/处理 grokbot 测试报告（TESTING-GUIDE.md 交接在案），按"code-writer-pro 修复→code-reviewer 验收→pnpm verify→push"循环执行；待办池仅 Owner 点向（扩盘刹车在案）；不 force push；命令前 export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"。
