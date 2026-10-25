# 02 · maintenance —— 维保专业包

v1.0（2026-10-26 冻结，审读 ACCEPT agent_4f276c04；Owner 保留推翻权）｜依据：功能项 18 设备维修和保养、19 设备检验（Web·设备管理）；125/126 同名移动项（PWA 镜像，逻辑归本包、呈现归 M5）｜决策簿：需客户维修组织与保养制度，落地门槛高 → 激活价

## 1. 包身份与边界（与 core/baseline 的分工）

**身份**：计划性维保的**执行域**——把设备台账上的设备按版本化计划生成维保任务（维修/保养/点检），执行留痕为三态 append-only 记录。
**In**：维保计划维护（设备×周期×点检项+保养动作清单，版本化）、任务安排（计划到期生成 / 故障联动 / 手工）、执行与留痕（点检 pass/fail、保养动作完成、维修处置）、到期提醒。
**Out（分工铁律）**：
- **设备台账**（EquipmentRecord，功能项 16）在 baseline——本包经 `ResourceRef` 引用其 id 形状，不复制台账；
- **故障上报与流转闭环**（FaultReport open→assigned→resolved，功能项 20，**P2 标准项**）在 baseline——故障的"报与闭环"归 baseline，本包只做维修**处置记录**（RepairRecord.faultRef 引用）与维修任务安排；即：无本包时故障上报照常闭环（标准版能力），有本包时维修执行被任务化留痕；
- 备品备件库存（定制 17）、OEE/能耗（定制 21~23）不在本包。

激活语义：开关关闭时 18/19 入口与 125/126 移动 API、权限码、计划到期扫描全不出现；故障上报（baseline）不受影响。

## 2. 领域对象

| 品牌化 ID | 实体 | 说明 |
|---|---|---|
| MaintenancePlanId | 维保计划（MaintenancePlan） | 版本化数据：planId+version+resourceRef+cycle（daily/interval-days）+checkpoints+upkeepActions；判据/动作清单全是数据 |
| MaintenanceTaskId | 维保任务（MaintenanceTask） | **合同新增**：安排出来的执行单；source ∈ plan-due（到期生成）/ fault（故障联动）/ manual；kind ∈ repair/upkeep/checkpoint；faultRef?（形状引用） |
| CheckpointRecordId / UpkeepRecordId / RepairRecordId | 三态记录 | 执行留痕 append-only 事实（草案形状保持）；修正走冲销/补录不改原行 |

**状态机（engine-flow 配置，ADR-0010）**：MaintenanceTask `scheduled → executing → done`（+`cancelled` 回退支，仅 scheduled 可撤；G2 落账顺序：先落 scheduled@v1 投影再驱动迁移）。三态记录本身无流转（事实）。

**分层标注（ADR-0010 三层）**：内核概念=任务状态集与迁移语义（engine-flow 内核承载）、三态记录 append-only 纪律；模块 schema=上表实体/命令/事件（本包版本化）；默认配置=周期枚举初版（daily/interval）、点检 fail 联动规则（实施时按客户保养制度调整，不属内核）。

## 3. 命令与查询

命令（CommandEnvelope，`maintenance.*.v1`，G1/G2 沿用）：
- `maintenance.plan.publish.v1`——发布/修订计划（演进=新版本；记录溯源旧版可解释）
- `maintenance.plan.due-scan.v1`——到期扫描（信封命令，触发面：按计划周期生成到期任务；对齐 `purchase.overdue.scan.v1` / `inspection.overdue.scan.v1` 先例，幂等去重）
- `maintenance.task.create.v1`（手工/故障联动建任务）、`maintenance.task.start.v1`、`maintenance.task.complete.v1`、`maintenance.task.cancel.v1`
- `maintenance.record.append.v1`——三态记录追加（checkpoint pass/fail / upkeep actionsDone / repair restored+faultRef）

查询：计划表（按设备）、任务队列（我的/全部）、设备维保历史（三态记录按设备×kind×时间窗）、到期日历。

## 4. 端口

