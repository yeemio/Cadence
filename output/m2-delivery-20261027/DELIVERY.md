# DELIVERY · cadence-m2-delivery-20261027（含 R1 增量收口 §9 + PM REWORK 差量 §10）

- 交付时间:2026-10-27(深夜收口)Asia/Shanghai；**REWORK 差量补齐:2026-10-28 11:0x（§10）**
- **当前唯一控制会话：session_9e2b03feecb4bf840ee5e4097a74ab97（ZCode 主线程 GLM-5.3，本文件与候选的唯一 writer；候选冻结点见 §10.4）**
- 工程总控:ZCode 主线程会话(GLM 家族,bigmodel-individual-coding-plan/GLM-5.3)
- **R1 增量（裁-12＋具名岗位入口）由承接 R1 包的第二总控会话收口,登记见 §9(单列),候选已在其后再次全仓 verify exit 0;两差量之外本节 §1-§8 为原工程总控账本,未重做**
- 产品仓:`/Users/yeemio/AI/gitrep/Cadence`

## 1. 身份与候选

| 项 | 值 |
|----|----|
| 包 ID | cadence-m2-delivery-20261027(启动状态由 `prompt_ready_not_launched` → 实际已执行,本文件即回执) |
| 基线 commit | `061db587ff6af3f9abef89753e225ebd9014565f`(main) |
| 交付候选 | **基线 + 未提交工作区增量**:94 文件修改(+4509/-463)+ 21 个未跟踪新文件(全部在本仓,清单见 `git status`;含 i18n 基建、format 工具、displayName、导航错误过滤器、SP-3 冒烟脚本、error-code 测试、docs/user-manual 全套) |
| 提交/部署状态 | **未 commit 未 push**(无授权;候选=工作区态,verify 于该态全绿) |
| 两轮修复波 | Round-1:W1-W9 八组(UX 68 条 P1 全修+P2 横切);Round-2:W10a/b/c 三组(5 条 P1 全修+P2/P3)+W-sec 安全波 b+W-docs 交付材料。逐条 changed paths 见 `noodle-test-output/ui-multirole-v1.0.0/results/p1-fix-wave1-delivery.md`(Round-1 登记)与本文件 §3 |

## 2. RunKit

**未绑定**。本轮无 canonical workspace/goal/assignment 登记(旧 M1/S3 账本未冒用);如需 RunKit 连续性由 Owner 指定绑定,恢复点=本交付。

## 3. 范围结果(执行包四组)

### A. 多语言收尾 — 完成接收
- 波 1(web 基建+81 错误码)+波 2(server 21 filter 错误码化,`error-code-mapping.test.ts` 82 测试绿)均为并行会话 i18n 波落盘,本总控接收不重做;ADR-0012 accepted。
- UX-VW-R2-04 语言漂移:探查定性=共享浏览器画像 localStorage 污染(产品代码零自动检测,grep 实证),产品侧无待修点——独立画像复现建议已随 Round-2 结论登记。
- en 骨架边界/回落语义随 ADR 验收;代表页面走查并入安装验收(web 入口/登录实测可用)。

### B. 安全波 b — 完成(验收 ACCEPT)
- **SP-3** 两域签名密钥 env 固化:`main.ts` 解析(hex64/base64 32B,fail-fast 拒启动沿先例)+三适配器注入+图纸 signer 透传(修复 PG 适配器 L209 未透传);冒烟 30 断言两域各证(重启兑现 200/未设 warn+404/非法 exit=1);`deploy/.env.example`+`compose.yaml` 透传+README 登记(compose/README 超字面路径裁量经验收追认:无透传则死配置)。
- **CM-1** 四安全头双拓扑(nginx 权威层+server 中间件,租户失败响应也带头);CSP 按实态定制(sha256 双 hash 放行 SW 注册与 offline style,无 unsafe-inline;浏览器实证 SW active);六路 curl+浏览器同源 fetch 实证。
- **PUR-R2-03** 根因修复:SPA 壳响应 `Cache-Control: no-cache`+`Vary: Accept` 收口全部壳路径(含 /bigscreen try_files 末参语义),304 协商实测;静态资产策略不变。
- SP-5/裁-11 维持待 Owner(未阻塞);SP-6 不升级 cookie 迁移(非目标遵守)。

