# @smes/testkit —— 对账测试工具

ADR-0002 #3（行为等价）的机器化身：新系统与参考系统**同输入同输出**黑盒比对，
不从任何一侧代码导出逻辑。这是 M2 九模块施工时"规格 → 实现 → 对账测试"三步里的
对账腿，也是施工与对账工具（决策簿 ~10 人日）的落点。

零运行时依赖（node 内置 fetch）；本包不受依赖铁律限制（.dep-cruiser.cjs 注明）。

## 组成

```
src/
  comparator/   Comparator（纯函数）：字段级深度比对 + diff 精确到路径
  fixtures/     夹具格式 v1（*.reconcile.json）+ fail-fast 校验 + 加载器
  adapters/     NodeFetchTargetAdapter（HTTP 目标）/ StaticFixtureSource（静态参考）
  harness.ts    ReconcileHarness：场景 → 目标 → 参考 → 比对 → 报告
  record.ts     录制核心：把目标真实响应写回夹具 reference（含时间戳与脱敏）
  report.ts     文本报告（每场景 pass/fail + diff 明细 + 汇总）
  cli/          run.ts（reconcile）/ record.ts（reconcile:record）
fixtures/       示例夹具（对 apps/server 现有真实端点）
```

三个可插拔端口：`TargetAdapter`（被测系统，默认 HTTP）、`ReferenceSource`
（参考输出，默认读静态夹具；**M2 施工期可插入活系统适配器**——从旧系统取同输入
的真实输出，端口已留，连接实现需活系统访问权限，届时另立）、`Comparator`。

## 快速上手（本地）

```bash
# 1) 起被测系统（示例夹具面：apps/server + postgres + 种子）
docker run -d --name cadence-reconcile-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=cadence postgres:16
pnpm --filter @smes/business-store exec prisma migrate deploy --schema prisma/schema.prisma
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cadence \
  pnpm --filter @smes/business-store run db:seed
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cadence SMES_DEV_AUTH=on \
  pnpm --filter @smes/server run dev        # 默认 :3000

# 2) 录制（首次或参考过期时）：从运行中的 server 生成/刷新 reference
pnpm reconcile:record --target-base-url http://localhost:3000

# 3) 对账：全部夹具 → 报告 → 有 fail 退出码非零
pnpm reconcile --target-base-url http://localhost:3000
```

说明：

- 示例夹具 `workbench-summary` 用 dev 头身份（`x-smes-user: user-seed-admin`），
  需要 server 以 `SMES_DEV_AUTH=on` 启动（既有 e2e/boot 测试同款通道，生产默认关）。
- 录制会**执行真实请求**（含 POST 等变更请求）；录制默认把 `compare.ignore` 与
  `compare.shape` 命中的路径从写入值中删除（随机值/敏感值不落仓），`--keep-values` 关闭。
- 夹具的 reference 带录制时间戳与来源（`recordedAt` / `recordedFrom`）；
  `pnpm reconcile --max-age-days 30` 可拒绝过期参考（退出码非零）。
- 工作区脏状态（如 dev 库里多了待办）会让 `workbench-summary` 合理地报 diff——
  这是对账工具的本义：把行为差异暴露成字段级证据。

## 夹具格式（一个 `*.reconcile.json` = 一个场景）

```jsonc
{
  "format": "smes.reconcile-fixture@1",
  "scenario": {
    "name": "auth-login",                    // 场景名全局唯一
    "input": {                               // 同一份输入喂目标与参考源
      "method": "POST", "path": "/auth/login",
      "body": { "username": "admin", "password": "demo-password" }
    }
  },
  "reference": {                             // 参考输出；null = 待录制
    "status": 200,
    "body": { "token": "…", "admin": true },
    "recordedAt": "2026-10-25T08:00:00.000Z",
    "recordedFrom": "http://localhost:3000"
  },
  "compare": {                               // 比对策略（可省略 = 全精确）
    "tolerance": { "numeric": { "relative": 0.001, "absolute": 0.5 } },
    "ignore": ["token"],
    "shape": { "token": "string", "expiresAt": "string" },
    "arrays": { "bySource": { "match": "unordered", "key": "source" } },
    "timestamps": { "toleranceMs": 60000 }
  }
}
```

坏夹具（非法 JSON / 未知键 / 非法值 / 场景重名）在加载期 fail-fast，报文件路径
与原因——绝不让格式错误的夹具把失败伪装成行为差异。

### 比对语义（默认与显式策略）

| 项 | 默认 | 显式策略 |
|---|---|---|
| 数值 | 精确相等 | `tolerance.numeric`：|实际-期望| <= `absolute` 或 <= `relative`*|期望|（相对容差锚定期望值） |
| 字符串 | 精确相等 | ISO-8601 串 + `timestamps.toleranceMs`：按时刻差比较（`Z`/`+00:00` 表示差异归一） |
| 数组 | 按索引有序比较 | `arrays.<路径>`：`unordered` + `key` 按 key 字段配对；无 key 按元素值多集合匹配 |
| 字段 | 键全集比对（缺失/多出都报） | `ignore`：路径模式命中即整体跳过；`shape`：只断言实际值类型（随机值"只比形状"） |
| 状态码 | 精确相等 | —（`status` 恒精确） |

路径模式 glob 子集：`*` 段内通配（不含 `.`）、`[n]` 精确索引、`[*]` 任意索引、
`**` 任意长度段。diff 输出精确到路径：`a.b[2].c: 期望 5 实际 6（…）`。

## M2 九模块施工时的对账工作流

每个模块每个用例三步，对账腿全程用本工具：

1. **写夹具**：按领域规格定义场景输入与比对策略（reference 置 `null`）。
   策略里只放"规格允许的自由度"（时间戳容差、无序数组、随机值形状），
   其余一律精确——对账是规格的执行面，不是橡皮图章。
2. **录参考**：
   - 当前（M1 形态）：`pnpm reconcile:record` 从运行中的新系统录制（自我一致基线，
     用于回归对账：改动后行为不得漂移）；
   - M2 施工期（活系统对账）：实现一个 `ReferenceSource` 适配器调旧系统同一输入，
     录出的 reference 即"行为等价"的基线（需活系统访问权限，届时另立任务）。
3. **跑对账**：`pnpm reconcile`（本地 + CI 门禁）。失败时 diff 即字段级证据，
   回到规格澄清口径（清洁室：字段缺口用"行为需求重述 + 对账测试反推"补齐，
   不从原实现抄）。

### CI 门禁

`.github/workflows/ci.yml` 的 `reconcile` job：postgres:16 service → 迁移 + 种子 →
起 server（`SMES_DEV_AUTH=on`）→ `pnpm reconcile`。独立于 `verify` job 并行
（docker services 是 job 级资源，不把 DB 成本强加给每次 verify），**不静默跳过**。

## 包内命令

```bash
pnpm --filter @smes/testkit typecheck   # tsc -p tsconfig.json
pnpm --filter @smes/testkit build       # tsc -p tsconfig.build.json → dist/
pnpm --filter @smes/testkit test        # vitest（Comparator 全语义 / 夹具校验 / Harness 全流程 / 录制）
pnpm --filter @smes/testkit run reconcile --help
pnpm --filter @smes/testkit run reconcile:record --help
```
