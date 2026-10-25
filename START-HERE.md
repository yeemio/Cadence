# 新主窗口开工指南（M4 部署期收尾线，分支 lane/m4-final）

你是 Cadence（S-mes 重构）的新并行主线。开工前按序读：
1. `architecture/status.md`——全程进度（M4 技术路径已全通：RLS/双形态/租户解析，本线做部署期收尾）
2. 本线任务（Owner 授权全部建议后划定）：
   - 双写去重五项（三线验收低危清单）：健康探针三处重复→镜像内单份脚本；rls-proof/rls-session-proof 脚手架抽共享 harness；rls-session.ts 头注陈旧修正；TenantResolutionError→4xx
   - 租户管理流程骨架（SMES_TENANTS 静态清单→异步查库 adapter 形状）；其余 14 家 connect* 工厂 RLS session 接线（ESCALATION-2 泳道）
   - 迁移工具实化（M4 合同后续波：现系统数据→新系统导入骨架；清洁室纪律 4：迁移数据≠复制实现）
3. 纪律：同 M5 线（清洁室/code-writer-pro+code-reviewer/PATH/install 已知项/不 push）
4. 协调：RunKit 账本对账 + status.md 黑板；deploy/** 与 apps/server/main.ts 为本线写入面