### C. 多角色业务链与 D-18 — Round-2 实测回填+修复闭环
- Round-2 复测(CONDITIONAL PASS)即业务链实测:上轮 12+SCR 复测 9 PASS/1 PARTIAL/2 FAIL;L2/L3 夹具链跑通至 approved。
- 5 条开放 P1 全部修复并验收:PLAN-03(类目汇总 vacuous,含 workorder kit.check 同根口径分叉一并修)、PUR-03(双选择器)、QC-R2-03(不合格详情)、VW-R2-01(派工写面闸)、AP-SEED-01(plan01 补 parts:approve,五岗核对无同类缺口)。
- P2 17 条/P3 9 条按证据回原域修复(W10a/b/c 覆盖;观察类 3 项不立项);语言漂移/串流根因探查登记(后者已修)。
- **D-18**:日统计数值证据**未观测**(本轮无日批窗口)——维持「数值未验」非阻断原状,不声称通过。

### D. 客户交付材料与安装验收 — 完成
- **材料四件**:用户手册(`docs/user-manual/README.md` 入口+八岗+22 步旅程)、KNOWN-BEHAVIORS(A14 设计内/B13 限制,C/D 快照)、deploy README D1-D9 安装手册、demo-handover(可重放演示)——事实全核实零断链,不虚构(D-22 如实未支持)。
- **干净环境安装验收**(隔离 compose 栈,含本轮未提交增量 build):D1-D5 实走通过(依赖/起栈/健康三面 200/初始化基础种子 admin 可登/工厂种子方式 B 幂等);岗位走链实测:六岗登录全通、报工业务校验拒绝(超量,中文拒因)、**AP-SEED-01 运行时闭环**(plan01 批准配件申请 committed,修复前 403)、**齐套新口径活体实证**(0 行类目 complete=False)、**齐套硬闸**(装配派工拦截+中文拒因)、**403 人话文案**、错误码化(400+code+中文 message)、**CM-1 四头+缓存双头经 web nginx 实收**。
- 安装验收发现并已修文档两处:demo-handover 步 4 岗位笔误(装配派工归生产岗)+方式 A compose run 缺 env 会触发 pg recreate 坑(补实测提示);发现登记:种子质检单无 itemId(质检放行入库演示态不可直走,种子数据缺口)。
- 栈已清理(隔离 project down -v,常驻栈未动)。

## 4. 验证证据

| 验证 | 结果 | 证据 |
|------|------|------|
| 全仓 `pnpm verify` | **exit 0**(多轮,最终态含全部增量) | server 25 files/232、business-store 26/221、application 47/693、web 23/231、testkit 77 全绿;boundary+selftest 过 |
| SP-3 冒烟 | 30 断言 PASS(两域) | `deploy/scripts/sp3-signing-key-smoke.mjs` 输出(writer+验收方双跑) |
| CM-1/PUR-R2-03 | nginx 容器六路 curl+304+浏览器实证 | W-sec 回传+验收方复跑(隔离栈二次实证) |
| 验收链 | Round-1 八组+W-sec ACCEPT(1 组 REWORK 后闭合);Round-2 三组 ACCEPT | 各 code-reviewer 只读验收报告(同族记账,GLM 家族内,未触发跨家族通道) |
| 安装验收 | 隔离栈实走+走链闭环 | 本文件 §3.D;文档修正已落 |
| Playwright e2e | 未实跑(需常驻栈,归属移交测试) | 断言静态适配+typecheck:e2e 过;两轮浏览器实测由测试方完成 |

## 5. 保护与恢复

- 全程未 reset/clean/宽泛暂存;PROTECTED-WORKTREE 清单内改动全部保留并叠加。
- 唯一一次容器 recreate 事故(安装验收方式 A 缺 env 触发 pg recreate):同 env 重建恢复,数据卷未失,已写入文档提示。
- 回滚面:全部改动未提交,`git stash`/`git checkout -- <path>` 即可分域回退;新增文件清单见 `git status` 21 项。
- 修复登记文件:`noodle-test-output/ui-multirole-v1.0.0/results/p1-fix-wave1-delivery.md`(Round-1 全量+followup 12 项)。

## 6. 用户交付物

| 物 | 入口 |
|----|------|
| 用户手册 | `docs/user-manual/README.md`(getting-started/journey-core-chain/roles×8) |
| 已知行为说明 | `docs/user-manual/KNOWN-BEHAVIORS.md`(A 设计内/B 限制/C 开放快照/D 待裁) |
| 部署手册 | `deploy/README.md` D1-D9 节 |
| 演示交接 | `docs/user-manual/demo-handover.md`(含实测提示) |
| 安装验收 | 本文件 §3.D(实走记录) |

