# PR #3 — F4 退货重收一致性修复候选

作者：本普通 Chat。2026-11-03。父提交
`5a887652a72eee95463e4b16eb02c444e3f2e966`；审查基线
`5425feb93856772c728ffb482b18bced5eb88558`。本文件所在提交为候选；准确
commit/tree/逐文件 SHA256 由冻结回执提供。本 PR 独立验证，不依赖其它 PR 修复。

## 修复机制

轻量退货只回退采购状态，不冲销已记库存、检验或质量批次。现在采购重收先核对所有
有效收货行：已收正数量不能改量；库存 preflight 比较来源键所绑定的物料、数量、
仓库/库位及来源标识。所有行通过才开始调用入库，避免前一行已写、后一行才发现
旧来源冲突。同一来源的相同请求继续返回原结果，不重复库存、质检或质量证据。
重放未指定仓库时沿用原落账仓，不跟随之后改变的默认仓。

库存真正写入入口也重复核对来源身份，不能靠绕过采购校验覆盖已有事实。
零数量已由原输入解析拒绝；没有为此次修复放开零数量或新增 RES/RTN、分批增量收货模型。
缺 inventory 模块时原 NOOP 装配边界保留；配置了库存但尚未接线则 preflight 明确拒绝。

## Changed paths

- `packages/application/src/listing/listing.service.ts`、`listing-ports.ts`：已收数量约束、
  整单预核对及 receipt preflight 端口。
- `packages/application/src/inventory/inventory.service.ts`、`inventory-ports.ts`：来源载荷
  一致性、原仓重放、服务适配。
- `apps/server/src/cross-module-wiring.ts`：真实 listing → inventory 预核对接线。
- `packages/application/tests/listing/listing.test.ts`：改量拒绝、同量通过、拒绝时零 receipt 调用。
- `apps/server/tests/purchase-receipt-consistency.test.ts`：真实 Nest listing/inventory/inspection
  服务与接线、真实质量服务、隔离内存源；覆盖首收 8 / 轻量退 3 / 改量 10、零、改仓、
  前行新增后行冲突、同载荷重放、直调库存更换物料/来源。
- `docs/user-manual/controlled-workflows.md`、`KNOWN-BEHAVIORS.md`：说明轻量退货和重收边界。
- 本目录 TASK/DELIVERY：批次授权与交付记录。

## 实际检查

Node v24.22.1。以下 `pnpm` 实际前缀为
`npm exec --yes --package=pnpm@11.28.5 -- pnpm`；lockfile 未改。

| 命令 | 退出码 | 实际结果 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | 独立 checkout 安装完成 |
| `pnpm build` | 0 | workspace 构建通过 |
| `pnpm --filter @smes/application exec vitest run tests/listing tests/inventory tests/inspection --reporter=dot` | 0 | 9 files / 187 passed |
| `pnpm --filter @smes/server exec vitest run tests/purchase-receipt-consistency.test.ts --reporter=verbose` | 0 | 1 file / 6 passed |
| `pnpm verify` | **1** | build/typecheck/boundary/boundary:selftest 完成；test 在既有 web i18n 失败停止 |
| `git diff --check` | 0 | 无空白错误 |

最终原件：`pr3-app-tests-final.log`、`pr3-composition-tests-r3.log`、`pr3-verify-final.log`。
旧失败原件保留：原 listing 假端口断言仍期待进入 receipt，改为预核对拒绝后零调用；
新增组合样本先因缺必填 promisedAt、随后因把未收行写为 receivedQty=0 而失败，
分别补交期和省略未收行，并对零数量按既有解析异常断言。没有改业务规则以迁就样本。

工程总检查真实失败尾文：

```text
FAIL tests/i18n.test.ts:163:41
AssertionError: expected 'manufacturing-control' to be '制造控制台'
Expected: "制造控制台"
Received: "manufacturing-control"
Test Files  1 failed | 24 passed | 2 skipped (27)
Tests  1 failed | 250 passed | 14 skipped (265)
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL; Exit status 1
```

该前端失败已由总控在 PR #1 准确父提交独立复现；本 PR 不改 i18n，未把总检查报为通过。

## 未验与限制

组合验证直接调用真实服务，不是网络 HTTP/浏览器测试。内存 transaction 桩不能证明
真实 PG 锁/回滚；所列冲突路径通过写入前预核对证明无副作用，后续存储失败或其它
并发场景仍依赖原制造事务边界。未跑真实 PG、共享环境、客户样本、完整制造批准链
或历史 19 项。原检验通知失败语义未扩改，未宣称补齐所有历史不一致记录。
原 M2 接受与真实样本未验保留。

## 发布

`BLOCKED_DELIVERY_PUBLICATION`：既有 GitHub 403
`Resource not accessible by integration` 未重试。由总控机械发布至原分支
`codex/chat-review-purchase-receipts-20261103`；不写 main、不 merge、不部署。
