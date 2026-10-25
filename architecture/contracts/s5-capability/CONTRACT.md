# T 波合同：5 项能力子集收口（§3.4 #1/98/99/101/102）

冻结：2026-10-25 深夜｜总控派发（Owner 指令"有活就派"）｜基线：coverage-matrix.md §3.4（297-305 行）

## Goal / Done-when

109 口径最后 5 项缺口落地：#98/99 菜单管理 CRUD、#102 审批配置端点、#101 通知中心后端（T1）；#1 运营总览聚合页（T2）。每项=真实后端端点/页面+测试锚点；接线（app-registry/menu.ts/assembly.ts/main.tsx/事件发布钩子）统一归合流，不在本波。

## T1 后端三面（code-writer-pro）

- **#98/99 菜单管理**：菜单配置持久化（节点树存取+期望态更新端点），读实态定权限码
- **#102 审批配置**：engine-flow 状态机配置 CRUD+校验端点（approval 域）
- **#101 通知中心**：站内收件箱模块（list/unread-count/mark-read/mark-all-read 端点+store+NotificationSource 端口）；既有事件点（点名/派修/IM）的发布钩子接线=合流单行，不做
- 写入面：packages/application/src 新目录（menu-config/approval-config/notifications）、business-store 对应新 store+schema.prisma 新 model+rls/tables.ts 补登+迁移、两侧 tests。禁改：既有模块源码、apps/server、apps/web、共享接线文件
- 验证：application+business-store 局部测试+tsc 绿即停

## T2 运营总览页（code-writer-pro）

- product-ui `overview-views.ts`：聚合四源（/workbench/summary、/workorder/delivery-situation、/inspection/summary、/hours/machining/stats）→ 总览卡片+下钻分组，纯函数+测试
- apps/web `pages/overview/IndexPage.tsx` + `data/overviewApi.ts`（新文件）
- 写入面：仅上述新文件。禁改：menu.ts/assembly.ts/main.tsx/shell/**/data 既有文件（接线归合流）
- 验证：product-ui 测试+tsc、web 新测试单跑绿即停

## 共同纪律

零新增运行时依赖；不 commit/push；遇 429 退避重试；同树并行（S2/S3-a 在写 apps/web 其它区、S1 验收在读后端）——发现冲突停手上报；实施者身份回传（代理+模型+会话 ID）。

## 停止条件

T1 三面 CRUD/端点/测试绿；T2 页+视图模型+测试绿。均不含接线。
