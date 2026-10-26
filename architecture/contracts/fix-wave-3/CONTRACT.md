# 修复波 3 合同（fix-wave-3）：组合根接线缺口 + 技术欠账（接线类）

冻结：2026-10-26 午｜派发：第一线总控｜执行：第三线总控（新开线程）

## 0. 背景与并行铁律

- 三线并行在途：wave-1（D-8/D-1，business-store+core/auth）、wave-2（P2/P3 九项，web+baseline/approval/attachment+构建链文档）。
- **本波允许写入面**：`apps/server/src/cross-module-wiring.ts`、`apps/server/src/app-registry.ts`（仅新增接线/注册行）、`packages/application/src/{reporting,inspection,listing,issue,dispatch}/**` 及对应测试。
- **禁碰**：`packages/business-store/**`、`packages/application/src/core/auth/**`（wave-1）；`apps/web/**`、`packages/application/src/{baseline,approval,attachment}/**`、`deploy/**`、根构建链、`TESTING-GUIDE.md`（wave-2）；`noodle-test-output/**`（只读）；`architecture/requirements/**`（冻结，增补登记归收口总控）。
- **中间态纪律（重要）**：wave-1 总控随时会 build 镜像做 SaaS 复证——本波任何中间态必须保持 `pnpm --filter @smes/server build` 绿 + boot 冒烟过（`apps/server` 测试面绿）；接线改动小步走，每步可编译可启动。
- **git 纪律**：不 commit/push/不跑全仓 `pnpm verify`；局部验证绿即停；合流收口归第一线总控。

## 1. Goal / Done-when

四项接线缺口闭合：设计内链路在组合态真实生效（不再是 no-op/显式拒）+ 局部测试与 server 测试面绿 + code-reviewer 验收 ACCEPT + 回传证据。

## 2. 工作包

**W3-1（高价值）末道报工→自制质检、收货→采购质检：组合根 intake 接线**
- 事实源：PRD `architecture/requirements/17-报工与质检.md` §8 开放问题①——reporting 的末道报工→inspection（finalOperation）、listing 收货→inspection（采购质检三源）两路**域层接收面已实现且有测试**，但 `apps/server/src/cross-module-wiring.ts` 组合根未接线（当前仅 #9 dispatch.inspectionIntake 已接，见 :1728 附近注记），线上组合为 no-op 缺省。
- 要求：两路接线（含事件→命令的信封适配，沿 #9 先例）；组合态断言（真实栈或 boot e2e 场景：末道报工 verify 后自制质检单出现；采购收货确认后对应来源质检待办出现）；口径按 17 册 PRD RQ-017/RQ-019 定义与 m2 合同 05/06。
- 注意外协质检触发口径：PRD RQ-018 已裁定"完工投递"（我方口径），接线遵从，勿改域语义。

**W3-2 撤销派工 → issue.cleanup 钩子**
- 事实源：交接包技术欠账清单（HANDOFF §6）："撤销派工→issue.cleanup 钩子未接"。dispatch 域撤销派工事件应触发 issue 域清理已生成的发料任务/子行（幂等，沿事件消费先例）。
- 要求：接线 + 组合态测试；若域侧 cleanup 接收面缺失则补全（application/src/issue/**）。

**W3-3 process-material 派工门禁与空列表覆盖**
- 事实源：技术欠账清单"process-material 派工门禁/空列表不覆盖未接"（U4 交付时登记归接线波）。
- 要求：按 u-wave CONTRACT U4 节口径 + 14 册 PRD（D-LP 涉项）补齐：派工建单时的工序×原材料校验接线（门禁）与空列表行为定义（设计内空集 vs 拒绝，按合同口径）；测试锚定。

**W3-4（受限）upload-stats PG 计数面**
- 事实源：技术欠账"upload-stats PG 计数面未接（409 显式拒）"+ grokbot 报告确认 409 为设计行为。
- 限制：**仅当所需 store 端口在 application 层已存在**时可纯接线；若需 business-store 新增方法/适配器（禁碰），登记不做并回传说明，留第二波。

## 3. 共同纪律

同 wave-2 合同 §3：code-writer-pro 实施 + code-reviewer 验收、修复最小化、局部验证绿即停、429 退避（30s 起步逐次加倍）、回传格式（项｜改动文件｜事实源对照｜接线语义一句话｜测试数字｜验收记录）、`export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`、不 commit。

## 4. 明确不做

D-2/D-3（写入面冲突，归第二波）；D-9（待复测）；PRD 127 项路线图（扩盘刹车）；跨域 PRD 增补登记（收口总控统一做）。
