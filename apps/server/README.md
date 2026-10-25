# @smes/server —— NestJS 组合根（ADR-0001/0004）

apps 只做组合：本包独占 `@nestjs/core`、平台适配器与应用注册表；业务逻辑一律下沉
`packages/business-core`（纯领域，零框架依赖）与 `packages/application`（模块壳）。

## 运行

```bash
pnpm install
pnpm --filter @smes/server build
node dist/main.js                 # 默认 :3000（PORT 可改）
# curl localhost:3000/health   → {"status":"ok","tenant":"default"}
# curl localhost:3000/modules  → {"modules":["core","org","demo"]}
# curl localhost:3000/demo/ping
# curl localhost:3000/demo/data -H 'x-smes-user: bob'   → 403（受保护示例端点，无策略即拒）

MODULES_ENABLED=core node dist/main.js   # 停用 org/demo：/modules 变化，/demo/ping 404

# 策略注入测试钩子（默认不装配，生产形态不开；与正式 org 端点并存，见下）：
SMES_DEV_POLICY_ENDPOINT=on node dist/main.js
# curl -X POST localhost:3000/dev/policies -H 'content-type: application/json' \
#   -d '{"rules":[{"kind":"grant-role","tenant":"default","user":"bob","role":"operator"},
#                 {"kind":"grant-permission","tenant":"default","role":"operator","resource":"demo","action":"read"}]}'
# → {"applied":2}；随后同请求 GET /demo/data（x-smes-user: bob）→ 200
```

## PG 持久化（M1 增量 3-D）

设 `DATABASE_URL` 时，main.ts 经 `connectBusinessStore()`（`@smes/business-store/org`）
装配 PG 实现：casbin 策略（policies 表）、用户/角色元数据（users/roles 表）全部
落 PG，**重启存活**。装配流程：

```bash
# 1) 迁移（business-store 包，Prisma 约定）
DATABASE_URL=postgres://... pnpm --filter @smes/business-store prisma:migrate
# 2) 组织种子（幂等：管理员策略 + 演示身份授权；显式种子而非启动种子——见下"启动零 DB 依赖"）
DATABASE_URL=postgres://... pnpm --filter @smes/business-store db:seed
# 3) 起 server
DATABASE_URL=postgres://... node apps/server/dist/main.js
```

**启动零 DB 依赖（硬合同）**：bootstrap 阶段不碰数据库——无 `DATABASE_URL` 时
不构造任何 PrismaClient（组织/策略存储回落内存实现，org 模块仍装配、端点可用、
判定照常）；设了也只构造客户端（PrismaClient 惰性连接），首条业务请求才连库。
启动期种子因此被排除（seed 是显式命令，`db:seed`）。

### 组织/用户/角色管理端点（正式 CRUD，带 RBAC 门禁）

| 方法与路径 | 权限码 | 语义 |
| --- | --- | --- |
| GET /org/users | user:read | 当前租户用户列表 |
| POST /org/users | user:write | 创建用户（租户内 username 唯一；409 冲突） |
| PUT /org/users/:id/roles | user:write | 期望态设置用户角色集合（diff 授权） |
| GET /org/roles | role:read | 角色列表（含各角色已授权限码） |
| POST /org/roles | role:write | 创建角色元数据 |
| PUT /org/roles/:name/permissions | role:write | 期望态设置角色权限码集合 |

错误映射（`src/org-error.filter.ts`）：`OrgInputError` → 400、`OrgNotFoundError`
→ 404、`OrgConflictError` → 409（域错误类在 application，HTTP 映射属组合根）。

`POST /dev/policies` 测试钩子与上述正式端点**并存**：两者写同一条
`PermissionService.apply → casbin autoSave → PolicyStore` 路径，钩子默认关闭
（`SMES_DEV_POLICY_ENDPOINT=on` 才装配），用于无组织管理端的快速策略注入。

## 鉴权链路（M1 增量 2-B：casbin RBAC 域模型 + 策略端口）

- 全局 `AuthGuard`（`src/auth.guard.ts`，经 `APP_GUARD` 注册）：未声明
  `@RequirePermission` 的路由 = 公开路由直通；声明了权限码的路由做
  租户（TenantContext/ALS）+ 用户 + 权限码三要素判定，身份缺失与判定拒绝一律 403。
- dev/test 身份形状 = 请求头 `x-smes-user`；**生产替换点** = `AuthGuard.resolveUser`
  （OAuth 落地后改读真实会话，其余链路不动）。
- 判定逻辑全部在 `@smes/application` 的 `PermissionService`（零框架业务类）：
  casbin RBAC with domains（模型文本入库版本化），精确权限码零通配、
  域内 admin bypass、租户维度隔离三类语义各有单测。
- 策略存储端口 `PolicyStore`（application 包定义）：内存实现先行；
  PG adapter 在 `@smes/business-store` 的 `./org` 子路径（`connectBusinessStore`），
  本组合根按 `DATABASE_URL` 存在性二选一装配。

## 装配纪律（ADR-0004 机器形态）

- 应用注册表 = `src/app-registry.ts`：`MODULES_ENABLED`（逗号分隔，默认 `core,org,masterdata,workbench,demo`）
  决定装配集合与顺序；core 为必装基础层，缺席即拒绝启动；未知模块名 fail-fast。
- 新增模块 = 在 `packages/application/src/<module>/` 建 `XxxModule.register(options)`
  动态模块，并在 `MODULE_DEFINITIONS` 登记一行。报价单可选模块行 ↔ 注册表条目一一对应。
- **application 包的框架依赖例外**：application 允许且仅允许依赖 `@nestjs/common`
  （peerDependency），且只限装配元数据——`@Module` / `@Injectable` / `@Controller` /
  `@Get` / `@Post` / `@Put` / `@Body` / `@Param` / `SetMetadata`
  （路由权限码声明 `@RequirePermission`）装饰器与 `DynamicModule` 定义；
  禁止 `@nestjs/core`、`@nestjs/platform-*`。
  理由：ADR-0001"业务包纯净无框架依赖"的意图是**业务逻辑不被容器锁死**；只引装配
  元数据是 NestJS 官方库模式的标准做法。**业务逻辑类本身（如 tenant-context.ts、
  permission.service.ts、org.service.ts）不得 import 任何 `@nestjs/*`**；NestJS
  运行时链路件（守卫、异常过滤器、异常类）放组合根本包（如 `src/auth.guard.ts`、
  `src/org-error.filter.ts`）。
- `reflect-metadata` 全仓只在 `src/main.ts` 入口 import 一次（测试文件各自引入除外，
  仅因 vitest 按文件独立加载装饰器类）。
- TenantContext（ADR-0005）：单租户形态固定默认租户 `default`（ALS 无 store 时零开销
  回落）；SaaS/RLS 在 M4 经 `CoreModule.register({ tenantResolver })` 接入，接口形状
  已就位。
- 工具面（ADR-0008 最小工具面）：构建/类型检查用 tsc（无 nest-cli），`pnpm build` 产
  dist，`pnpm start` 跑 `node dist/main.js`，`pnpm dev` = build && start（无 watch 热重载）。
