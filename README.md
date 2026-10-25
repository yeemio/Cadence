# Cadence —— S-mes 重构 monorepo

机加工 MES 清洁室重建（代号 Cadence）。战略、决策链与全部背景见唯一事实源：

- **交接文档**：`/Users/yeemio/AI/project/S-mes/HANDOFF-重构交接V1.0.md`
- **技术选型决策簿**：`/Users/yeemio/AI/project/S-mes/03-产品用/S-mes重构技术选型决策簿V1.0.xlsx`
- **本仓宪法**：`architecture/decisions/`（ADR-0001 ~ 0008）+ `architecture/contracts/`

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

M0 立桩（12 人日，2026-10-24 开始）。进度看 `architecture/status.md`。