- **依赖（合法面）**：business-core（UserId）；存储走端口（business-store 实现 MaintenanceSource 扩展面，组合根接线）。engine-flow（任务状态机）。
- **消费 baseline（形状引用+事件，不 import）**：`ResourceRef`=设备台账 id 形状（字符串引用；存在性校验归组合根/实施层）；`faultRef`=FaultReportId 形状。故障联动经 baseline 事件（`FaultReported`/`FaultResolved`，Outbox 订阅）在组合根适配为本包任务建议/待办——本包与 baseline 零代码依赖（`pro-pack-tier-edges`）。
- **被依赖**：engine-reporting / metric-pack（维保活动事实可作设备类口径数据源）；无 M2 模块反向依赖本包。

## 5. 权限码（最小集）

`maintenance:read`（数据权限：本人执行 vs 全部）、`maintenance:plan-write`、`maintenance:task-arrange`、`maintenance:record`（三态记录追加与任务迁移执行）。

## 6. 事件（append-only + Outbox）

`MaintenancePlanPublished`、`MaintenanceTaskCreated/Started/Completed/Cancelled`（→执行人待办）、`MaintenanceActivityAppended`（kind 判别三态）、`CheckpointFailed`（点检不合格→待办推送维修跟进，功能项 19 留存结果+联动）。

## 7. Done-when 与对账要点

- **Done-when**：计划到期自动生成任务并可执行（125/126 移动同 API）；点检按判据逐项 pass/fail 留痕、fail 进待办；维修任务可挂故障引用并记录是否恢复；任一设备可查全量维保历史（台账维度下钻）；开关关闭全链路不可见且 baseline 故障上报不受影响。
- **对账**：同计划集合同周期的到期任务生成集合与活系统一致（含日保/间隔保）；三态记录留痕与修正冲销行为等价；故障联动（fault→维修任务→restored）行为等价；计划改版后历史记录仍溯源旧版可解释。

## 8. 与预热端口草案的差异表（草案 → 合同定稿）

| # | 草案（packages/maintenance/src/ports.ts） | 合同定稿 | 依据 |
|---|---|---|---|
| 1 | 只有版本化计划 + 三态记录，**无任务对象**（"安排"缺位；排程/到期提醒被列为非目标） | **新增 MaintenanceTask 实体+状态机**（scheduled→executing→done/cancelled）与 `maintenance.plan.due-scan.v1` 到期扫描命令 | 功能项 18 原文"**安排**并记录故障维修与计划保养任务"——无任务对象则"安排"无载体；扫描命令对齐 M2 信封命令先例（草案非目标"排程"被合同收编为到期扫描触发面） |
| 2 | `MaintenanceSource` 仅 plans 读取+记录追加/读取 | 扩展**任务面**：任务创建/迁移/查询（存储端口形状随实体增补） | 同 #1 |
| 3 | id 均为 kebab/uuid 字符串 | 品牌化 `MaintenancePlanId / MaintenanceTaskId / CheckpointRecordId / UpkeepRecordId / RepairRecordId` | m2 通用纪律 5 |
| 4 | 故障联动未定义方向（仅 faultRef 形状） | **裁定：经 baseline Outbox 事件在组合根适配**（FaultReported→任务建议/待办），双侧零 import | `pro-pack-tier-edges`；与 core baseline 分工写进 §1 |
| 5 | 记录为纯事实，fail 无后续 | 点检 fail 发 `CheckpointFailed`→待办；不合格转故障上报由人触发 `baseline.fault.report`（不自动） | 功能项 19"留存结果"+推送语义；故障上报归 baseline 的边界 |
| 6 | 无命令面（纯类型草案） | 补全命令/查询/权限码/事件全套（§3~§6） | 草案本为零实现预热，合同补齐为 M2 同体例合同 |

ADR-0011 合规结论：草案 import 面仅 business-core（ResourceRef/faultRef 均形状引用），**字面零违规**；#4 为联动方向裁定收口。

## 9. 人日估算对照决策簿

建议 8 人日（M3 总盘 30 内，见 README 人日表）。范围=计划/任务/三态记录全套命令查询、到期扫描、故障联动适配、权限、对账测试；移动 125/126 呈现归 M5 不计入。

## 10. 开放问题

- 保养周期除 daily/interval 外的"按工时/按产量"触发（设备运行时数来源）——出现需求时扩 cycle 数据形状，不进内核。
- 点检项的量化判据（范围数值自动判定 vs 人工 pass/fail）——v1 人工判定+expectation 文字描述，量化判定对账阶段按客户制度定。
- 维修任务与 baseline FaultReport 的状态同步（fault resolved 但维修任务未 done 的悬挂态）——对账阶段定提醒口径。
