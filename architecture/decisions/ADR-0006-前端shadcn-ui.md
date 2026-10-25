# ADR-0006 前端 shadcn/ui

状态：accepted（2026-10-23 Owner 定案，2026-10-24 入库）
来源：决策簿 V1.0 ADR-0006 / 交接文档 §4

## 背景

Owner 要求"现代化好看"——AntD 出局（且 AntD 与现系统 ElementUI 同属组件库思路）。
移动端须以同一代码 PWA 呈现（私有化部署下无应用商店依赖）。

## 决定

- React 18 + shadcn/ui + Tailwind v4 + TanStack（Table / Query / Form）+ Zod + Radix
- CRUD 数据层用 refine **无头模式**（headless）：路由 / 数据钩子 / 鉴权流成熟复用，UI 层 shadcn 自持
- 移动端：vite-plugin-pwa + 响应式 + 企微/飞书容器
- 备选 Mantine（MIT）——求更快出活时

## 后果

- shadcn 组件源码进仓（copy-in 模式），须随 Tailwind v4 版本管理
- AI 代理训练语料最丰富 = 施工效率红利