## 7. 审查

- 各组验收=code-reviewer(GLM-5.3)只读原始证据,**同族验收记账**(全链 GLM 家族);未触发跨家族通道(无 Owner 指令)。若产品接收要求跨家族独立验收,当前不满足,须另触发 owner-chatgpt-github-review 类通道——如实声明。
- DS-REVIEW 通道:未绑定外部审查 provider/model,当前状态=「候选已就绪、外部审查待绑定」。

## 8. 待决与下一步

| # | 待决 | 谁提供什么 |
|---|------|-----------|
| 1 | SP-5/裁-11 图纸兑现是否须登录 | Owner 裁定;裁定后实施或销项 |
| 2 | D-18 日统计数值 | **R1 更新:自然日批已实证运行**(三租户 machining_daily_stats 落账 2026-10-26 行,computed_by=machining-daily-job,00:10 UTC 自然触发非受控);数值仍空+pendingReasons 登记「数据源待接(PRD RREQ-RP-027 上游读面缺失)」——机制已证,数值未验口径维持,待上游接入后对账(详见 §9) |
| 3 | ROLE-PACKS 文档 13→14 码换版 | 文档 Owner(AP-SEED-01 超前一步,码表+测试已登记分歧) |
| 4 | purch01 无 warehouse:read(收货仓库下拉对其降级文本框) | Owner 裁种子码表是否补 |
| 5 | R2-08 采购负责人 displayName 深修二选一(seed 加 user:read 或投影带名) | Owner 选路径 |
| 6 | .env.example 被 gitignore 不随 clone 分发 | Owner 定分发策略(README 已写自建指引) |
| 7 | CSP hash 维护耦合(升级 vite-plugin-pwa 须重算双写) | 运维登记,已在 README/nginx 注释 |
| 8 | 种子质检单无 itemId(演示链质检放行入库不可直走) | 种子维护批补数据 |
| 9 | QC-02 跨包 schema 缺口/WH-05 仓库启停概念/P4-3 死导出等 followup | 详见 p1-fix-wave1-delivery.md(非阻断) |

**唯一下一动作**:Owner 将本 DELIVERY(含 §9 R1 增量与候选=工作区态)带回 Codex PM 聊天 `01a17d85-16ec-7c42-a86d-7d42711031a3` 做产品接收(ACCEPT/REWORK/BLOCKED);若 ACCEPT,下一动作是授权 commit 形成正式候选(建议单 commit 或按波分 commit 由 Owner 定)。

---

## 9. R1 增量收口登记（裁-12＋具名岗位入口；承接 R1 包的第二总控会话,2026-10-27 23:35）

R1 差量之外的全部复用 §1-§8;本节单列 R1 两个新增交付项。候选=同一工作区态(R1 后 `git diff` SHA256 前 16 位 `4ba4060d9db938f6`,94 文件+4509/−463 叠加 R1 改动后),R1 收口后全仓 `pnpm verify` 再次 **exit 0**(server 25 文件/232 用例含 sp3 全过;早前一次基线跑中 sp3-signing-key-wiring 出现过一次非确定性失败,单跑+两次全量均绿未复现,登记观察)。

### 9.1 裁-12:图纸通知 clearance 过滤 — 已修复并三态实证（code-reviewer ACCEPT）

