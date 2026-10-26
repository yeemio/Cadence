# 修复波 4 合同（fix-wave-4）：D-9 报工上界 + D-3 附件持久化

冻结：2026-10-26 午｜派发：第一线总控｜执行：解锁即派（见各项解锁条件）

## 0. 纪律

同 fix-wave-2 §3 / fix-wave-3 §0（code-writer-pro 实施 + code-reviewer 验收、局部验证绿即停、不 commit/push、不跑全仓 verify、429 退避、PATH export）。本波两项互相独立，写入面不相交，可并行。

## W4-1（=D-9，P2）报工数量上界校验

- **解锁条件**：fix-wave-3 回传（reporting 域静止）。
- **缺陷证据**（总控 2026-10-26 13:10 容器复现）：tenant-a 派工 kind=part quantity=10 → assign → 报工 doneQty=11 → `committed` 落库，无任何拦截（信封响应 inspectionIntake 字段同时证明链路其余部分健康）。
- **修复**：`report.submit`（含 submit-batch 逐单）校验**按派工单累计有效报工量 + 本次 ≤ 派工数量**。累计口径：该派工单全部有效报工（排除已撤销 revoked、被取代 supersedes 链只计链尾）的 doneQty 之和。超报 → 信封 `rejected`（理由文案明确含数量对比），HTTP 201 信封语义（对齐仓内既有业务拒绝形态）。
- **明确不做**（防扩盘）：S14 源文档精算公式（上道闸门 R_prev/Q_prev、外购加工半成品预占+收货双上限）是 PRD 已登记待实现差异（17 册 RQ-031/D-RQ 族），不在本修复内——本修复只做"≤派工数量"这一道基础闸门。
- **写入面**：`packages/application/src/reporting/**` + 测试。
- **测试锚定**：派 10 报 11 拒；派 10 报 6+4 过；报 5 撤销后再报 6 过（累计口径排除撤销）；修正版链不双计；batch 混合总量超限整批拒（对齐批量整批校验语义）。

## W4-2（=D-3，P1）附件内容持久化

- **解锁条件**：fix-wave-2 回传（attachment 域静止）。
- **缺陷证据**：SaaS 报告 D-3——附件内容存内存 store，重启后丢失，download-reference 502。
- **修复方案（定向，最小写入面）**：为 `ObjectStoragePort` 新增 **PG 适配器实现**（新文件 `packages/business-store/src/attachment/pg-object-storage.ts`：附件字节存 PG 表，bytea，带 32MiB 护栏与 RLS 租户收口）+ 组合根装配按环境切换（PG 形态用 PG 适配器，内存形态保留现状作零 DB 演示回落）。**不改动 attachment 域主体**（HMAC 引用、穿越防护、元数据链全部不动）。
- **注意**：新表要进 RLS_TABLES 守恒清单（business-store rls 生成器 + rls-conformance 复证）；迁移编号顺延当前最新槽位。
- **写入面**：`packages/business-store/src/attachment/**`（新文件+迁移）+ `apps/server` 装配切换行 + 测试。
- **测试锚定**：上传→重启进程→下载同字节；32MiB 护栏；跨租户读拒；内存回落形态不回归。
- **容器复证**：总控统一跑（上传→docker restart server→下载 200）。

## 明确不做

D-4/D-5 等已在 wave-2；PRD 增补登记归收口总控；对象层租户前缀（接 MinIO/S3 时）是另一欠账不在本波。
