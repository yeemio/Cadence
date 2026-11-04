# PR #2 — F2 / F3 修复候选

作者：本普通 Chat。日期：2026-11-03（Asia/Shanghai）。父提交
`ca17634be32454138726a6ed2bb03899e9c37822`；审查基线
`5425feb93856772c728ffb482b18bced5eb88558`。本文件所在提交为本 PR 候选，
准确 commit/tree/逐文件哈希由同一 Chat 的冻结分片回执提供。各 PR 独立验证。

发布方式：GitHub 集成此前创建 tree 和评论均返回 403
`Resource not accessible by integration`，不再重试。由总控按已有授权机械发布
原分支 `codex/chat-review-identity-lifecycle-20261103`；本地提交不冒称远端 head。

## 修复与范围

- F2：刷新时的先读、撤销、创建分离，可能在重置密码已撤销会话后再创建替代会话。
  新 `SessionStore.rotate` 原子消费仍有效的原会话并写入替代会话；原续期绝对上限不延长。
  PostgreSQL 的 rotate 与 revokeAllForUser 使用同一租户/用户 advisory transaction lock；
  条件 UPDATE 与替代 INSERT 同事务。插入失败回滚原会话消费。同 token 并发最多一次成功。
  内存适配器在无 await 的同步临界区完成相同转换。登录、8h 访问/7d 续期窗口保持。
- F3：标准 seed 只在 default 租户 users/policies 都为空时同事务创建初始身份和授权，
  并用 bootstrap advisory lock 串行化并发初始化。任何既有用户或策略存在即跳过整组身份引导；
  不补回客户删除的 grant 或默认账号、不覆盖密码、不重新启用停用账号。默认仓仍独立幂等。
  旧库部分初始化状态不会自动提权补齐，交管理员按真实状态处理。清空身份表不是标准升级。
- 没有 schema、迁移、Compose 或权限模型变化；没有启动 O5 或操作共享/客户数据。

## Changed paths

- `packages/application/src/auth/auth.service.ts`、`session-stores.ts`：刷新原子端口及调用。
- `packages/business-store/src/org/pg-org-stores.ts`：轮换/全用户撤销的共同锁和事务。
- `packages/business-store/prisma/seed.mjs`、`seed.d.mts`：首次引导及声明同步；声明是 seed
  现有 TypeScript 调用者的必要接口，不新增能力。
- `packages/application/tests/auth-rotation.test.ts`：受控交错、并发、窗口/租户约束。
- `packages/business-store/tests/seed.test.ts`、`identity-lifecycle.pg.test.ts`：升级权限保全、
  初始化失败回滚及可显式启用的隔离 PostgreSQL 验证。
- `deploy/README.md`：首次安装与升级行为说明。本目录 TASK/DELIVERY：授权与交付记录。

## 实际检查

Node v24.22.1；以下 `pnpm` 的实际调用前缀为
`npm exec --yes --package=pnpm@11.28.5 -- pnpm`。独立 checkout 安装，lockfile 未改。

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | 安装完成；首次 offline 尝试缺元数据失败，随后正常在线安装成功 |
| `pnpm build` | 0 | 全 workspace 构建通过 |
| `pnpm typecheck` | 0 | 修正测试桩/seed 声明后全 workspace 通过 |
| `pnpm --filter @smes/application exec vitest run tests/auth.test.ts tests/auth-rotation.test.ts tests/org.test.ts tests/org-password-policy.test.ts --reporter=dot` | 0 | 4 files / 54 passed |
| `pnpm --filter @smes/business-store exec vitest run tests/seed.test.ts tests/identity-lifecycle.pg.test.ts tests/rls-session.test.ts tests/rls-session-wiring.test.ts --reporter=dot` | 0 | 3 files passed、1 skipped；25 passed、4 skipped（真实 PG） |
| `pnpm --filter @smes/business-store run typecheck` | 0 | 最终 store 源码/测试检查通过 |
| `pnpm verify` | **1** | build/typecheck/boundary/boundary:selftest 完成；test 在既有 web i18n 断言失败停止 |
| `git diff --check` | 0 | 无空白错误 |

保存日志：`pr2-auth-tests.log`、`pr2-store-tests-final.log`、`pr2-typecheck-final.log`、
`pr2-store-typecheck.log`、`pr2-verify.log`；旧失败日志另保留，没有覆盖成通过。
中途 store 测试曾因可选 PG 文件额外导入不可解析的 reflect-metadata 失败，移除多余导入后
上述最终组合检查通过；没有将失败那次报为通过。

工程总检查失败原文摘要（完整原件仍保留）：

```text
FAIL tests/i18n.test.ts:163:41
AssertionError: expected 'manufacturing-control' to be '制造控制台'
Expected: "制造控制台"
Received: "manufacturing-control"
Test Files  1 failed | 24 passed | 2 skipped (27)
Tests  1 failed | 250 passed | 14 skipped (265)
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL; Exit status 1
```

同一前端失败已在基线相同的前端路径单独复现（13 passed / 1 failed）；总控随后又在
PR #1 准确父提交独立复现。本 PR 不改 i18n，不声称全仓 verify 通过。

## 未运行的真实 PG 检查

未提供隔离 PG；环境也没有 postgres/initdb，切换非 root 的 `runuser -u nobody -- id`
返回 `cannot set groups: Operation not permitted`。未绕过环境限制，未连接任何隐含
DATABASE_URL。四项 PG 测试当前明确 SKIPPED，不能作为真实数据库并发/回滚通过。

总控可在仅迁移、未 seed 的一次性 loopback 数据库 `cadence_pr2_test` 执行：

```bash
DATABASE_URL="$CADENCE_IDENTITY_TEST_DATABASE_URL" pnpm --filter @smes/business-store exec prisma migrate deploy --schema prisma/schema.prisma
pnpm --filter @smes/business-store exec vitest run tests/identity-lifecycle.pg.test.ts --reporter=verbose
```

先显式设置 `CADENCE_IDENTITY_TEST_DATABASE_URL` 为该隔离库连接串。测试硬性检查 loopback
及库名，预期 4/4：首次引导/撤权保全、同 token 并发、重置先完成的受控交错、插入失败回滚。
这不是客户升级演练、HTTP 浏览器验收或负载测试。原 M2 接受及真实样本未验边界保留。
