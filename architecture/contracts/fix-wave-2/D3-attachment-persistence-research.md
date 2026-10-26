# D-3 附件内容持久化方案预研（只读研究，不落码）

冻结：2026-10-26｜执行：code-writer-pro（GLM-5.3，fix-wave-2 队列 D-3 预研）｜定位：为 fix-wave-4 W4-2 实施提供方案依据与拆步

纪律对齐：fix-wave-2 §0/§3——本预研零代码改动，唯一写入本文件；`packages/business-store/**`、`core/auth/**`、`noodle-test-output/**`、`architecture/requirements/**` 全程只读。读码基线 = 当前工作树（三线并行在途，attachment 域含 wave-2 的 D-4 租户绑定令牌改动）。

---

## 0. 缺陷复述与验收基线

- **缺陷**（grokbot saas 报告 D-3，P1）：附件字节存进程内存 store，`docker restart cadence-server-1` 后元数据行仍在库，`GET /attachment/download-reference` 返回 502：`对象存储内不存在目标 'memory' 的对象 'upload/2026/10/26/…-a.txt'`。
- **验收基线**（grokbot 复现命令反转即验收脚本）：上传附件 → `docker restart cadence-server-1` → 对同一附件 `download-reference` → **200** 且开门面字节与上传一致。双形态（single-node / saas）均须成立。

---

## 1. 现状读码（证据锚点）

### 1.1 application/src/attachment 域（字节与令牌面）

| 面 | 文件 | 事实 |
| --- | --- | --- |
| 端口 | `packages/application/src/attachment/attachment-ports.ts` | `ObjectStoragePort` 四方法：`currentTarget` / `put(tenant, {fileName, contentType, bytes})` / `issueReadReference(tenant, ref, {ttlSeconds, downloadName})` / `resolveReadReference(tenant, token)`。合同注释明示：**MinIO/S3 运行时依赖禁入，基础设施接入归部署期换装适配器，业务面不动**。`StoredObjectRef` 三字段 = `storageKind`（适配器自述串 'memory'/'local-fs'/未来 'pg'/'minio'）/ `target` / `objectKey`。 |
| 内存适配器 | `in-memory-object-storage.ts` | `Map<target\|objectKey, {bytes, contentType}>`，构造随机 HMAC 密钥——**重启即失（缺陷根因）**。`issueReadReference` 对缺失对象抛 `AttachmentStorageError` → 组合根异常过滤器映射 **502**（映射登记在 `attachment-errors.ts` 文件头）。 |
| 本地文件适配器 | `local-file-object-storage.ts` | **已存在且完备**：对象键相对 `rootDirectory` 落盘（`upload/yyyy/mm/dd/<uuid>-<slug>` 体例），contentType 写 `<file>.content-type` sidecar；`pathOf` 双保险防键越界；同样随机 HMAC 密钥。**重启后字节存活**。 |
| 令牌 | `read-reference-tokens.ts` | `v1.<b64url(claims)>.<b64url(HMAC-SHA256)>`；claims 含 **tenantId**（wave-2 D-4 新增，兑现时与请求租户比对不一致即 null——**任何持久化方案必须沿用本工具**，即自动继承租户绑定）；密钥重启轮换与 60s TTL 语义一致，持久化后无需稳定密钥。 |
| 护栏 | `attachment-input.ts` | `MAX_UPLOAD_BYTES = 32 * 1024 * 1024`（传输面护栏）；上传体 = JSON `{contentBase64}`（base64 +33% 开销——HANDOFF 已登记"upload 建议换 raw/multipart"欠账）。 |
| 模块装配 | `attachment.module.ts` | `AttachmentModule.register({objectStorage})`：**缺省 = `new InMemoryObjectStorage()`**；`OBJECT_STORAGE` Symbol 注入点已就绪，换适配器不动业务面。 |
| 上传链 | `attachment.service.ts` | `upload` = 端口 `put`（字节）→ store `create`（元数据）两步；put 成功 create 失败留孤儿对象（容忍，语义已写明）——持久化方案沿用此两步语义即可，不强制同事务。 |

### 1.2 business-store 侧（元数据与 RLS）

