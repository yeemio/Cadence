# Cadence 当前工作入口

更新：2026-11-03。M2 可交付候选已按范围接受，已接受的 18 文件在
`5425feb93856772c728ffb482b18bced5eb88558` 正式封存。真实客户部署、业务接受和 M3
尚未启动；不要把下方历史泳道指令作为当前授权。

先读当前事实源：

1. [产品合同与最终 M2 接收](architecture/PRODUCT_CONTRACT.md#m2-pm-reception-r2-20261031)：产品范围、责任与接受边界。
2. [生命周期地图](architecture/PRODUCT_LIFECYCLE_MAP.md)：有效证据、保留项和未验范围。其“尚未提交”按原裁决时点理解，后续 Git 封存见上方 SHA。
3. [路线图当前任务索引](architecture/ROADMAP.md#pm-current-tasks)及[决策队列](architecture/DECISIONS-QUEUE.md)：唯一执行总控与 Owner/PM 决定的入口，不另建第二主控。

## 当前已授权的分类修复（2026-11-03）

Owner 已将以下六个既有 PR 一次性交由同一普通 Chat 作为唯一代码作者，自主安排依赖、修复和验证；总控核实并最终接收。GitHub 集成不能写入时，总控按既有授权机械发布同一作者的冻结候选。无需逐 PR 等待 ACK，不创建新 Work/Chat/实施代理。

| PR | 问题与范围 |
| --- | --- |
| [#1](https://github.com/yeemio/Cadence/pull/1) | F1/F8：图纸响应投影与签名兑现入口 |
| [#2](https://github.com/yeemio/Cadence/pull/2) | F2/F3：会话撤销与升级权限保全 |
| [#3](https://github.com/yeemio/Cadence/pull/3) | F4：退货重收的采购/库存/质检一致性 |
| [#4](https://github.com/yeemio/Cadence/pull/4) | F5：转工序与批准排程一致性 |
| [#5](https://github.com/yeemio/Cadence/pull/5) | F6/F7：成本分类与失败重建完整性 |
| [#6](https://github.com/yeemio/Cadence/pull/6) | F9：根入口及阶段说明 |

具体写入面以各 PR head 的 `architecture/reviews/20261103/<组名>/TASK.md` 及 Owner 后续批次授权为准；代码、测试和交付必须回到对应原分支。PR 的 TASK 登记不代表代码修好，局部检查通过不代表整仓或真实客户通过。`main` 写入、merge、release、部署、共享/客户数据和 M3 不在本批授权内。原 M2 接受、IAB 空白未接受及真实样本未验边界保持。

## 历史记录：M4 部署期收尾线（lane/m4-final）

以下保留原开工记录；历史“新并行主线”、任务清单、写入面和模型/工具指令均不是当前执行授权。当前行动从上方事实源及六个分类 PR 进入。

你是 Cadence（S-mes 重构）的新并行主线。开工前按序读：
1. `architecture/status.md`——全程进度（M4 技术路径已全通：RLS/双形态/租户解析，本线做部署期收尾）
2. 本线任务（Owner 授权全部建议后划定）：
   - 双写去重五项（三线验收低危清单）：健康探针三处重复→镜像内单份脚本；rls-proof/rls-session-proof 脚手架抽共享 harness；rls-session.ts 头注陈旧修正；TenantResolutionError→4xx
   - 租户管理流程骨架（SMES_TENANTS 静态清单→异步查库 adapter 形状）；其余 14 家 connect* 工厂 RLS session 接线（ESCALATION-2 泳道）
   - 迁移工具实化（M4 合同后续波：现系统数据→新系统导入骨架；清洁室纪律 4：迁移数据≠复制实现）
3. 纪律：同 M5 线（清洁室/code-writer-pro+code-reviewer/PATH/install 已知项/不 push）
4. 协调：RunKit 账本对账 + status.md 黑板；deploy/** 与 apps/server/main.ts 为本线写入面
