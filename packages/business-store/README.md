# @smes/business-store —— PostgreSQL 16 + Prisma 存储基座（M1 增量 2-A / 3-D / 4-I）

依据：`architecture/contracts/evidence-columns.v1.md`、ADR-0003 #5（append-only 账本）、
ADR-0005（双形态多租户）、ADR-0010（内核通用词汇）、ADR-0007（复用优先与许可证纪律）。

## 布局

```
prisma/schema.prisma        九表骨架：WorkOrderRecord（示例事实表）/ BusinessEventRecord（事件表）/ OutboxRecord
                            + 组织配置三表 UserRecord / RoleRecord / PolicyRecord（3-D）
                            + 基础数据/工作台三表 ItemRecord / ResourceRecord / TodoRecord（4-I）；
                            子路径导出 ./org ./masterdata ./workbench（主入口零 Prisma）
prisma/migrations/          Prisma 约定迁移（含手写 append-only 触发器等 DB 级防线）
prisma/seed.mjs             组织种子（管理员策略 + 演示身份授权；幂等，显式执行）
src/ids/uuidv7.ts           uuidv7 生成（uuid 包，MIT）
src/evidence/               证据公共列构造器（ISO↔Date 唯一换算点）+ WorkOrderRecord 构造
src/events/                 BusinessEvent↔行 映射、Outbox 行构造
src/append-only/            append-only 写门（应用层防线）
src/org/                    PolicyStore/UserStore/RoleStore 的 PG 实现（./org 子路径）
scripts/e2e-write-read.mjs  活库端到端验证（需 DATABASE_URL）
tests/                      全部不依赖活库/generate 的单测 + schema 一致性守恒
```

主入口 `src/index.ts` 不 import `@prisma/client`——纯数据面的 typecheck/test 不需要
prisma generate 或活库；`./org` 子路径（`connectBusinessStore` 等）引入 Prisma，
其 typecheck/build 脚本前置 `prisma generate`（离线、无需 DATABASE_URL）。
依赖注意：`src/org` 引用 `@smes/application` 的端口类型——本地测试/构建前
application 需先 build（pnpm 递归构建已按拓扑序处理）。

## 设计取舍

### 组织配置表（M1 增量 3-D）：users / roles / policies

- **append-only 不适用**：该纪律约束的是业务事实表（修正语义 = supersedes 链）；
  users/roles 是组织配置数据，修正就是改行，policies 是策略事实的当前集
  （期望态 set 语义，append/remove 幂等）——套证据公共列/触发器只会把配置
  管理做成不可能。schema 守恒测试钉死这三表**无** append-only 触发器。
- **policies.rule_key 自然主键**：规则规范键（与 application 内存实现的 Map 键
  同形状，`src/org/policy-mapping.ts` 钉死）作为幂等锚——append 走
  `createMany skipDuplicates`（主键冲突即跳过），remove 按键 `deleteMany`。
  取代"部分唯一索引 + NULL 语义"（PG 唯一索引视 NULL 互异，幂等会破）。
- **不设 users/roles 外键**：PolicyStore 端口合同的用户/角色是通用字符串 id
  （dev 策略钩子 / mock 身份可注入任意 id），组织管理端点在用例层校验存在性
  （404）。表结构不替端口收紧合同。
- **users.id 文本主键 + uuid(7) 兜底**：种子与演示身份用稳定非 uuid id
  （与 `x-smes-user` mock 身份头同形，如 `user-demo-admin`）；运行期创建走
  应用侧 uuidv7 权威生成。

### uuidv7 策略（PG 无内建 uuidv7）

- **应用侧权威生成**：`src/ids/uuidv7.ts`（uuid 包 v7，MIT）。id 的生成权在应用层，
  保证任何写入路径（仓储 / 导入 / 对账工具）得到同一时间有序形态。
