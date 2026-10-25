# deploy/migration —— 数据迁移工具骨架（M4 正式线 · 决策簿 M4 四件之"数据迁移工具"）

通用迁移机制：**源读取端口 → 字段映射引擎 → 目标写入端口 → dry-run 报告 → 迁移后对账衔接**。
源系统具体 schema（表/列/字段口径）是**运行时配置**，不进代码——换一个源系统零代码改动。

决策簿 M4 定义"数据迁移工具+并行运行+切流（活工厂标杆先行）"——本目录只做**工具骨架**
（通用机制 + 两个主数据 dataset 证明闭环）；并行运行与切流不在本线。

## 清洁室边界（ADR-0002，先读）

- **数据迁移照常**（ADR-0002 #4：数据归雇主，迁移数据 ≠ 复制实现）——本工具的合法性基础。
- **73 份雇主开发文档禁用为生成输入**（ADR-0002 #2 重申）：本工具的一切形状（端口/配置
  格式/转换语义）来自本仓独立设计与通用工程惯例，未参照源系统实现细节；review 时凡疑似
  源自现系统的命名/结构按违规处理。
- 源 schema（列名、类型口径、业务键）只出现在 `source-descriptor.json` / `mapping.json`
  两个运行时配置文件里——接入真实源系统时**调研产物进配置，不进代码**。
- 词汇纪律（ADR-0010）：migration / mapping / dataset / transform / source / target /
  upsert / business key 均为跨行业通用词；示例数据用通用离散制造词（物品/资源/工作站），
  不绑定具体行业。

## 零依赖取舍（合同）

deploy/ 不在 pnpm workspace（无 package.json，避免 deploy 变成包）：

- **零新依赖**：MySQL 等真实源连接器属**接入期**（需活系统访问 + 源 schema 调研 +
  依赖决策，届时以 workspace 包或 server 脚本形态接入）。当前源读取器：CSV（node 内置
  fs + 手写 RFC 4180 子集流式状态机——node 无内置 CSV 解析器，手写优于引依赖）与
  JSON Lines（readline + JSON.parse，零手写）。
- **不 import @smes/business-store**：目标端口保持零依赖形状；主数据适配器
  （`src/masterdata-target.mjs`）用鸭子类型对齐 business-store 的 ItemStore/ResourceStore
  端口子集，真实连接由接入期组合（文件头有完整调用示例）。
- **对账衔接引 testkit 编译产物子模块**（`packages/testkit/dist/{harness,fixtures/load,...}.js`），
  不引其包入口 `dist/index.js`——入口再导出的 baseline-fixtures 运行时依赖
  `@smes/application`，workspace 外无法解析。用前先 `pnpm --filter @smes/testkit build`。
- **单测用 node:test**（node 内置，零依赖）：`node --test deploy/migration/tests/*.test.mjs`。
  deploy 无 vitest/tsconfig——.mjs + JSDoc，无编译步。

## 目录

```
deploy/migration/
  cli.mjs                    # CLI 入口（--source/--mapping/--target/--mode/--export-fixtures）
  src/
    source-port.mjs          # MigrationSource 端口合同（鸭子形状 + 错误形态）
    source-descriptor.mjs    # 源描述符加载校验 + DirectoryMigrationSource（目录组合源）
    csv-source.mjs           # CsvFileSource（手写流式 CSV 状态机）
    jsonl-source.mjs         # JsonLinesSource
    mapping-engine.mjs       # 映射引擎（纯函数：编译期校验 + 行变换 + 统计）
    target-port.mjs          # MigrationTarget 端口合同（upsert by 业务键）
    memory-target.mjs        # InMemoryTarget（测试/示例）+ DryRunTarget
    masterdata-target.mjs    # 主数据目标适配器形状（鸭子对齐 business-store 端口）
    pipeline.mjs             # 编排：源×映射×目标 → 报告（report/strict 双模式）
    report.mjs               # 文本报告渲染 + exit 码
    fixture-export.mjs       # 迁移结果 → smes.reconcile-fixture@1 夹具导出器
  examples/
    source/                  # 示例源（items.csv + resources.jsonl + 描述符 + 映射）
    expected/                # 源侧期望（迁移应达成的目标状态）
    run-reconcile-example.mjs# 对账衔接全流程示例（一条命令）
  tests/                     # node:test 单测
```

## 运行

```bash
# dry-run（只算不写）
node deploy/migration/cli.mjs \
  --source deploy/migration/examples/source \
  --mapping deploy/migration/examples/source/mapping.json \
  --target dry-run

# 内存目标 + 代理键模拟 + 导出对账夹具
node deploy/migration/cli.mjs --source deploy/migration/examples/source \
  --mapping deploy/migration/examples/source/mapping.json \
  --target memory --generate-ids --export-fixtures /tmp/mig-fixtures

# 迁移后对账全流程示例（源→映射→memory→导出夹具→ReconcileHarness 比对 PASS）
# （需 testkit 已构建：pnpm --filter @smes/testkit build）
node deploy/migration/examples/run-reconcile-example.mjs

# 单测
node --test deploy/migration/tests/*.test.mjs
```

