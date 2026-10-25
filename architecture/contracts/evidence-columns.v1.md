# 合同：证据标准公共列（evidence-columns.v1）

版本：v1（2026-10-24 随 M0 立桩冻结；表结构落地在 M1 business-store）
实现：`packages/business-core/src/evidence/evidence-columns.ts`
消费者：append-only 事件表 / 审计 / integration-connect（/connect/v1 只读连接器，OwlCodaE 侧消费）

## 公共列

| 列 | 类型 | 语义 |
|---|---|---|
| `id` | uuidv7 | 主键，时间有序 |
| `object_version` | integer >= 1 | 乐观锁版本；smes.command.v1 的 `expectedRevision` 对账锚点 |
| `audit_status` | string | 审核状态；**合法值集合由各领域规格（M2 清洁室产出）定义**，本合同不预设枚举 |
| `provenance` | JSONB | 溯源：operationId、命令信封摘要、来源系统、操作者 |
| `supersedes` | uuid 可空 | 本记录取代的前任记录 id（append-only 修正链，不物理更新） |
| `business_time` | timestamptz 可空 | 业务时间（可补录，如事后补录的报工） |
| `available_time` | timestamptz 可空 | 可用时间（对账与连接器读取口径：何时对外可见） |

## 纪律

1. 业务事实表 **append-only**：修正走 `supersedes` 链，不改不改行
2. 业务事件另落 **事件表 + Outbox**（形状见 `BusinessEvent` / `OutboxRecord`）
3. `/connect/v1` 连接器**只读**；智能层（OwlCodaE）读信息层的账，写回仅经 BusinessAction 具名授权（交接文档 §12）
4. 全表带 `tenant_id`（ADR-0005，M4 RLS 的前提）