- `@default(uuid(7))` 是 Prisma Client 侧兜底（漏传 id 时仍得 v7，不会静默落 v4）；
  PG 端无 DB 级 uuidv7 默认（无此内建函数，不为此引扩展）。
- 不选 PG 扩展（pg_uuidv7）：非官方源、私有化部署多一个系统依赖，收益仅是
  raw SQL 直插时的兜底——本仓纪律本来就要求经仓储写入。

### append-only 纪律（双层防线）

| 层 | 机制 | 防什么 |
|---|---|---|
| 应用层 | `asAppendOnly(delegate)` 写门：仓储拿到的 delegate 类型上没有 update/upsert/delete | 仓储代码写出更新语句（编译期红） |
| DB 层 | 迁移内触发器：`work_order_records` / `event_records` 的 UPDATE/DELETE 一律 RAISE | 绕过仓储的写入（raw SQL / 外部客户端） |

- 触发器 SQL 是 Prisma 无法表达的部分：用 `migrate dev --create-only` 生成基础 DDL
  后手写追加，再 apply（迁移文件即唯一事实源，Prisma 不 diff 触发器，无漂移告警）。
- **Outbox 豁免**：投递器必须能 UPDATE attempts/delivered_at——它是记账表不是事实表。
- 修正语义：不 UPDATE 行——新行 `objectVersion+1` + `supersedes` 指向前任；
  `@@unique([tenantId, supersedes])` 保证链线性（并发修正前者只有一个后继），
  复合自引用 FK `([supersedes, tenantId]) → ([id, tenantId])` 保证不跨租户挂链。

### 证据公共列复用（Prisma 无 mixin）

约定字段块在每个事实模型重复（schema 内注释标出），三重守恒：

1. `tests/schema-conformance.test.ts`：逐列校验类型/属性/映射（漂移即红）；
2. `src/evidence/evidence-columns.ts`：唯一构造入口（冻结、校验、ISO↔Date 换算）；
3. `EVIDENCE_FACT_MODELS` 清单：新增事实表加入清单即受同一校验。

不引共享基类抽象（Prisma 模型非继承体系）；YAML/JSON 复用块或代码生成在此规模
（M1 三表）不成比例——晚绑定，出现第 N 张事实表再评估。

### 多租户（ADR-0005）

- 全表 `tenant_id` 非空（schema 守恒测试覆盖）；RLS 策略 M4 落地，本增量不引。
- 入参形状品牌化：所有构造器收 `TenantId`（由 application 的 `TenantContext.current()`
  解析，租户身份从命令信封进，不依赖环境推断）。

### 其他口径

- `audit_status` = String：合法值集合由 M2 领域规格定义（合同纪律，不预设枚举）。
- 时间：领域/core 层 ISO 字符串，Prisma 层 Date（`@db.Timestamptz(6)`），
  `src/evidence/` 是唯一换算点。
- `eventId` 为事件表自然主键（幂等），不强制 uuid（EventId 品牌语义 = 1~128 字符串）；
  事实表 `id` / `workOrderId` / `supersedes` 强制 uuid。
- `aggregate` 三列扁平化（可索引），非 JSONB 整体存储。

## 命令

```bash
pnpm --filter @smes/business-store typecheck
pnpm --filter @smes/business-store test
pnpm --filter @smes/business-store prisma:validate
pnpm --filter @smes/business-store prisma:generate        # 生成 client（typecheck/build 已内置）
DATABASE_URL=postgres://... pnpm --filter @smes/business-store prisma:migrate
DATABASE_URL=postgres://... pnpm --filter @smes/business-store db:seed    # 组织种子（幂等）
DATABASE_URL=postgres://... pnpm --filter @smes/business-store db:e2e
```

`prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`
可离线产出 DDL 证据（无活库时）。

## 非目标（本增量）

RLS 策略（M4）；业务 CRUD 完整仓储；audit_status 枚举值（M2 领域规格）；
PrismaClient/NestJS 装配（组合根接入增量）。
