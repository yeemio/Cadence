# Cadence —— 自研机加工 MES 产品

面向机加工与装配企业的制造执行系统，支持单租户私有化与多租户 SaaS 交付。当前产品管理入口：

- [产品合同](architecture/PRODUCT_CONTRACT.md)：产品目标、完成条件、架构约束和责任。
- [全生命周期地图](architecture/PRODUCT_LIFECYCLE_MAP.md)：当前阶段、证据、遗留与未验证边界。
- [路线图与任务索引](architecture/ROADMAP.md#pm-current-tasks)：当前目标项、责任和下一动作。

原始战略与技术决策来源保留如下，后续状态及 Owner 裁决按上述当前入口追溯：

- **交接文档**：`/Users/yeemio/AI/project/S-mes/HANDOFF-重构交接V1.0.md`
- **技术选型决策簿**：`/Users/yeemio/AI/project/S-mes/03-产品用/S-mes重构技术选型决策簿V1.0.xlsx`
- **本仓宪法**：[架构索引](architecture/README.md)、`architecture/decisions/`、`architecture/contracts/`

## 仓库骨架

```
architecture/          ADR + 边界合同 + status（CI 强制纪律）
packages/
  business-core/       纯领域：品牌化 ID、CommandEnvelope、事件基类、证据标准（无框架依赖）
  application/         按九循环环节分模块（workorder/listing/dispatch/reporting/inspection/
                       inventory/hours/costing/baseline）—— M2 落地
  business-store/      PostgreSQL 16 + Prisma —— M1 落地
  product-ui/          React 视图模型（shadcn/ui 之下）—— M1 起落地
  integration-im/      企微/飞书 IM 适配（IMessageChannel）
  integration-connect/ /connect/v1 只读连接器（OwlCodaE 消费）
  integration-print/   pdfmake / TSPL 打印
  integration-scan/    三档扫码降级链
  engine-flow/         审批流配置（XState 之上）
  engine-reporting/    口径驱动报表
  testkit/             测试工具
apps/
  server/              NestJS 组合根 —— M1 落地
  web/                 React + Vite + PWA —— M1/M5 落地
```

依赖铁律：`business-core <- application <- store/ui/integrations/engine`，apps 只做组合。
由 `dependency-cruiser` 机器强制（`.dep-cruiser.cjs`），CI 违规即红。

## 命令

```bash
pnpm install
pnpm verify          # typecheck + 边界铁律 + 铁律自检 + build + test
```

## 纪律红线（清洁室）

- 零搬运：不复制现系统任何代码 / SQL / 配置 / 模板（含 blade-* 脚手架）
- 生成输入只用本仓规格源；`AI/gitrep/sieracMes-AI/docs/开发文档/` 的 73 份雇主文档**禁用**
- 许可证白名单 MIT / Apache-2.0 / BSD / PostgreSQL License；GPL / AGPL 全线禁入
- 未经 Owner 指令不 commit、不 push

## 当前阶段

截至 2026-11-03：**M1 已收版（`v1.0.0`）；M2 可交付候选已于 2026-10-31 按约定范围整体 ACCEPT；真实客户试点/M3 尚未启动。** 接受对象的 13 份手册、3 份 PM 事实源和 2 份技术接收/范围说明已在 `5425feb93856772c728ffb482b18bced5eb88558` 正式封存，共 18 文件；该提交没有改变产品、Compose 或依赖字节，产品源码沿用 `0425ded838a87b8aeab3cfc300097a985bde2bd2`。PM 文档内“手册尚未提交”是原裁决时点，不能据此认定封存后仍未合入。

M2 接受不等于真实客户部署或业务接受。IAB PDF 实际显示仍为 NOT_ACCEPTED、根因 UNKNOWN；真实历史客户/共享成本数据和生产图纸质量仍 UNVERIFIED。D-18、P2-3/O5 等保留项按[生命周期地图](architecture/PRODUCT_LIFECYCLE_MAP.md)和[决策队列](architecture/DECISIONS-QUEUE.md)追溯；原共享 19 项的历史分布不倒写。有效短签名直接打开、中文完整/英文骨架的既有裁定保持。

当前工程工作是 Owner 已授权的六个分类 PR 修复，不因此重开全部 M2 验收或自动进入 M3。请从 [START-HERE](START-HERE.md) 的当前入口进入；各 PR 的候选、验证和接收分别成立，未合入主线的修复不能称为 main 已完成。具名客户、岗位、数据授权与商业范围仍由 Owner/PM 按职责决定。

以下 S3 记录保留为历史工程进展，不作为当前产品阶段或完成比例。

S3-a（2026-10-25）：S1 backfill 端点接页面——主数据/审计/标准报表七页挂载
（客户/供应商/计量单位挂基础数据组，机构/岗位/操作日志挂系统管理组，标准报表
单页按 MetricResult 自描述动态生成行列）；新权限码入菜单与 DEMO_IDENTITIES；
web 103 测试 + product-ui 111 测试 + typecheck/build/depcruise（1116 模块零违规）
全绿，登录 chunk 2.4KB。

S3-d（2026-10-25）：移动呈现 19 项收口（覆盖矩阵 §3.2 全部 + §3.4 #116 兼解）——
11 移动子页挂进 MOBILE_PAGE_BY_CODE（m.verify/m.parts/m.parts-approval/m.inspection/
m.fault/m.receipt/m.transfer/m.stocktake/m.progress/m.op-progress/m.mine），入口走
m.workbench 快捷区（底部四标签 ≤5 合同不变，子页不进标签栏）；读取面走
data/mobile-ops.ts 视图模型，命令面复用 S2 各模块 API。DEMO_IDENTITIES：operator
增授 parts:request/fault:report（工人动作码，桌面可见面不变），新增演示班长
lead@demo.local（16 码动作承载身份）。19 项对照：

| 项 | 页 | 就绪口径 |
|---|---|---|
| 111-114 四类报工核查 | m.verify | 待核查队列 + verify 命令（四类 kind 徽标区分） |
| 117 配件申请 | m.parts | 申请表单（建单即 submitted 待审） |
| 118 配件审批 | m.parts-approval | 待审队列 + 批准/拒绝（理由必填同后端口径） |
| 119-122 四类质检 | m.inspection | kind 过滤队列 + 判定/复检（放行联动入库） |
| 127 故障上报 | m.fault | 上报表单（上报即派修，IM 推送后端承担） |
| 128-130 三类入库 | m.receipt | 三源收货表单（放行/收货幂等键/完工） |
| 132 调拨和移库 | m.transfer | 跨仓调拨/仓内移库同命令表单 |
| 133 库存盘点 | m.stocktake | 台账 + 详情 + 开单/实盘录入/审核调账全径 |
| 134 工作令进度查询 | m.progress | id 查询计划 vs 实际 + 里程碑 |
| 135 图号/工序进度查询 | m.op-progress | 图号查净报工聚合 |
| 136 我的报工（+116 记录） | m.mine | 本人双键记录列表（五类 kind × 四态） |

全部"就绪"（核心操作面按桌面能力与端点实态裁剪，非桌面全功能复刻；查询页
只读列表无写面）。web 107 测试 + product-ui 112 测试 + typecheck/build 绿；
depcruise 局部（web+product-ui 163 模块）零违规；登录 chunk 2.41KB。