- **修前现状核实**(当前候选仍可复现):`GET /drawing/notices/:drawingId` 仅 `drawing:read` 门禁,服务层不过滤——受限修订 changeNote 可被低许可用户读到(决策队列记录属实)。
- **修复**(code-writer-pro/GLM-5.3,agent_49383b33):`packages/drawing/src/drawing.service.ts` `notices()` 增 viewer——`classificationRank` 未知许可 fail-fast→修订链 version→classification 映射→`classificationAllows` 逐行过滤,**孤儿通知(toVersion 不在链)fail-closed**;sinceVersion 游标与过滤取交集语义不变;`apps/server/src/drawing-http.module.ts` notices 路由 `viewerOf` 装配(`drawing:read` 保留);前端 NoticesCard 传页面级 clearance(对齐 chain/view 既有模式,非前端-only 过滤)。
- **三态证明**:①低许可(public)看不到受限通知及 changeNote ②有权(restricted)可见 ③普通通知低许可可读;另证未知 clearance 400 fail-fast/未登录 401/有身份无 `drawing:read`(qc01)403/跨租户收口。证据三层:单测(drawing 38/38,4 个裁-12 专项)+e2e(cross-module-wiring 服务端过滤断言)+**运行栈 API 读回**(`noodle-test-output/m2-r1-20261027/cri12-notices-readback.log`,靶图纸 v1 public+v2 restricted 实发布,泄露计数 0)。
- **验收**:code-reviewer(GLM-5.3,agent_9500bc14)只读 ACCEPT——独立 curl 复核三态与游标交集,确认过滤在服务端返回前完成、无数组分页面(带分页的 drawingsIndex 同口径过滤一致)。完整报告原件=`evidence/code-reviewer-security-r1-accept.md`。
- **保证边界限定（PM 2026-10-28 接收裁定补写）**：本轮保证=「通知按**调用方声明的 clearance** 对关联修订的可见规则过滤，且 drawing:read 权限门独立有效（qc01 403 证）」。图纸域 v1 **无租户许可配置面**，clearance 是显式请求参数（沿用原图纸合同模型，`viewerOf()` 直接解析请求值）——**本轮不能表述为「防止低许可身份自行声明高保密等级读取受限通知」**：e2e 的双许可对照也是改变请求参数而非证明用户获授等级。真实身份↔保密等级绑定归原图纸合同 **P2-3／O5 待决**（租户许可配置面），未自动启动新权限工程。该限制已写入 KNOWN-BEHAVIORS 客户可见条目。

### 9.2 岗位入口①:计划岗工作令选择与上下文跳转 — 已交付并浏览器读回

- **修前现状**:清单/缺口核查页「粘贴工作令 id」手填,工作令页无跳转入口(原记录属实)。
- **修复**(code-writer/GLM-5.3-Flash,agent_79930534):两页 datalist 候选(`listWorkOrders`,403/无数据静默降级手填,沿派工页 UX-PRD-09 先例);工作令详情操作区「清单」「缺口核查」入口(listing:read/gap:read 权限闸,菜单同码)带单跳转 `?wo=<id>`;目标页确认行「当前工作令:项目名·短码」;换单清态。
- **读回**(browser-role-readback.md):plan01(14 码投影)→选 wo-seed-factory-01→「清单」→`/listings/sheets?wo=…` 四类清单自动加载+datalist 候选(id+项目名)→「缺口核查」跳转→执行核查快照读回(0 行类目「无清单行(未参与核查)」,PLAN-03 修正同屏实证)。

### 9.3 岗位入口②:质检「特采让步」复核与「判定撤销」入口 — 已交付并全流程读回

- 特采(W7 建+W10b 类别闸)复核可用:自制外协单呈现「特采不适用(仅非标件采购)」同口径说明——复用不重做。
- **判定撤销**(code-writer/GLM-5.3-Flash,agent_45a6de89):详情卡「判定撤销」——passed/failed 可撤(pending/closed 禁用+同口径说明)、原因可留痕(空=null 走服务端默认)、两步确认讲后果(判定回退/字段清空/明细作废/特采清零)、成功读回、失败呈现 reason 不引导重复提交、切行清除、无权(inspection:judge)禁用+说明。
- **读回**:qc01 判定(合格 10,流转「待检→合格」)→撤销(两步确认)→**回待检、字段清空、流转记录「合格→待检(撤销质检)」**、状态闸回位;viewer 直连撤销 POST **403**(revoke-entry-readback-api.log)。语义边界保持:未做特采入库联动(裁-02 待决不变)、撤销未扩成撤销完工。

### 9.4 R1 配套收口

