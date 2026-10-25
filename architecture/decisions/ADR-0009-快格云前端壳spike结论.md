# ADR-0009 快格云前端壳 spike 结论：参照，不复用代码

状态：accepted（2026-10-24 spike 完成，总控验收）
来源：决策簿 D14 待评估项；完整证据见归档报告
`/Users/yeemio/AI/project/S-mes/快格云前端壳spike报告V1.0.md`（评估对象 kuaigeyun-mes @ commit 32c46b01）

## 背景

D14：kuaigeyun-mes 前端（Apache-2.0，React18+Vite+AntD6）与已采纳的插件装配模式同源，
声称选择性复用登录/布局/菜单可省 15~20 人日。须与 ADR-0006（shadcn/ui，AntD 出局）对表。

## spike 证据（要点）

- 壳层是 AntD 深度巨石：BasicLayout 3651 行（`src/layouts/BasicLayout.tsx:7` 起 ProLayout 承担整个壳）、
  登录页 3162 行；全仓 48.4% 文件依赖 AntD 系——"搬布局"等于"搬 AntD"，无中间态
- 许可证：根 Apache-2.0 干净（LICENSE:190 版权 2025 无锡快格）；但依赖树专域混入
  GPL/AGPL/LGPL/商业包（libredwg / altium-toolkit / circuitjson / occt / @univerjs-pro）——
  壳层本身零违禁依赖，整仓 install 会拉入违禁包
- 真正的金矿是纯逻辑与数据结构：`src/utils/permission.ts`（286 行菜单 RBAC 过滤语义）、
  DB 应用注册表 manifest 契约（`src/services/application.ts:9-37`）、动态路由装配约定
  （`AppRoutes.tsx:308-344`）、会话保活行为规则（app.tsx:457-519）、登录 MPA 隔离、pro 占位降级

## 决定

**参照：零代码复用、零依赖引入。**

照抄形状（方法论与数据结构，不受版权保护）：
- 应用 manifest 字段集与嵌套（code / entry_point / route_path / menu_config / is_pro / market_category）
- 四层应用契约与装配交互序列；菜单 RBAC 过滤语义（空壳隐藏 / hideInMenu / 精确权限码 / admin bypass）
- 会话行为规则（主动续期 / 网络失败不清会话 / 空闲仅在页面可见且无请求时累计）
- 登录独立 MPA 入口；pro 占位降级；menu-crawl / perf-shell-load 的 e2e 思路

明文排除：
- 不引入任何 antd / @ant-design 包（ADR-0006）
- 不整仓 fork、不复制任何源文件进 Cadence
- 未来若需代码级复用，须 Owner 另行定案并附 Apache-2.0 归属文件
  （来源 commit、版权声明、修改声明、RiverEdge 商标回避）

## 后果

- D14 人日记账修正：净节省保守 4~6 / 乐观 8~12 人日（原声称 15~20 不成立——其隐含直接搬 AntD 代码，被 ADR-0006 阻断）
- M1 前端壳基线按"从零 + 参照形状"排期：登录 2~3 pd、布局+动态菜单 3~5 pd、路由守卫 1~2 pd、应用装配骨架 2~3 pd
- refine 无头模式与其 react-query/zustand 基座无冲突；其手写 AuthGuard 属第二套范式，不照搬
