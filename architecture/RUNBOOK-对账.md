# 对账阶段执行预案（RUNBOOK）

状态：待 Owner 提供活系统环境（唯一阻塞）。工具全就绪：ReconcileHarness（`packages/testkit`）+ 九模块 36 场景包（`packages/testkit/fixtures/m2-scenarios/`，`reference` 刻意留 null 等活系统录制）+ 活库管线（`apps/server/scripts/e2e-live-db.mjs` 范式）。

## 一、环境前置（Owner 提供）

- [ ] 活系统访问：可访问的线上系统 URL + 只读账号（或等效数据快照 + 导出接口）
- [ ] 对账口径窗口：取哪一天的业务数据做同输入比对（建议取当日静态快照，避免活写入漂移）

## 二、执行步骤（环境到位后逐条跑，预计半天内出全量差异报告）

1. **起目标侧**：本仓 16 模块 server + 活库 PG（复用 `smoke:live-db` 容器范式），导入与快照同口径的种子数据
2. **录制参照侧**：`pnpm reconcile:record`（testkit record CLI）以 36 场景包的 input 载荷打活系统，回填各夹具 `reference`（脱敏默认开；recordedAt/max-age 门禁自动生效）
3. **双跑比对**：`pnpm reconcile`（run CLI）——同载荷打目标侧，逐场景 diff（compare 规则已冻结：id/provenance 忽略、时间戳 60s 容差、无策略=全精确）
4. **差异报告**：harness 输出字段级 diff（精确到路径）；汇总为三档——**等价通过 / 口径差异（数值可解释）/ 行为不等价（须修）**
5. **处置**：行为不等价项 → 按模块派 code-writer-pro 修复（合同 §7 对账要点即验收标准）→ 复跑至全绿；口径差异 → 登记裁定（部分属合同明示"对账阶段校正"的初版口径）

## 三、附：R7 待补内容模板（Owner 贴 9 项即填）

每项一行：`序号 | 模块归属建议 | 功能说明 | 标准/可选/定制判定建议`——贴入后总控跑映射升版 m2-drafts v1.2。

## 四、相关坐标

- 合同纪律 3（对账按行为等价）：`/Users/yeemio/AI/project/S-mes/HANDOFF-重构交接V1.0.md` §5
- 各模块对账要点：`architecture/contracts/m2-drafts/0*.md` §7（36 场景即由此录制）
- RunKit 账本：`/Users/yeemio/AI/gitrep/cadence-runkit`（project status 对账）