- **A 组走查复证**:切 English(html lang+壳/菜单英文+`smes.locale` 持久化)、刷新保持、模块页中文回落符合 ADR 骨架边界、切回中文(browser-role-readback.md)。波 3(titleCode 迁移)按 proposal §8 排期建议留待 Owner 首客户语言裁定,未执行未冒充。
- **手册同步 R1 入口**(总控 Direct):inspector.md(撤销入口/特采闸/恢复表)、planner.md(选择与跳转/候选降级恢复)、KNOWN-BEHAVIORS(B5 重写/B11-B12 更新/C 表 5 P1 全闭合标注);另一会话 B13/W-sec 登记原样保护。
- **干净安装增补**:SaaS 关键差异复验(叠 saas profile:子域租户解析 200/域内未知 404/域外 421/安全头经代理透传,clean-install-saas-readback.log);单机形态二次实走(clean-install-readback.log,含 CM-1 四头);隔离栈拆净(down -v)。
- **环境事实(如实)**:重建容器须显式传全模块 MODULES_ENABLED(缺省六模块,实证文档警告有效);直接写库造厂后需重启 server 使权限 enforcer 重载(真实演示顺序起栈→造厂→首登不触发;直写绕过 apply/revoke 不同步属 M1 登记推迟项);测试栈旧 SW 需注销后新候选自愈。
- **R1 实施者身份**:裁-12=code-writer-pro/GLM-5.3(agent_49383b33);质检撤销=code-writer/GLM-5.3-Flash(agent_45a6de89);计划岗=code-writer/GLM-5.3-Flash(agent_79930534);安全域验收=code-reviewer/GLM-5.3(agent_9500bc14,同族记账);总控 Direct 项=主线程。R1 证据目录:`noodle-test-output/m2-r1-20261027/`(冒烟/头/三态读回/浏览器读回/干净安装 5 份)。

---

## 10. PM REWORK 差量补齐（2026-10-28 产品接收 REWORK 后；唯一控制会话=session_9e2b03feecb4bf840ee5e4097a74ab97）

PM 三具名缺口（ROADMAP.md 2026-10-28 产品接收记录）逐项对账：

### 10.1 缺口① 多语言范围与完成声明不一致 → 已补已授权缺口（波 2 高频面）

- **授权对齐**：ADR-0012（Owner accepted）+ proposal §8 波 2 枚举=五高频模块 namespace（workorder/dispatch/inspection/inventory/reporting 列表+表单+详情）+ApiError code 消费+术语表（R4）——属已授权范围；波 3（通知 titleCode 落库迁移）维持 proposal §8 排期待 Owner 首客户语言裁定（PM 认可暂停有依据），未执行未冒充。**未删除任何合同范围。**
- **补实施结果**（依据 Owner「多线程开满推」指令；子代理档位按 Owner 2026-10-28 指令全换 GLM-5.3，Flash 三任半成品审计吸收）：workorder 164 键、inspection 151+inventory 105 键、dispatch+reporting 51 键（全部 zh=en 同构、zh 值与页面原文逐字符一致）；五模块高频页全 chrome 接线；ApiErrorHint 按 code 映射（15 白名单码 en 英文/zh 行为零变化/未知回落原文）；共享件 QueryState/CommandOutcomeHint 7 文案接 common；TERMINOLOGY.md 术语表落档；统一接线（Namespace+shell init，登录入口隔离保持）。
- **验收判据逐条**（原件 `noodle-test-output/m2-r1-20261027/i18n-wave2-rework-evidence.md`）：①en 高频页走查——首轮十页仅三类残留（语言自名/用户显示名/共享加载占位），占位当场修复后复扫六页**中文 chrome 残留零**；②e2e message 断言零改动（zh 逐字符一致，web vitest 231 绿两轮+全仓 verify exit 0）；③en 操作测试失败条 lead="Operation failed"+原文回落（码映射渲染 smoke 12 例双语逐字符一致）。
- **A 组状态修正声明**：原 §3.A「波 2 完成」口径修正为——**波 1 全部+波 2 全部（高频面+错误链路 code 化）已交付；波 3 未执行待裁定**。listing 模块页不在波 2 冻结枚举（五模块），en 下保持中文属骨架边界（如实登记，非缺陷）。

### 10.2 缺口② 完整候选与审查原件未绑定 → 已补档（证据目录 evidence/）