- **元数据表** `attachments`（迁移 `prisma/migrations/20261026150000_attachment_module/`，schema 模型 `AttachmentRecord` 约 L2541）：`storage_kind/target/object_key` 三列存端口对象引用；列表 VO 不下发三字段。
- **RLS 已登**：`src/rls/tables.ts:135`（`tenantTable('attachments')`）+ 全量重放迁移 `20261026150100`（现共 95 表）。**新表守恒机制**：新增带 `tenant_id` 的表必须登记 `RLS_TABLES` + 生成器重放迁移，`tests/rls-conformance.test.ts` / `tests/schema-conformance.test.ts` 机器守恒（漏登即红）。
- **RLS session 扩展**（`src/rls-session.ts`）：`SMES_RLS_SESSION=on` 时 `$extends` 钩子逐模型操作事务内 `SET app.current_tenant`。**已知边界（对本方案关键）**：client 级 `$queryRaw/$executeRaw` 不经钩子（无 SET，app_user 形态下 RLS fail-visible/拒写）；**被接管的交互式事务句柄上的 raw 携带租户**。→ PG 字节适配器若走 raw SQL 必须包 `prisma.$transaction(async (tx) => …)` 交互式形态；若走 Prisma 模型操作则自动覆盖。
- **连接工厂先例**：`src/attachment/pg-attachment-stores.ts` 的 `connectAttachmentStore()`（惰性连接 + RLS session 可选包装）——新字节适配器按同模式并入或新建工厂。
- **schema 无 `Bytes` 先例**：全 schema.prisma 无 `Bytes` 字段——bytea 方案是仓内首例（PG provider 下 Prisma `Bytes` 映射 `bytea`，无阻碍但需 generate 后类型面实证）。
- **测试形态**：business-store 全部测试不连活库（纯数据面守恒 + 事务桩驱动，先例 `tests/rls-session.test.ts`）；容器级贯通实证走 `deploy/scripts/`（先例 `rls-session-proof.mjs`）。

### 1.3 组合根装配（apps/server）

- `apps/server/src/main.ts`（L118 附近）：`DATABASE_URL` 存在 → `connectAttachmentStore()`（PG 元数据）；否则不注入 → 模块内存元数据。
- `apps/server/src/main.ts`（L122-125）：`SMES_ATTACHMENT_DIR` 存在 → `new LocalFileSystemObjectStorage({rootDirectory})`；**否则 undefined → 模块缺省内存适配器**。
- `apps/server/src/app-registry.ts`：`objectStorage` 是 `AppModuleStores` 注入点（约 L389、L827），`AttachmentModule.register` 消费（约 L665）——**装配切换只动 main.ts，注册表零改动**。

### 1.4 部署形态（deploy/compose.yaml）

- server 服务环境变量只传 `DATABASE_URL`（app_user）/ `SMES_RLS_SESSION=on` / `SMES_TENANT_MODE` / `SMES_DOMAIN` / `SMES_TENANTS` / `MODULES_ENABLED`——**无 `SMES_ATTACHMENT_DIR`**；server 容器**无任何数据卷挂载**（全栈唯一具名卷 = pg 服务的 `pg-data`）。
- ⇒ 部署形态（单机与 SaaS 同栈）字节恒走内存适配器 → 重启丢失 → D-3。**代码已有持久化能力（local-file 适配器 + env 接线），缺的是部署配置**；但见 §2 维度对比，仅补配置不是终解。
- migrate 一次性服务：superuser 跑 `prisma migrate deploy` + seed + `_prisma_migrations` 只读收口——新迁移自动纳入。`deploy/pg-init/01-app-user.sh` 已登记 `ALTER DEFAULT PRIVILEGES FOR ROLE postgres … GRANT DML`——**superuser 迁移建的新表自动对 app_user 授权，迁移内无需 GRANT**。

### 1.5 与本方案相关的既有欠账/定向（必须纳入）

