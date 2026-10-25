# @smes/engine-flow

审批流配置引擎：XState 之上的自研薄层（决策簿：~10 人日，输出对齐 DomainReview 形状）。
ADR-0010 条 2（状态集配置分离）的首个落地包。纯域：无框架、无存储 IO、无时钟依赖
（now / newEventId / timer 均可注入）。

## 分层

| 模块 | 职责 |
| --- | --- |
| `config.ts` | 版本化配置形状（状态清单 / 迁移规则 / 守卫引用 / 状态级超时）+ 校验即深冻结 |
| `default-config.ts` | 默认通用审批配置：draft → submitted →（评审循环）→ approved / rejected / withdrawn |
| `machine.ts` | XState 机器工厂（吃配置产状态图）+ 守卫合同（按名引用，注册表解析；上下文含角色表） |
| `record.ts` | 审批记录：reviewer（品牌化 UserId）/ decision（approve/reject/escalate/withdraw + 理由）/ evidence / objectVersion，构造即深冻结 |
| `events.ts` | 审批事件：BusinessEvent 精简子集（独立定义，取舍见文件头注释）；`toBusinessEventInput` 固定与 business-core 账本的对接形状 |
| `runtime.ts` | 运行时薄层：`send` / `can` / `snapshot` / `stop` + append-only 账本（写时复制冻结）+ 超时自动迁移 |
| `timer.ts` | 定时器端口（`ApprovalTimerPort`）+ 默认 setTimeout 实现（`DEFAULT_TIMER_PORT`）+ 确定性假时钟（`createFakeTimerPort`） |
| `store.ts` | 持久化端口：`ApprovalRecordStore`（决策记录）+ `ApprovalEventStore`（append-only 事件，游标读）+ 内存实现；EvidenceColumns 映射见下 |
| `guards.ts` | 常用守卫库：`quorumGuard` / `roleGuard` / `versionGuard`（纯函数，输入 = 决策史 + 上下文） |

## 关键取舍

- **状态集 = 版本化配置**：`defineApprovalFlowConfig` 校验冻结纯数据；换一份配置即换一台机器
  （`startApprovalFlow` 不含任何硬编码状态名）。行业包整体替换默认状态集，内核零改动。
- **守卫在薄层求值，XState 持有状态图**：守卫需要域上下文（决策史 / 对象版本 / 提交输入 / 角色），
  不属于状态图；两处同构性由迁移后断言防护（XState 解析结果 ≠ 规则目标态即抛不变量错误）。
- **记录的 objectVersion = 决策所见版本**（乐观锁口径），事件的 `aggregate.revision` /
  `payload.objectVersion` = 迁移后版本；每次成功迁移版本 +1。
- **超时自动迁移 = 状态级配置 + 注入式定时器**：状态声明 `autoAfterMs` + `autoEvent`
  （成对校验；autoEvent 必须有 from 该状态的规则；终态不得声明）。进入状态即排定、
  迁出即作废、到点走与人工提交完全相同的求值路径（守卫拒绝不重试，一次性）；
  `stop()` 释放全部在途定时器。时间机制经 `ApprovalTimerPort` 注入——默认宿主
  setTimeout，测试用 `createFakeTimerPort` 假时钟（零真实等待）。
- **存储端口为异步形状**：PG 实现天然异步，端口按 Promise 定形，business-store 落地
  时不改调用方；事件游标 = 全局追加序号（单调递增），映射 PG bigserial / uuidv7 时间序。
- **deepFreeze / 事件类型正则按"零件各造"镜像** business-core internal 实现（其未导出，
  冻结纪律与形状等价，ADR-0003）。

## EvidenceColumns 口径映射（事件表 → 未来 PG，由 business-store 实现）

| EvidenceColumns 列 | 事件表来源 | 补齐点（入账时） |
| --- | --- | --- |
| `id`（uuidv7） | `eventId` | — |
| `object_version` | `aggregate.revision` = `payload.objectVersion`（迁移后版本） | — |
| `business_time` | `occurredAt` | 适配层可按补录口径覆盖 |
| `available_time` | — | 入账时补（对外可见时刻） |
| `provenance` | — | 入账时补（operationId / 命令信封摘要） |
| `tenant_id` | — | `toBusinessEventInput` 已固定补齐形状（events.ts） |
| `audit_status` | 事件表不适用（业务事实表口径，合法值由领域规格定义） | — |
| `supersedes` | 事件表不适用（append-only；重复 append 按 eventId 拒绝即幂等去重） | — |

## 非目标（后续增量）

server/NestJS 注册（组合根）、审批管理 UI、PG 持久化本体（business-store 实现，
本包只留端口接缝）、casbin 联动、通知/IM 联动。
