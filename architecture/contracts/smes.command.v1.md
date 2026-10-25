# 合同：smes.command.v1（CommandEnvelope）

版本：v1（2026-10-24 随 M0 立桩冻结）
实现：`packages/business-core/src/envelope/command-envelope.ts`
同构参照：OwlCodaE product.v1（图纸对齐，零件各造）

## 字段

| 字段 | 类型 | 约束 | 语义 |
|---|---|---|---|
| `contract` | `'smes.command.v1'` | 字面量 | 合同名，结构识别的第一道 |
| `tenantId` | `Brand<string,'TenantId'>` | 非空 1~128 | 租户；单租户形态=固定默认租户（ADR-0005） |
| `issuedBy` | `Brand<string,'UserId'>` | 非空 1~128 | 发命令的人（或系统账号） |
| `operationId` | `Brand<string,'OperationId'>` | 非空 1~128 | 操作幂等键：同一 operationId 只允许落账一次 |
| `expectedRevision` | `'initial' \| number` | 数字须为整数 >= 1 | objectVersion 乐观锁；`'initial'` = 创建命令 |
| `issuedAt` | ISO 8601 字符串 | 可被 Date.parse | 签发时刻 |
| `command` | object | 非 null、非数组 | 命令载荷，形状由各领域规格定义 |

## 不变量

1. 信封构造后**深冻结**（含 command）——不可变快照纪律（ADR-0003 #4）
2. `expectedRevision` 与目标对象当前 `objectVersion` 不符 → 命令 rejected（乐观锁冲突），不重试同信封
3. `operationId` 已落账 → 拒绝重复执行（幂等）

## 结果三分（CommandOutcome）

| status | 含义 | 后续 |
|---|---|---|
| `committed` | 已落账 | 携 `newRevision` + 产生的 `events` |
| `rejected` | 拒绝（校验/乐观锁冲突/业务规则） | 携 `reason`；可安全改后重发新 operationId |
| `indeterminate` | 可能已落账也可能未落（如写入后失联） | 携 `reason` + `retrySafe`；`retrySafe=false` 禁止自动重试，须先人工对账 |

## 示例

```json
{
  "contract": "smes.command.v1",
  "tenantId": "t-demo",
  "issuedBy": "u-planner-01",
  "operationId": "op-0192f3a1-create-0001",
  "expectedRevision": "initial",
  "issuedAt": "2026-10-24T10:00:00.000Z",
  "command": { "kind": "smes.workorder.v1.create", "payload": { "/* 由 M2 领域规格定义 */": true } }
}
```

> command.payload 的字段口径由 M2 清洁室领域规格产出，不从现系统文档抄（ADR-0002）。