1. **HANDOFF 技术欠账**：①"attachment 对象层无租户前缀（接 MinIO/S3 时必须补）"——对象键 `upload/日期/uuid-slug` 无租户段，多租户共享键空间（文件卷/对象存储形态的隔离仅靠元数据层与令牌绑定，非机制级）；②"upload 建议换 raw/multipart"（base64 +33% 传输开销）。
2. **fix-wave-4 W4-2 已定向**：D-3 修复 = **PG 适配器（bytea，新文件 `packages/business-store/src/attachment/pg-object-storage.ts`）+ 组合根按环境切换 + 不改 attachment 域主体**；新表进 RLS 守恒；迁移编号顺延；解锁条件 = fix-wave-2 回传（attachment 域静止）。**本预研即对该定向做独立验证**（结论见 §3：定向成立）。

---

## 2. 两方案对比

### 方案 A：PG bytea（附件内容入库）

形态：business-store 新增对象表 `attachment_objects`（`tenant_id` + `object_key` + `bytes bytea` + `content_type`），新 `ObjectStoragePort` PG 适配器（Prisma `Bytes` 模型操作或交互式事务内 raw）；组合根 `DATABASE_URL` 存在时注入。独立新表而非 `attachments` 加列：列表/详情查询永不触碰字节列（TOAST 指针仅在 select 时解外），且 `attachments` 元数据表零迁移（wave 在途面最小化）。

### 方案 B：文件卷 / MinIO-S3 对象存储

形态 B1（文件卷）：compose 新增具名卷挂 server + `SMES_ATTACHMENT_DIR` env——**应用代码零改动**（适配器与接线均已存在）。形态 B2（MinIO/S3）：compose 新增 minio 容器 + 新写 S3 SDK 适配器 + 租户前缀欠账先补。

### 逐维度对比

| 维度 | 方案 A（PG bytea） | 方案 B1（文件卷） | 方案 B2（MinIO/S3） |
| --- | --- | --- | --- |
| **改动面（包/文件）** | `packages/business-store/src/attachment/pg-object-storage.ts`（新，~150 行级，参照 in-memory 结构）+ `prisma/schema.prisma` 新模型 + 新迁移 + `src/rls/tables.ts` 一行 + 重放迁移 + `apps/server/src/main.ts` 装配切换行；**碰 business-store（wave-1/wave-3 冻结面，须待合流）** | `deploy/compose.yaml`（新卷 + env）+ `deploy/README.md`；**零代码改动** | compose 新服务 + 凭据 + 新适配器 + **租户前缀欠账先补（键体例变更，动 objectKey 生成面）**；改动面最大 |
| **迁移** | 新表迁移（编号顺延当前最新槽位）+ RLS 全量重放迁移（先例 150100/161000/171000）；重放迁移是**全量快照，与其他在途新表波次撞合并**（须串行合流） | 零迁移 | 零 DB 迁移（元数据表不动） |
| **RLS 与租户隔离** | **机制级**：对象行带 `tenant_id` 走既有 RLS 谓词（app_user 无 BYPASSRLS，未设变量 0 行/拒写）——字节与元数据同一隔离机制，纵深防御一致 | **约定级**：键空间无租户前缀（欠账①），多租户共享一卷目录树；隔离靠元数据层过滤 + 令牌租户绑定（D-4 已修），对象文件本体任何能读卷的进程可全量枚举 | 欠账①必须先补（前缀体例），补后为桶/前缀约定级 |
| **重启持久性** | ✅ 字节随 PG 存活（pg-data 卷） | ✅ 字节随卷存活 | ✅ |
| **备份恢复** | **pg_dump 一体**：元数据 + 字节同一时间点快照，单流程；单机买断交付物天然含附件 | 两套流程（pg + 卷），时点不一致风险：恢复后"元数据有字节无"→502，"字节有元数据无"→孤儿 | 三套（pg + minio 数据 + 凭据）；同左时点风险 |
| **容量与性能** | 32MiB 上限内可行：bytea 自动 TOAST（>2KB 行外 + 默认 pglz 压缩尝试，上限 1GB）；列表查询不碰字节列零开销。**无流式**：put/resolve 全量进出 Node 内存（Prisma `Bytes` ↔ Buffer）——与现状同阶（base64 上传本就全量进内存，开门面本就 `Buffer.from` 全量回发），非回归。**WAL 放大 + pg-data 卷容量增长**纳入 DB 容量规划 | 文件系统天然流式潜力（现适配器 readFile 仍全量）；容量独立于 DB 卷，备份压力与 DB 解耦 | 对象存储原生流式/分片；容量最优 |
| **运维复杂度（双形态均须可用）** | **最低**：零新服务零新依赖，compose 零变更（migrate 自动建表），单机/SaaS 同一形状 | 单机低；SaaS 同卷单实例可用（当前无水平扩展），但**未来多副本 server 即刻破功**（卷不共享，或上 NFS——复杂度反超） | 新容器 + 凭据轮换 + 监控面；多副本就绪，但对当前单实例栈是超前依赖 |
| **与 local-file 适配器复用度** | 低（新写；令牌工具/对象键生成/错误语义全复用，结构参照 in-memory） | **100%**（现成适配器 + 现成 env 接线） | 部分（端口合同复用，SDK 实现全新） |