- **`CANDIDATE-MANIFEST.txt`**：候选冻结清单——161 个文件（94 已跟踪改动+67 未跟踪新增，含 i18n 资源/测试/用户文档全部未跟踪面）逐文件 SHA256；聚合哈希 `55f02e87…8d7f37`；排除面单列（PM 投影三文件=PM 聊天维护、task-packages 制包输入、output/ 回执目录）；安装输入绑定=镜像构建上下文即该清单覆盖的工作区（镜像逐文件反解未做，如实登记）。
- **verify 原始日志三份**：基线（EXIT=1 sp3 观察项）/R1 终态（EXIT=0）/REWORK 终态（**EXIT=0**，2026-10-28 10:5x，全仓含波 2 增量）——`evidence/pnpm-verify-*.log`。
- **reviewer/writer 原件**：`evidence/code-reviewer-security-r1-accept.md`（三项 ACCEPT 完整报告）+`evidence/writer-reports-r1.md`（三 writer 逐字）；波 2 实施与走查证据=`noodle-test-output/m2-r1-20261027/i18n-wave2-rework-evidence.md`。**如实缺失标注**：另一工程会话（W10/W-sec）reviewer 逐条原件未落盘（其会话已结束），仅能引用 DELIVERY §3/§4 摘要与 p1-fix-wave1-delivery.md（Round-1 在档）——evidence/README.md 已声明。
- **DS 状态不变**：通道未绑定=「候选已就绪、外部审查待绑定」；内部分级验收为同族记账，未记成 DS/跨家族。

### 10.3 缺口③ 裁-12 保证需按原模型校准 → 已限定（§9.1 限定语+KNOWN-BEHAVIORS A15）

本轮保证=通知按**调用方声明 clearance** 对关联修订可见规则过滤+drawing:read 权限门独立有效；**不表述为防低许可身份自行声明高保密等级越级**（clearance 为显式请求参数=原图纸模型 v1 无租户许可配置面，viewerOf 直接解析请求值，e2e 双许可对照也是改参数非证获授等级）。真实身份↔保密等级绑定归原图纸合同 **P2-3/O5 待决**，未自动启动新权限工程。客户可见限制=KNOWN-BEHAVIORS A15（含公网/多客户部署威胁模型提示）。**证据卫生**：裁-12 与干净安装读回的脱敏副本入 evidence/（令牌遮蔽），原件受控保存于 noodle-test-output。

### 10.4 候选冻结点与控制权收敛声明

- **冻结点**：本 DELIVERY §10 写入时的工作区字节实态=`CANDIDATE-MANIFEST.txt` 聚合 SHA256 `55f02e87d86ad7eff5caa6f6dab2a5c0cdf9e30995cc65b734d3c90a4e8d7f37`（161 文件，2026-10-28 11:0x Asia/Shanghai）；此后本候选停止写入，等待 PM 再接收。PM 文档差量（ROADMAP/PRODUCT_CONTRACT/PRODUCT_LIFECYCLE_MAP，PM 聊天维护）已从候选清单排除单列——后续整体 diff 变化可区分 PM 差量与候选变化。
- **唯一控制会话**：session_9e2b03feecb4bf840ee5e4097a74ab97（本会话=承接 R1 的总控，REWORK 后为候选唯一 writer）。
- **两会话写入收敛**：原工程会话（W1-W10/W-sec/W-docs/DELIVERY §1-§8）已结束，其产出经本会话接收核实（verify exit 0×3、读回、验收）后叠加，其 KNOWN-BEHAVIORS B13/W-sec 登记原样保护；本会话写入=R1 两差量（§9）+REWORK 三缺口补齐（§10）。全程未 reset/clean/宽泛暂存，PROTECTED-WORKTREE 保留。未 commit/push/tag。
- **子代理登记（REWORK 波）**：波 2 workorder 审计任=code-writer-pro/GLM-5.3（agent_62cbdad8）；inspection+inventory=code-writer-pro/GLM-5.3（agent_d405fa25）；dispatch/reporting+共享件+术语表+统一接线+走查=总控 Direct（主线程 GLM-5.3）；Flash 三任（agent_39623751/20285cc8/b470595e）被 Owner 指令停用，半成品审计吸收。[1302] 限额四次中断（09:37/09:42/09:45/09:58）均按退避+断点续作恢复，无重跑浪费。

### 10.5 待决事项（不变）

SP-5/裁-11、波 3（通知 titleCode，等 Owner 首客户语言裁定）、D-18 数值（上游读面待接）、QC-02/WH-05/L2L3 种子/菜单改名、.env.example 分发、purch01 warehouse:read——均维持原状态，见 §8 与 §9。

**唯一下一动作（不变）**：Owner 将本 DELIVERY（§9+§10）带回 Codex PM 聊天 `01a17d85-16ec-7c42-a86d-7d42711031a3` 再接收（ACCEPT/REWORK/BLOCKED）；ACCEPT 后下一动作是授权 commit 形成正式候选。
