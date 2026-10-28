# 最终分段验证

候选：`39fc159969198fc15104bfd224d8b2604d84cbc524e881c1241e2cfe8bc435e8`，基础 `0fbaff32d4625869417f37e8d0f8d18fd38649f0`。首交阶段的夹具修正未改运行源码；当前三项返工运行源码由末尾REWORK1检查更新覆盖，各日志保留真实退出码，未把失败日志写成通过。

| 段 | 原始记录 | 结果 / 覆盖 |
|---|---|---|
| 稳定运行源码 build | evidence/pnpm-verify-final.log | pnpm verify 的 build 阶段全过；其后 typecheck 因新增测试遗漏过滤字段 EXIT2，原命令整体失败。 |
| 全workspace typecheck | evidence/final-typecheck.log | EXIT0；补齐4个必需undefined过滤字段后运行。 |
| boundary / selftest | evidence/final-boundary.log / final-boundary-selftest.log | 各EXIT0。 |
| 首段 pnpm test | evidence/final-tests.log | EXIT1，仅business-store两处旧107表数失败；其它13包全部绿，application734、web246+14既有skip；完整包清单见final-test-resume-plan.json。 |
| business-store受影响2文件 | evidence/final-resume-store-two.log | EXIT0，78/78；保留其它24文件143项有效结果。显式断言108表、WorkOrderEquipmentRecord及tenant_id RLS，不改动态自洽计数。 |
| 原未运行server层 | evidence/final-resume-server.log | EXIT1，243通过、5夹具失败；分别缺真实设备/合法主数据/人为发料中前置被指派同步重算，原件保留。 |
| 只补5条受影响server用例 | evidence/final-fixture-five-fixtures.log | EXIT0，5/5；其它38条为本次-t过滤跳过，先前243项有效结果复用。原齐套拒因、库存/跨租户守恒、撤销闸门、任务ID和warn断言均保留；cancel前新增issuing读回。 |
| 编辑过的测试typecheck | evidence/final-fixture-edited-tests-typecheck.log | server/business-store各EXIT0。 |
| 原未运行testkit层 | evidence/final-fixture-testkit.log | EXIT0，77/77。 |

这是一次全链命令失败后按主控裁定分段补齐，**不是 pnpm verify 单次 EXIT0**。最终所有适用 build/typecheck/boundary/selftest/test 层均有覆盖；不重复已绿包和业务全链。testkit本来排除e2e；容器auth:e2e/org:e2e和生产发布未运行，本轮未授权切换常驻栈。

实现期已有针对性结果继续复用：物料/质检46通过；设备legacy两条形状兼容通过；RLS静态7通过；恢复键5轮锚/长度/幂等测试通过。早期全verify口径字面断言失败已在本轮application734通过覆盖修复。最终日志对应同工作区候选，完整命令/时间/退出码见 final-checks.result.json、final-resume-checks.result.json、final-fixture-checks.result.json。

## REWORK1差量检查（当前候选）

前述首交日志保持原退出码，受本次三根因影响的覆盖由以下段更新，其它可信证据复用；未宣称重新全pnpm verify EXIT0。

| 段 | 原始记录 | 结果 |
|---|---|---|
| application/web/server typecheck（均noEmit） | evidence/rework1/typecheck.log / typecheck.result.json | EXIT0 |
| application listing+issue两个源测试文件 | evidence/rework1/application.log | 73/73，EXIT0 |
| web可选设备载荷接缝 | evidence/rework1/web.log | 4/4，EXIT0 |
| 受影响application/server/web构建 | evidence/rework1/build.log | EXIT0 |
| server共享池完整组+既有u-wave/cleanup | evidence/rework1/server.log | 17/17，EXIT0 |
| 本轮隔离运行读回 | evidence/rework1/health.http / modules.http / equipment-after-restart.http | 200 / 30模块 / 真实PG设备持久化 |

测试场景详见DELIVERY返工段。没有新的失败日志；原REWORK-PROBES为上一候选失败原件。多进程并发封顶不在本次保证内，明确风险不能被本次绿测试覆盖。
