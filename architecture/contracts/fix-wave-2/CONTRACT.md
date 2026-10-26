# 修复波 2 合同（fix-wave-2）：grokbot 功能测试报告 P2/P3 批

冻结：2026-10-26 午｜派发：第一线总控（zcode 主线程，在途 fix-wave-1：D-8/D-1 两个 P0）｜执行：第二线总控（侧边栏新线程）

## 0. 背景与边界（先读）

- 需求源 = grokbot 三份测试报告：`noodle-test-output/Cadence-functional-test-report.md`（主报告）、`Cadence-saas-test-report.md`（D-1~D-6 细节）、`Cadence-test-report.md`（部署报告）。被测版本 `c80319f`。
- 项目背景与红线：`architecture/HANDOFF-新线程交接V1.0.md`（自研定位/扩盘刹车/清洁室）。
- **与 fix-wave-1 并行，写入面铁律（防止工作树冲突）**：
  - 本波**允许**写入面：`apps/web/**`、`packages/application/src/{baseline,approval,attachment}/**` 及对应测试、`apps/server/src/**`（仅 D-5 若需）、`deploy/**`（仅 README/文档）、根构建链文件（仅 B-1）、`TESTING-GUIDE.md`（仅 B-2）。
  - 本波**禁碰**：`packages/business-store/**`、`packages/application/src/core/auth/**`（wave-1 在途：D-8 改 rls-session/数组事务、D-1 改 permission.service）；`noodle-test-output/**`（测试证据只读）；PRD `architecture/requirements/**`（已冻结）。
- **git 纪律**：不 commit / 不 push / **不跑全仓 `pnpm verify`**（wave-1 半成品在树，全仓 verify 会看到不相关红）——局部验证=受影响包测试 + tsc/build 绿即停。合流收口（全仓 verify + code-reviewer 终验 + commit + push）由第一线总控统一执行。

## 1. Goal / Done-when

9 项缺陷全部修复：各自复现命令复测通过（期望状态码/行为达成）+ 局部测试绿 + code-reviewer 分批评审 ACCEPT + 回传报告（改动路径/测试数字/每项复测证据）。**Done ≠ 派发新需求**：D-9 与"桌面深链刷新"等产品决策项不在本波（见 §4）。

## 2. 工作包（9 项，建议三批：A 后端校验 → B 前端体验 → C 构建/文档）

### 批 A：后端校验与安全（可并行派 code-writer-pro）

