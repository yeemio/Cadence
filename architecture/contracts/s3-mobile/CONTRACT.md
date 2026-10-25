# S3 泳道合同：移动呈现缺口清零（§3.2 19 项 + §3.4 #116）

冻结：2026-10-25 夜｜线：zcode-cadence-s3-mobile（第三线，RunKit 双线账本 WI 模型单 assignment 不收第三线，协调事实以本文件 + status.md 为准）｜上游：coverage-matrix.md §3.2（`architecture/coverage/coverage-matrix.md:283-288`）

## Goal / Done-when

109 项端到端口径下的移动呈现缺口清零：矩阵 §3.2 的 19 项 + §3.4 #116（报工记录移动列表，与 #136 同源）全部有可导航到达的移动页面，页面动作打真实后端端点、权限码与对应后端 `@RequirePermission` 同码；product-ui 视图模型测试 + web 侧相关测试绿。矩阵刷新后这些项的"移动呈现"列应可判已实现。

## 非目标

- 不做桌面页（S2 泳道在途）、不改任何后端、不新增运行时依赖。
- 不动离线队列语义（页面可复用既有 OfflineQueue/reportingApi 模式，但不扩展其语义）。
- 不做浏览器实览走查（留 Owner/M5 正式线，沿 M5 首波先例）。
- 不动 main.tsx / menu.ts / shell/**（S2 正在写）——路由接线由本线总控在 S2 静止后追加（见"延期项"）。

## 页面清单（19+1 项 → 11 页，同源项合并）

| 页码 | 覆盖项 | 后端端点（矩阵证据锚点） |
|---|---|---|
| m.verify | 111-114 四类报工核查 | GET /reports/pending-verification（reporting.test.ts:708）、POST /reports/:id/verify（:544） |
| m.parts | 117 配件申请 | POST /workorder/parts-requests（workorder.test.ts:280） |
| m.parts-approval | 118 配件审批 | POST /workorder/parts-requests/:id/approval（approve/reject）+ 待审列表端点（读 workorder 控制器实态） |
| m.inspection | 119-122 四类质检 | inspection orders 列表 + judge/recheck（inspection.test.ts:365-592） |
| m.fault | 127 故障上报 | POST /baseline/fault-reports/commands（fault-report.test.ts:64） |
| m.receipt | 128-130 三类入库 | POST /inventory/stock/receipts（inventory.test.ts:323-565） |
| m.transfer | 132 调拨和移库 | POST /inventory/stock/transfers |
| m.stocktake | 133 库存盘点 | stocktake 四态 API（读 inventory 控制器实态） |
| m.progress | 134 工作令进度查询 | GET /workorder/:id/progress |
| m.op-progress | 135 图号/工序进度查询 | GET /reporting/drawings/:drawingNo/operation-progress（reporting.test.ts:717） |
| m.mine | 136 我的报工 + 116 记录列表 | GET /reports/mine（reporting.test.ts:698） |

导航形态：底部主标签 ≤5 不变（工作台/报工/工时/库存），新页入口走 m.workbench 快捷区 + `MOBILE_MENU`/`mobileRoutes` 注册表扩展（mobile.ts 自述"扩展为增页不是建壳"）。页面码遵守 ADR-0010 通用词纪律（verify/parts/inspection/fault/receipt/transfer/stocktake/progress/mine 均为通用词，m. 前缀为路由组命名空间）。

## 写入面（同树并行纪律：S1/S2/S4 在写其它区域）

允许：`apps/web/src/mobile.ts`、`apps/web/src/pages/m/**`、`apps/web/src/pages/m/` 下新建 API 薄层（或 `apps/web/src/data/mobile-ops.ts` 新文件）、`packages/product-ui/src/**` 新增视图模型文件 + `index.ts` 导出行、两侧 tests。

禁止：`apps/web/src/main.tsx`、`apps/web/src/menu.ts`、`apps/web/src/shell/**`、`apps/web/src/data/*Api.ts` 既有文件、`apps/web/src/pages/` 非 m 目录、packages/business-store、packages/application、apps/server。

实施者身份登记：code-writer-pro（GLM-5.3）+ 子代理会话 ID，回传 changed paths 与检查结果。

## 验证口径（局部）

- `packages/product-ui` 全测试 + tsc；
- `apps/web` 仅跑移动/菜单相关测试文件（如 mobile/menu 相关 *.test.ts），不跑全仓 verify、不跑 web 全量 build（S2 WIP 同树在途，合流由 S 波总控统一收口——沿 M2 波次惯例）。

## 延期项（本线总控收口时处理）

1. main.tsx 的 /m 路由组件接线（S2 静止后追加，单点小改）；
2. status.md 登记本线条目 + 覆盖矩阵刷新协作（矩阵刷新归 S 波总控，本线提供 19+1 项呈现证据）。

## 最高风险失败模式

同树并发写共享文件导致 S2/W3 互相覆盖——靠上述目录级隔离与禁改清单防；实施中发现允许路径已有他线同名文件，停手上报，不合并不改写。

## 可观察停止条件

11 页全部落地、逐项对照表完成、局部测试绿即停；不做超出 19+1 项范围的顺手扩展。
