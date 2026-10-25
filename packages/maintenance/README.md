# @smes/maintenance（维保专业包）

状态：**M3 已实施**（冻结合同 `architecture/contracts/m3-drafts/02-maintenance.md`
v1.0）。计划性维保的执行域：版本化维保计划（设备×周期×点检判据+保养动作清单，
改计划=发新版本、历史记录溯源旧版可解释）、维保任务状态机（scheduled →
executing → done + cancelled 回退支，engine-flow 配置承载；到期扫描生成 /
故障联动经 baseline Outbox 事件在组合根粘合 / 手工）、三态 append-only 记录
（点检 pass/fail、保养动作完成、维修处置 faultRef+restored；修正走冲销/补录
不改原行）。零框架业务类（不 import @nestjs/*）——注册进组合根与激活开关接线
归总控（开关关闭 = 入口/权限码/事件消费全不可见，见 `src/index.ts` 文件头）。

实施版面（M3 第二包，体例对齐 packages/payroll——M3 首波已验收先例）：

| 文件 | 职责 |
| --- | --- |
| `src/ports.ts` | baseline 形状引用（ResourceRef/FaultRef + Fault*Fact 结构同形镜像；零 import，组合根粘合） |
| `src/maintenance-config.ts` | 任务状态机配置（engine-flow ApprovalFlowConfig）/ 周期枚举与上界 / 到期 occurrence 纯函数 / 权限码 |
| `src/maintenance-ids.ts` | 品牌化 MaintenancePlanId / MaintenanceTaskId / CheckpointRecordId / UpkeepRecordId / RepairRecordId |
| `src/maintenance-errors.ts` | Input/NotFound/Conflict（含跨包结构同形防线 isMaintenanceConflict） |
| `src/maintenance-events.ts` | 七事件词汇（PlanPublished / TaskCreated·Started·Completed·Cancelled / ActivityAppended / CheckpointFailed） |
| `src/maintenance-stores.ts` | 存储端口：计划版本行 / 任务投影行（乐观锁条件更新）/ 三态记录行 / 事件 / 幂等账本 |
| `src/maintenance-input.ts` | 命令面解析（发布/到期扫描/建单/三迁移/记录追加；G1 前置校验） |
| `src/maintenance.service.ts` | 用例编排：due-scan 幂等去重（sourceKey 唯一锚）/ 状态机迁移 / 三态留痕 / 查询 |
| `src/in-memory-maintenance-stores.ts` | 内存先行实现（零 DB boot）；PG 适配在 business-store `./maintenance` |

## 组合根装配（已实施，R-M3-3 形态）

REST/HTTP 面**不在本包**（R-M3-3 裁定：专业包零框架耦合，控制器/装配归组合根——
本包保持"不 import @nestjs/*"，与 `pro-pack-tier-edges` 一致）：

- HTTP 模块：`apps/server/src/maintenance-http.module.ts`
  （`MaintenanceHttpModule.register({ stores, faultLinkage })`，每路由挂
  `@RequirePermission`；权限码=合同 §5 最小集 `maintenance:read / plan-write /
  task-arrange / record`，`<通用词>:<动作>` 形状）；
- 错误映射：`apps/server/src/maintenance-error.filter.ts`（Input→400 /
  NotFound→404 / Conflict→409）；
- 注册挂载：`apps/server/src/app-registry.ts` 的 `MODULE_DEFINITIONS.maintenance`
  （stores 缺省内存回落；PG 形态经 business-store `connectMaintenanceStore`
  注入 `maintenanceStores`；激活价=MODULES_ENABLED 显式开启）。

## e2e（PG 形态）

`scripts/e2e-maintenance-drawing-pg.mjs`（仓根，与 drawing 共用）：一次性
docker postgres:16 + 全量 migrate deploy + 服务层 e2e（本包 MaintenanceService ×
business-store PG 五端口，结构同形注入）。前置 `pnpm build`，运行
`node scripts/e2e-maintenance-drawing-pg.mjs`。RLS 三面实证归
`deploy/scripts/rls-proof.mjs`（80 表全量）。


以下预热草案记录保留作设计沿革（ADR-0010 三问表与依赖方向裁定仍然有效；
§8 差异表六行已全部落地：任务对象+状态机与 due-scan 收编为到期扫描、存储端口
任务面扩展、五品牌化 ID、故障联动裁定为组合根粘合、点检 fail 发
CheckpointFailed、命令/查询/权限/事件全套补齐）。

## 领域概念与 ADR-0010 三问记录

| 概念 | 三问记录（1 单一行业？2 可重述为通用上位+配置？3 已有上位可挂靠？） | 落点 |
| --- | --- | --- |
| 设备 | 3：已有通用上位概念——baseline 设备台账（功能项 16） | `ResourceRef`（引用 id 形状，**不依赖包**） |
| 点检 | 2：通用记录动词"按判据比对"——判据是数据字符串，不是内核枚举 | `CheckpointActivityRow.result: 'pass' \| 'fail'` |
| 保养 | 2：通用记录动词"动作完成留痕"——动作清单由计划作者定义 | `UpkeepActivityRow.actionsDone` |
| 维修 | 2：通用记录动词"故障处置"——故障事实在 baseline（功能项 20），只引用 | `RepairActivityRow.faultRef / restored` |
| 保周期（日保/月保…） | 2：重述为周期数据 daily / interval-days，行业叫法是配置值 | `MaintenanceCycle` |
| 三态记录 | 通用 append-only 事实 + kind 判别；修正走冲销/补录不改原行 | `MaintenanceActivityRow` 联合 |
| 维保任务 | 2：通用"安排出来的执行单"（来源/类别是数据词，状态集是 engine-flow 配置） | `MaintenanceTaskRow` + `MAINTENANCE_TASK_FLOW_CONFIG` |

包身份词 maintenance（维保）留在包级（专业包层），不进 business-core 内核词汇白名单。

## 依赖方向

```
@smes/maintenance ──▶ @smes/business-core（UserId/TenantId/信封/事件）
      │
      ├─▶ @smes/engine-flow（任务状态机配置承载——pro-pack-tier-edges 白名单）
      │
      ├─(形状引用，不依赖包)─▶ baseline 设备台账（设备 id 形状 → ResourceRef）
      ├─(形状引用，不依赖包)─▶ baseline 故障上报（故障记录 id 形状 → FaultRef）
      └─(结构同形镜像，不 import)─▶ baseline FaultReported/FaultResolved 事件载荷
```

- **引用形状 ≠ 依赖实现**：`ResourceRef` / `FaultRef` 是字符串引用（id 形状对齐），
  baseline（application）不出现在本包依赖里；强一致校验（引用存在性）属组合根/
  实施层职责。
- **故障联动经事件（差异表 #4 裁定）**：组合根订阅 baseline Outbox 的
  FaultReported/FaultResolved，把 `FaultReportedFact` 适配为
  `maintenance.task.create.v1`（kind=repair + faultRef）——双侧零 import。
- 计划 = **版本化数据**（改点检项/周期 = 发新 plan 版本；记录与任务携带
  planVersion 快照，溯源旧版可解释）。
- 记录 = append-only 三态事实（对齐证据列纪律：修正不改原行）。

## 端口清单（M3 定稿）

| 类型 | 形状 |
| --- | --- |
| `MaintenancePlanRow` | planId + version + resourceRef + cycle + checkpoints + upkeepActions（版本化主数据行） |
| `MaintenanceTaskRow` | source（plan-due/fault/manual）+ kind + faultRef? + planId?/planVersion? + dueKey?/dueAt? + state + objectVersion |
| `CheckpointActivityRow` / `UpkeepActivityRow` / `RepairActivityRow` | 三态记录（kind 判别；performedBy = UserId） |
| `MaintenanceActivityRow` | 三态联合（读取侧统一形状） |
| `MaintenanceStores` | 计划 / 任务（创建·迁移·查询）/ 三态记录 / 事件 / 幂等账本 五端口 |

## 非目标（保持）

设备台账本身（baseline 域）、故障上报与流转闭环本身（baseline 域，P2 标准项）、
备品备件库存（定制 17）、OEE/能耗（定制 21~23）、移动端呈现（125/126 归 M5，
逻辑归本包 API）。
