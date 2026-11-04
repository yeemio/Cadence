# PR #4 — F5 修复候选

作者：本普通 Chat。2026-11-03。父提交
`358d7dfa625f5ff6e4c5508dd0ae7363cc78e970`；审查基线
`5425feb93856772c728ffb482b18bced5eb88558`。本文件所在提交为本 PR 候选，
准确 commit/tree/逐文件 SHA256 由冻结回执提供。没有依赖另一未验证 PR。

## 修复机制与 changed paths

- `packages/application/src/manufacturing/manufacturing-guard.ts`：生产守门增加转单目标
  `operationCode`，按既有输入规则 trim 后与当前批准排程 `processCode` 比较。
  不匹配即在 dispatch 命令调用前拒绝，原有人员、设备、工装、资质、故障及冻结检查继续执行。
  不新增执行中重排程批准模型；不能通过转单把已批准 A 工序改成 B。
- `apps/server/tests/manufacturing-transfer.test.ts`：真实 Nest 组合根、dispatch/reporting
  服务及跨模块接线；真实 ManufacturingTransactionInterceptor、guard 和排程检查，
  使用隔离内存源。三种非法目标拒绝后派工、排程、事件不变且原路径仍能报工；
  同一批准工序转回批准人员后仍能报工。
- `docs/user-manual/controlled-workflows.md`：明确受控转单边界。
- 本目录 `TASK.md`、`DELIVERY.md`：批次授权与交付记录。

## 实际检查

Node v24.22.1。以下 `pnpm` 实际前缀为
`npm exec --yes --package=pnpm@11.28.5 -- pnpm`，lockfile 未改。

| 命令 | 退出码 | 实际结果 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | 独立 checkout 安装完成 |
| `pnpm build` | 0 | workspace 构建通过 |
| `pnpm --filter @smes/server exec vitest run tests/manufacturing-transfer.test.ts --reporter=verbose` | 0 | 4 passed；最终测试使用完整 quality/control 构造参数 |
| `pnpm --filter @smes/application exec vitest run tests/dispatch tests/reporting --reporter=dot` | 0 | 3 files / 90 passed |
| `pnpm verify` | **1** | build/typecheck/boundary/boundary:selftest 完成；全仓 test 在既有 web i18n 失败停止 |
| `git diff --check` | 0 | 无空白错误 |

日志原件：`pr4-transfer-tests-final.log`、`pr4-app-tests.log`、`pr4-verify-final.log`，
前次日志保留。工程检查失败为：

```text
FAIL tests/i18n.test.ts:163:41
AssertionError: expected 'manufacturing-control' to be '制造控制台'
Test Files  1 failed | 24 passed | 2 skipped (27)
Tests  1 failed | 250 passed | 14 skipped (265)
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL; Exit status 1
```

该前端失败已由总控在 PR #1 准确父提交独立复现；本 PR 未改前端 i18n。
没有把全仓检查报为通过，没有重跑历史 19 项流程。

## 未验与发布

上述组合测试直接调用真实拦截器/服务，不是经过网络的 HTTP 浏览器测试；
内存 transaction 测试桩不证明真实 PG 回滚或锁行为，本修复依靠调用前拒绝阻止写入。
未跑真实 PG、共享环境、客户样本、负载测试。原 M2 接受、真实样本未验边界保持。

GitHub 集成此前返回 403 `Resource not accessible by integration`，未重试。
状态为 `BLOCKED_DELIVERY_PUBLICATION`，由总控按既有授权机械发布本候选至
`codex/chat-review-manufacturing-transfer-20261103`。未写 main、merge 或部署。