**方案 B 的决定性短板**：B1 在单机形态是"一行 compose 配置"的最小修，但 (a) 多租户 SaaS 形态下键空间无租户前缀的欠账即刻暴露在持久化卷上（且 B1 连欠账的"接 MinIO/S3 时再补"缓冲窗口都取消不了——文件卷就是对象存储的前身形态）；(b) 未来任何多副本/迁移场景（单机客户换机、SaaS 扩容）卷不随栈走，备份两套流程；(c) 备份时点不一致会制造出与 D-3 相同症状的 502。B2 则引入部署合同明示"归部署期换装"的新运行时依赖，且欠账①（键前缀体例变更）必须先做——改动面与协调面远超 P1 缺陷修复颗粒度。

---

## 3. 推荐

### 3.1 结论：方案 A（PG bytea），单选

核心理由：

1. **fix-wave-4 W4-2 的定向技术验证成立**——32MiB 护栏内 bytea+TOAST 无性能阻碍；Prisma `Bytes` 虽是仓内首例但走模型操作即自动纳入 RLS session 扩展（无须触碰 raw 边界）；RLS 守恒机制（tables.ts + conformance 测试 + 重放迁移）对"新表带 tenant_id"有完整既有流水线。
2. **双形态同修 + 备份一体 + 隔离机制级**：compose 零变更，单机/SaaS 同时生效；pg_dump 单流程消除备份时点分裂（那正是 D-3 的同类症状源）；字节隔离从"元数据约定"升级为与全仓 95 表一致的 RLS 行级强制——与 ADR-0005 纵深防御路线同向。
3. **欠账处置最优**：bytea 形态下 `objectKey` 退化为库内唯一标识（租户隔离由 `tenant_id` 行承载），HANDOFF 欠账①的"必须补租户前缀"条件不再被本修复触发，可维持登记至真正接 MinIO/S3 时再补——方案 B1 反而会立即触发该欠账。

### 3.2 风险登记（随方案 A）

| # | 风险 | 处置 |
| --- | --- | --- |
| R1 | Prisma `Bytes` 仓内首例：generate 后类型面/`Buffer↔Uint8Array` 转换需实证 | PR-1 内先做最小 generate + 类型冒烟再铺开 |
| R2 | 无流式读写：32MiB 全量进出 Node 内存 | 与现状同阶非回归；开门面本就全量 Buffer；护栏在输入层不变 |
| R3 | WAL 放大 + pg-data 容量增长（附件字节计入 DB） | 登记入 deploy/README 容量口径；备份频率属 Owner 裁定（§4-5） |
| R4 | `issueReadReference` 不得取字节列（只验存在性，select 主键）——否则每次签发 32MiB 解 TOAST | 实施纪律写入适配器（单测锚定：签发不触发字节读取） |
| R5 | 历史遗留行：memory 时期元数据（字节已丢）修复后仍 502——**不可恢复，仅症状不变** | 是否运维清理（SQL 置删）归 Owner 裁定（§4-2） |
| R6 | 重放迁移全量快照与并行波新表撞合并 | RLS 重放迁移放 PR-1 末尾单独提交，合流时串行重生成（见 §3.4） |

### 3.3 实施拆步（最小 PR 切片；解锁条件 = fix-wave-2 回传 + wave-1/wave-3 合流后 business-store 解冻）