**A-1（=D-7，P2）非 UUID id 查询返回 500**
- 复现：`GET /baseline/material-validations/abc` → 500（Prisma P2023 "Error creating UUID"）。期望 400（或 404，按域语义）。
- 方向（二选一，按仓内先例选）：①控制器/服务层入参格式校验；②全局异常过滤器把 Prisma P2023 映射 400（先例：TenantResolutionError→421 全局中间件、各域错误过滤器）。若选全局方案须核实不吞其他域同类错误（全路由矩阵 268 条里只此一条异常，改动面要可解释）。
- 写入面：application/src/baseline/** 或 apps/server 全局错误处理。

**A-2（=D-11，P2）审批可指定不存在的审批人**
- 复现：demo-admin `POST /approval/cases`，approvers=`['no-such-user']` → 201，产生永远无人处理的审批单。期望 400。
- 方向：approval 域创建案件时校验 approvers 均为存在且活动的用户（org 域用户查询端口；注意保持错误信息不泄漏跨租户用户存在性——按租户收口）。
- 写入面：application/src/approval/**。

**A-3（=D-4，P3）附件签名 URL 未绑定租户**
- 复现见 saas 报告 D-4：HMAC 只读引用（约 60s TTL）未含租户维度。方向：HMAC 载荷加入 tenantId 并在兑现时校验一致（保持向后兼容窗口可不做——单仓未发布）。
- 写入面：application/src/attachment/**（read-reference-tokens）。

**A-4（=D-5，P3）未知租户 404 与 README 写的 421 不一致**
- 先查实态（wt-m4 曾做 TenantResolutionError→421 全局映射+e2e 锚定）：实测 404 发生在哪层（server / proxy / web 容器）。二选一对齐：改代码恢复 421 口径，或修 README 口径——以 e2e 既有断言为准绳，如实登记取舍。web 容器对未知租户提供登录页一并在结论中说明（可只改文档）。
- 写入面：apps/server/src/** 或 deploy/README.md。

### 批 B：前端体验（一个 writer 或并行两个）

**B-1（=D-12，P3）approver/viewer 首页请求无权限接口**
- 复现：approver/viewer 登录首页请求 menu-config/configs、notifications/unread-count、workbench/*、workorder/delivery-situation 得 403，控制台报错。期望：按 session 权限投影，无权限的卡片/入口不发起请求（菜单可见性=接口可达性纪律已存在，对齐到首页数据请求）。
- 写入面：apps/web/src/pages/{overview,workbench}/**（必要时 product-ui 视图模型最小改动）。

**B-2（=D-6，P3）viewer 工作台卡片停在"正在加载…"**
- 复现：403 后卡片不报错不提示。期望：显式"无权限/无数据"态。与 B-1 同域可合并实施。

**B-3（=D-13，P3）成本页发布时刻显示原始 UTC ISO**
- 复现：`2026-10-26T03:49:26.749Z` 原样显示。期望：本地时区格式化（查仓内前端有无既有日期格式化工具，优先复用）。
- 写入面：apps/web costing 页。

### 批 C：构建与文档

**C-1（=B-1'，P3）干净克隆 `pnpm verify` 报 TS2307**
- 复现见功能报告沿用表：typecheck 早于 build 导致引用产物类型不存在。方向：verify 链任务依赖顺序修正（turbo/根 scripts）。注意：此改动影响全仓 verify 命令编排——修复本身局部验证（干净克隆模拟可用 git worktree 临时目录），**不要在本仓跑全仓 verify 验证**（wave-1 半成品干扰），回传说明验证方式即可。
- 写入面：根 package.json / turbo.json 等。

**C-2（=B-2'，P3）product-ui 测试计数文档不符**
- 实测 130 vs 文档 123。改文档为实测数（找出所有写 123 的文档处）。
- 写入面：TESTING-GUIDE.md 等文档。

## 3. 共同纪律

1. 实施全 code-writer-pro（GLM-5.3），验收 code-reviewer（GLM-5.3，只读原始证据，不采信转述）；每项验收记录（agentId+结论）随回传登记。
2. 修复最小化：不顺手重构、不扩范围；口径没把握列开放问题回传，不私设。
3. 局部验证：受影响包 `pnpm test`/`tsc`/`build` 绿即停；前端改动跑 web/product-ui 测试面。
4. 遇 429/限流：30s 起步逐次加倍退避重试同一调用，不当作任务失败。
5. 回传格式（每项）：缺陷号｜改动文件｜根因一句话｜修复一句话｜复测命令+实测结果｜测试数字｜验收记录。
6. 命令前 `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`；不动 `noodle-test-output/`；不 force push；不 commit。

## 4. 明确不在本波（勿顺手扩）

- **D-9（报工超派工数量可提交）**：待 wave-1 的 D-8 修复后由 grokbot 复测确认，确认真缺陷另派。
- **D-2（新建用户无口令/无设置口令 API）**：写入面与 wave-1 的 core/auth 交集，归 wave-1 收口后第二波。
- **D-3（附件内容重启丢失，P1）**：持久化方案大概率动 business-store（与 wave-1 交集），归第二波；方案预研（PG bytea vs 文件卷）可先行登记不落码。
- **桌面深链刷新体验**（MPA 无 history fallback）：产品决策项，提请 Owner 裁定后才动。
- PRD 127 项待实现路线图：扩盘刹车，Owner 点向才做。
