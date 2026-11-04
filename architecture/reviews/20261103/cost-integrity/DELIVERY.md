# PR #5 — F6 / F7 修复候选

作者：本普通 Chat。2026-11-03。父提交
`7b7b424ab8093983759ade0d1386de7b3ab77192`；审查基线
`5425feb93856772c728ffb482b18bced5eb88558`。本文件所在提交为本 PR 候选，
准确 commit/tree/逐文件 SHA256 由冻结回执提供。没有把其它 PR 的运行结果算入本 PR。

## 修复机制

F6：设备采购必须匹配本工作令 equipment 清单。未匹配采购保留原始来源事实，
但不能新建设备成本。若已存在错误设备贡献，显式 project rebuild 追加净额归零 delta，
记录采购订单/行、工作令、匹配结果、已收量、单价、观察金额作为分类依据；
不删除或覆写旧成本行和旧快照。重复重建不重复归零。存在采购行但装配缺少分类端口时
明确失败，不能把来源缺失静默解释成零设备成本。

F7：两套成本命令的 operation/source claim、明细、快照、事件共同提交或回滚。
返回 rejected/indeterminate 也触发事务回滚；事件失败可使用同一 operationId 重试。
source claim 已存在而明细缺失时检查实际明细并允许补齐，避免旧孤儿占位永久缺账；
新插入冲突不吞掉后继续生成缺事实快照。

内存存储提供 checkpoint，按共享 operation store 串行执行两套成本并在失败后恢复。
外部适配器没有真实 transaction 时明确报错。PG 装配在现有租户 ALS 事务内取得租户成本
advisory lock，沿用原 RLS 传播使独立 project-cost 客户端、共享账本和事件参加同一事务。
claim 用 `createMany(skipDuplicates)`，避免捕获唯一键异常后继续使用已 aborted 的 PG 事务。
没有修改全局 RLS 实现、schema、迁移或 Compose。

## Changed paths 与因果

- `apps/server/src/cross-module-wiring.ts`：设备来源分类缺失显式失败。
- `apps/server/src/app-registry.ts`、`main.ts`：传入真实 PG transaction。
- `packages/application/src/costing/costing-transaction.ts`：事务协议、内存回滚及非提交结果回滚。
- 同目录 `costing.module.ts`、`costing.service.ts`、`project-cost.service.ts`：装配/命令原子性、
  孤儿 claim 恢复、分类追加修正。
- 同目录 `in-memory-costing-stores.ts`、`in-memory-project-cost-stores.ts`：内存 checkpoint。
- 同目录 `project-cost-ports.ts`：明确 null 分类语义；来源金额不被篡改。
- `packages/application/src/index.ts`：导出 transaction 类型供现有组合根和存储适配器使用，
  是同模块新端口通过公共边界装配的必要路径。
- `packages/business-store/src/costing/pg-costing-stores.ts`：真实事务/锁及非异常 claim。
- `packages/application/tests/costing/rebuild-atomicity.test.ts`：两服务的 claim/entry/event
  受控失败、同操作重试、旧孤儿 claim 修复与并发。
- `apps/server/tests/u7-cost-wiring.test.ts`：混合非零来源、既有错误行追加纠正、缺分类拒绝。
- `packages/business-store/tests/cost-rebuild-atomicity.pg.test.ts`：可显式启用的四项真实 PG 验证。
- 本目录 TASK/DELIVERY：授权与交付记录。

## 实际检查

Node v24.22.1；`pnpm` 实际调用前缀为
`npm exec --yes --package=pnpm@11.28.5 -- pnpm`，各 PR 独立 checkout，lockfile 未改。

| 命令 | 退出码 | 实际结果 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | 安装完成 |
| `pnpm build` | 0 | workspace 构建通过 |
| `pnpm --filter @smes/application exec vitest run tests/costing --reporter=dot` | 0 | 3 files / 36 passed |
| `pnpm --filter @smes/server exec vitest run tests/u7-cost-wiring.test.ts --reporter=dot` | 0 | 1 file / 9 passed |
| `pnpm --filter @smes/business-store exec vitest run tests/cost-rebuild-atomicity.pg.test.ts --reporter=verbose` | 0 | 4 skipped；未提供隔离 PG，不能计为通过 |
| `pnpm verify` | **1** | 最终 build/typecheck/boundary/boundary:selftest 完成；test 在既有 web i18n 断言失败停止 |
| `git diff --check` | 0 | 无空白错误 |

日志原件：`pr5-cost-tests.log`、`pr5-wiring-tests.log`、`pr5-pg-gate.log`、`pr5-verify.log`。
先前类型检查发现两套 entry store union 的测试桩签名不兼容，补类型桥接后最终总检查
typecheck 已通过；运行断言和生产逻辑没有为此改变。旧失败日志保留。

全仓检查失败尾文：

```text
FAIL tests/i18n.test.ts:163:41
AssertionError: expected 'manufacturing-control' to be '制造控制台'
Test Files  1 failed | 24 passed | 2 skipped (27)
Tests  1 failed | 250 passed | 14 skipped (265)
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL; Exit status 1
```

该前端失败已由总控在 PR #1 准确父提交独立复现；本 PR 不修改 i18n，不声称 verify 全绿。

## 未运行与补验命令

真实 PG 四项未运行。当前环境无可用 postgres/initdb，切换非 root 用户返回
`cannot set groups: Operation not permitted`；没有绕过限制或使用隐含 DATABASE_URL。
总控可显式设置 `CADENCE_COST_TEST_DATABASE_URL` 指向仅迁移的一次性 loopback 数据库
`cadence_pr5_test`，在仓库根执行：

```bash
DATABASE_URL="$CADENCE_COST_TEST_DATABASE_URL" pnpm --filter @smes/business-store exec prisma migrate deploy --schema prisma/schema.prisma
pnpm --filter @smes/business-store exec vitest run tests/cost-rebuild-atomicity.pg.test.ts --reporter=verbose
```

预期 4/4：classic/project 两服务分别在明细/事件处失败，旧事务无残留、同操作重试
恰好一次正确事实、重复操作拒绝。测试硬性限制 loopback/库名，每次新合成租户，不删除成本历史。
这组预期不是本 Chat 已观察的 PG 结果。

旧工程变更后的历史不变性接受继续有效；本次仅新增合成错误分类行的不可变/追加纠正证据。
没有真实客户历史或全部成本类别全面验证，没有对所有旧事件缺口自动回填。
旧命令幂等记录保留；旧孤儿 source claim 的修复通过新的显式重建命令完成。
内存回滚不宣称读隔离等同 PG；外部价格写回仍按原通知合同，不新增全链原子性保证。
未跑历史 19 项、共享环境或部署；原 M2 接受及真实样本未验保留。

## 发布

`BLOCKED_DELIVERY_PUBLICATION`：GitHub 集成已返回 403
`Resource not accessible by integration`，按 Owner 指令不重试。总控机械发布本 Chat
冻结候选到 `codex/chat-review-cost-integrity-20261103`；不写 main、merge 或部署。