- **PR-1（存储适配器 + 迁移，纯 business-store 面）**：
  `prisma/schema.prisma` 新模型 `AttachmentObject`（`id/tenant_id/object_key/bytes/content_type/created_at`，`object_key` 唯一索引，**不登 attachments 表任何变更**）→ 新迁移（槽位顺延 `20261026…` 之后；表 DDL + 唯一索引 + RLS 三段照 150000/150100 先例手写或生成器出）→ `src/rls/tables.ts` 补一行 → 重放迁移槽位 → `src/attachment/pg-object-storage.ts`（实现四端口方法；`put` = 模型 insert；`issueReadReference` = **只 select id 验存在** + 现有 HMAC 工具签发；`resolveReadReference` = 按令牌 claims 取行，校验 tenantId 一致；`currentTarget` = `{storageKind:'pg', target:'pg'}`——target 命名待裁定 §4-1）→ 工厂并入 `connectAttachmentStore` 或新 `connectAttachmentObjectStorage`（惰性连接同先例）→ 测试：schema/迁移/RLS 三向守恒（`tests/attachment-module.test.ts` 模式扩展）+ 适配器桩单测（事务桩驱动，先例 `rls-session.test.ts`；含 R4 锚定）。
- **PR-2（组合根切换，apps/server 面）**：
  `main.ts` 装配优先级——缺省建议：`SMES_ATTACHMENT_DIR` 显式存在 → local-file（保留运维显式覆盖）；否则 `DATABASE_URL` 存在 → PG 适配器；否则 → 模块内存（零 DB 演示回落，fix-wave-4 定向"内存形态保留现状"成立）。优先级若 Owner 另有裁定按 §4-1 调整。`app-registry.ts` 零改动（注入点已就绪）。application 侧仅补组合断言（`packages/application/tests/attachment/`，注入桩验证装配面），**attachment 域主体文件零触碰**（HMAC/穿越防护/元数据链不动——W4-2 纪律）。
- **PR-3（容器复证 + 文档，deploy 面）**：
  compose **零变更**（migration 自动建表、server 自动注入 PG 适配器）——复证即跑 grokbot 命令：上传 → `docker restart cadence-server-1` → `download-reference` 200 + 开门面字节一致；saas 形态 tenant-a 同跑；跨租户兑现旧 token → 404（D-4 不回归）；`SMES_RLS_SESSION=on` 下 RLS 生效面（未设租户变量读 0 行）抽验。`deploy/README.md` 补持久化口径 + 容量/备份注意（R3）。

### 3.4 预计写入面清单（wave 冻结面标注）

| 文件 | PR | 冻结面冲突 |
| --- | --- | --- |
| `packages/business-store/prisma/schema.prisma` | 1 | **wave-1 在途面（D-8 同树）+ wave-3 禁碰面——须两波合流后实施** |
| `packages/business-store/prisma/migrations/<新槽位>_attachment_objects/` | 1 | 同上；槽位与 wave-3 已有新迁移（aftercare/project_cost）顺延不撞 |
| `packages/business-store/prisma/migrations/<新槽位>_rls_tenant_isolation_replay/` | 1 | **高冲突风险**：全量快照，若与任何并行新表波次同时落 → 合流时以最后一家为准串行重生成 |
| `packages/business-store/src/rls/tables.ts` | 1 | wave-1/wave-3 冻结面（一行追加） |
| `packages/business-store/src/attachment/pg-object-storage.ts`（新） | 1 | 冻结面内新文件，无文本冲突，仅时序约束 |
| `packages/business-store/src/attachment/index.ts`（导出新工厂） | 1 | 同上 |
| `packages/business-store/tests/attachment-module.test.ts`（扩展）+ 新适配器测试 | 1 | 同上 |
| `apps/server/src/main.ts`（装配切换行） | 2 | wave-2 允许面（apps/server/src）但 D-5 可能同文件——**W4-2 解锁条件即 wave-2 回传，时序天然错开**；wave-3 面是 cross-module-wiring/app-registry，不撞 main.ts |
| `packages/application/tests/attachment/attachment.test.ts`（组合断言追加） | 2 | wave-2 面（attachment 域测试），时序错开 |
| `deploy/README.md` | 3 | wave-2 允许（仅 README/文档），时序错开 |
| `deploy/compose.yaml` | — | **零改动**（方案 A 决定性优势之一） |