**exit 码**：`0` 全部行成功；`1` 有行失败（report 收集到的失败 ≥1，或 strict 首错中止）；
`2` 配置/环境错误（源描述符/映射文件/缺列——迁移零行前 fail-fast）。

**双模式**：`--mode report`（缺省）行失败收集明细、整批继续——探查性迁移/首轮体检；
`--mode strict` 首错即停——切换前门禁跑法。行失败含三类：读取错误（坏 JSON/字段数不齐）、
映射错误（必填空/类型转换失败）、目标写入错误（连接/约束）——同一双模式语义。

## 配置文件形状

**源描述符** `source-descriptor.json`（放源目录；dataset 清单与列元数据）：

```json
{ "format": "smes.migration-source@1",
  "datasets": [ { "name": "items", "file": "items.csv", "format": "csv",
                  "columns": [ { "name": "code" }, { "name": "price", "type": "number" } ] } ] }
```

**映射文件**（源列→目标字段；`smes.migration-mapping@1`）：

```json
{ "format": "smes.migration-mapping@1",
  "datasets": { "items": {
    "businessKey": ["code"],
    "fields": [
      { "to": "tenant", "constant": "tenant-alpha" },
      { "to": "code",  "from": "code",  "type": "string",  "required": true },
      { "to": "name",  "from": "label", "type": "string",  "required": true },
      { "to": "unit",  "from": "uom",   "type": "string",  "default": "件" },
      { "to": "price", "from": "price", "type": "number" },
      { "to": "active","from": "enabled", "type": "boolean", "default": true },
      { "to": "listedAt", "from": "listed", "type": "date" } ] } } }
```

规则语义、类型转换词表、空值路径（缺失/null/纯空白 → 必填拒 / 默认 / null）见
`src/mapping-engine.mjs` 文件头——那是权威口径。缺列引用、业务键不在 to 集、
from/constant 并存等配置错误全部**编译期 fail-fast**（exit 2，不读任何行）。

## 迁移后对账衔接（testkit）

迁移产出导出为 `smes.reconcile-fixture@1` 夹具（`src/fixture-export.mjs`）后，
用 packages/testkit 的 ReconcileHarness 与**源侧期望**深度比对：

- 期望侧：源快照经人工核对的目标状态（`examples/expected/*.expected.json`），同一导出器转夹具；
- 实际侧：迁移 memory target 快照导出的夹具（接入期把 TargetAdapter 换成 testkit 的
  NodeFetchTargetAdapter 指向真实 server `GET /masterdata/<dataset>` 即比对活系统）；
- 策略自动生成：业务键无序配对（行序无关）+ 目标生成字段（id）shape 断言
  （期望侧可省略——脱敏语义与 testkit comparator 一致）。

全流程见 `examples/run-reconcile-example.mjs`（CSV 源 → 映射 → memory → 导出 →
harness 比对 PASS，含 upsert 期望态覆盖与代理键保留语义）。

## 接入期步骤（写明，非本骨架范围）

1. **真实 MySQL 源连接器**：实现 MigrationSource 端口（`readRows(dataset)` 流式游标迭代），
   列元数据来自源描述符；连接器形态（workspace 包/server 一次性脚本）与依赖选择
   （驱动库）届时定夺——端口形状已冻结，实现不反向影响本骨架。
2. **主数据目标组合**：按 `src/masterdata-target.mjs` 文件头示例，用
   `connectMasterdataStore()` + `TenantId.create` 组合真实 PG 目标；RLS 形态
   （`SMES_RLS_SESSION=on` 时后台迁移进程需 `runWithRlsTenant` 包裹或 superuser 跑批）
   届时定夺（deploy/README 威胁模型节）。
3. **源 schema 调研产物进配置**（两个 JSON），不进代码；调研过程遵守 ADR-0002 #2
   （字段口径从行为需求重述，不从源实现文档抄）。
4. **对账面换活系统**：TargetAdapter 换 NodeFetchTargetAdapter；期望侧夹具从源快照录制。
5. 已知优化项：主数据 upsert 判重走 list 全量（O(n)/行）——接入期给端口补
   findByCode 或批量 upsert；CSV 逐字符状态机大表性能；并行运行/切流（决策簿 M4 另两件）。

## 已知边界

- 只支持平面对象行（无嵌套取值路径）；JSONL 顶层值必须标量。
- date 转换拒收 epoch 数字（语义含混，接入期显式约定）。
- 单进程顺序迁移；断点续传/分批事务属接入期。
- InMemoryTarget 的代理键模拟（uuid）只为对账示例的目标生成字段形状；真实 id 策略
  在 business-store（uuidv7）。
