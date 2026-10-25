# ADR-0003 架构向 OwlCodaE 靠拢

状态：accepted（2026-10-23 Owner 定案，2026-10-24 入库）
来源：决策簿 V1.0 ADR-0003 / 交接文档 §6

## 背景

Owner 指令"架构选型往 owlcodae 靠拢"。OwlCodaE 是 Owner 个人 IP 的 AI Business Execution
System（另一条独立线）。对齐层次 = 模式、目录、合同形状、纪律（方法论，不受版权保护）。

## 决定

**图纸对齐，零件各造，双向零代码复制**（OwlCodaE 代码不进本仓，本仓代码不进 OwlCodaE）。
八条模式级对齐：

1. 依赖铁律 `business-core <- application <- store/ui/integrations`，lint+CI 强制（.dep-cruiser.cjs）
2. 品牌化 ID：`Brand<T, Name>`，WorkOrderId/DispatchId/ReportId… 全部品牌化
3. CommandEnvelope（operationId + expectedRevision）→ smes.command.v1，与 product.v1 同构；
   expectedRevision = objectVersion 乐观锁
4. 不可变快照进业务事实：信封/事件构造即深冻结
5. append-only 账本：append-only 业务事件表 + Outbox
6. integration-* 边缘包独占外部 SDK（im / connect / print / scan）
7. architecture/ 目录（ADR + 合同 + status），CI 强制
8. work-* 版本化领域包 → 九循环环节模块 = 版本化 domain 模块

## 不靠拢项（粒度不同是正确标志）

- 领域模型不合并（交易对象 vs WorkCase 准入链）
- 不引入 ResultAdmission（工人报工是事实不是 AI 候选）
- 存储各异（PG vs FileBusinessStore）

## 后果

- 未来与 OwlCodaE 的 snap-in 集成（/connect/v1）提前铺好合同形状
- 依赖铁律有反例自检（scripts/boundary-selftest.mjs）：拦不住违规的铁律视为不存在