### 3.5 测试面汇总

- **单测**（PR-1/2）：三向守恒（schema↔迁移↔RLS 清单）；适配器桩单测（put/issue/resolve/跨租户拒/令牌过期/**签发不读字节列** R4）；application 组合装配断言。
- **行为级**（容器，PR-3，= grokbot 复现命令即验收脚本）：
  1. 上传（`POST /attachment/upload` base64）→ `docker restart cadence-server-1` → `GET /attachment/download-reference?id=&bizId=` → **200**（修复前 502）→ `GET /attachment/storage/<token>` 字节与上传一致；
  2. 32MiB 护栏不回归（>32MiB → 400）；
  3. 跨租户拒：tenant-a 令牌换 tenant-b Host 兑现 → 404（D-4 语义保持）；
  4. 零 DB 回落形态（无 `DATABASE_URL`）不回归（内存语义完整）；
  5. saas 形态 tenant-a 同跑第 1 步。
- **RLS 复证**：`pnpm verify:rls` 容器三面 + conformance 双测试绿。

---

## 4. 待 Owner 裁定清单（不替 Owner 定）

| # | 事项 | 缺省建议（不裁则按此实施） |
| --- | --- | --- |
| 1 | **装配优先级**：`SMES_ATTACHMENT_DIR`（显式文件卷）与 `DATABASE_URL`（→ PG 适配器）并存时谁赢；是否再加显式 `SMES_ATTACHMENT_STORAGE=pg\|local-fs\|memory` 开关 | 建议不加新开关：`SMES_ATTACHMENT_DIR` 显式覆盖 > `DATABASE_URL`→PG > 内存回落；PG 适配器 `storageKind/target` 自述串建议 `'pg'`/`'pg'`（列表 VO 不下发三字段，改串无兼容负担） |
| 2 | **历史遗留 memory 元数据行**（字节已丢、修复后仍 502）：SQL 置删 / 保留待物理清理工具 / 不处理 | 建议随 PR-3 附运维 SQL 脚本（不自动跑），由单机客户/SaaS 运维自行决定 |
| 3 | **HANDOFF 欠账①（对象层租户前缀）**：bytea 形态下欠账条件是否改写为"仅接 MinIO/S3 时必须补（键前缀）"并关闭文件卷分支语义 | 建议改写登记（bytea 行级隔离已是机制级），欠账保留于 MinIO/S3 前提下 |
| 4 | **欠账②（upload 换 raw/multipart）**：是否纳入 D-3 波顺带做 | 建议不顺带（W4-2 定向"不改 attachment 域主体"；换传输层动控制器/组合根 body 解析器，颗粒度另派） |
| 5 | **pg-data 卷容量规划与备份频率**：附件字节计入 DB 后单机买断交付的磁盘预估、pg_dump 频率/压缩建议 | 建议仅在 deploy/README 登记口径（32MiB/件上限 + 增长估算公式），不设硬配额（配额属 G6 能力缺口，未实现） |
| 6 | **32MiB 上限**是否调整 | 建议不动（文档已确认决策：不做业务大小白名单，本值是传输面护栏） |

---

## 5. 结论速览

- **方案对比一句话**：A（PG bytea）以"新适配器 + 新表迁移"的一次性代码成本换机制级 RLS 隔离、pg_dump 一体备份、双形态零 compose 变更；B1（文件卷）零代码但把租户前缀欠账立刻兑现到持久层且备份/迁移两套流程；B2（MinIO/S3）超 P1 修复颗粒度。
- **推荐**：方案 A，与 fix-wave-4 W4-2 定向一致；实施三 PR（适配器+迁移 → 装配切换 → 容器复证+文档），全部步骤在 wave-1/2/3 合流后错峰落位，attachment 域主体零触碰。
- **验收**：grokbot 复现命令反转（上传→restart→download-reference 200 + 字节一致），双形态各跑一遍。
