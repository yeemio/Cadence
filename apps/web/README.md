# apps/web —— Web 工程壳（M1 增量 2-C / 3-D / 4-I）

ADR-0006（React 18 + Tailwind v4 + refine 无头 + react-router）+ ADR-0009
（登录独立 MPA 入口、菜单 RBAC 过滤语义参照）。视图模型在 `@smes/product-ui`，
本包只做工程壳与页面装配；依赖铁律 `web-via-ui`（.dep-cruiser.cjs）机器强制。

## 双入口 MPA

| 入口 | 路径 | bundle | 说明 |
| --- | --- | --- | --- |
| 主壳 | `/`（index.html → src/main.tsx） | refine + router + query + 主壳布局 | `Authenticated` 守卫，未登录跳 `/login` |
| 登录 | `/login`（login.html → login/main.tsx） | 最小 bundle（无 refine / 无 router / 无 query） | mock 凭据 → 写会话存储 → 整页跳 `/` |

两个入口只共享浏览器存储中的会话键（`cadence.session.v1`），不共享任何运行时状态。

## 命令

```bash
pnpm --filter @smes/web dev        # 开发服（/ 与 /login）
pnpm --filter @smes/web build      # 双入口构建（dist/login.html + dist/index.html）
pnpm --filter @smes/web preview    # 构建产物预览
pnpm --filter @smes/web typecheck
pnpm --filter @smes/web test
```

开发联调真实后端：`VITE_API_BASE_URL=http://localhost:3000 pnpm --filter @smes/web dev`
（组织管理页经薄数据层 `src/data/orgApi.ts` 直连 server `/org/*`，请求带
`x-smes-user` 会话身份头；不设则同源相对路径）。

## 装配关系

- `src/menu.ts`：演示应用注册表（manifest 形状见 product-ui）→ `menuTree` / `menuRoutes`
- `src/auth.ts`：`createMockAuthProvider` + localStorage 会话存储
- `src/shell/`：主壳布局（侧栏 = `toSidebarMenu` 权限投影；顶栏登出）
- `src/pages/`：模块占位页（含路由级权限守卫）与 404
- `src/pages/org/`（M1 增量 3-D）：用户管理页 + 角色与授权页（真实 API 数据，
  TanStack Query 直连；视图模型/权限码在 product-ui `org.ts`）
- `src/pages/scan/ScanPage.tsx`（M1 收尾波-②）：扫码页（`scan:read`，挂制造运营组）。
  web→integration-scan 首个消费边（ADR-0011）：能力探测 + `planScanChain` 降级链 +
  摄像头模式（html5-qrcode 经懒加载分块，点开才下载）/ 扫码枪模式（页面键盘串入监听）+
  IM 容器探测横幅（仅识别展示）。会话视图模型（档位/降级历史/结果/错误态）在
  product-ui `scan.ts`（泛型消费边缘包形状，边缘词汇不进业务层）
- `src/data/orgApi.ts`（M1 增量 3-D）：组织端点薄数据层（fetch + `x-smes-user` 头）
- 演示身份：`admin@demo.local`（全量）/ `org-admin@demo.local`（组织管理四码，
  精确码无通配）/ `operator@demo.local`（工作令+派工+工作台+物品查看+扫码，口令任意非空）

## 数据层取舍（M1 增量 3-D）

组织页选 **TanStack Query 直连**而非 refine dataProvider：org 端点是自定义
REST 形状（按角色的权限集合 PUT、按用户的角色集合 PUT——期望态 set 语义），
不是资源型 CRUD，dataProvider 的全协议面大半用不上且需造 meta 约定；
TanStack Query 对任意端点形状零假设，缓存/失效语义现成。QueryClient 只挂
主壳（登录 MPA 入口不受影响，登录 chunk 预算不变）。

## 非目标（后续增量）

真实鉴权后端对接（会话仍 mock；`x-smes-user` 头来源在 `src/data/orgApi.ts`
一处替换）、业务页面内容（M2）、响应式/移动布局打磨与性能验收（M5 正式线；
PWA/离线的形状预研已落地，见下节）、会话保活行为规则（ADR-0009 参照清单，M1 后续增量）。

## 增量 4-I 登记（基础数据 + 工作台）

- `src/pages/workbench/WorkbenchPage.tsx`：登录后首页（本人待办 + 按 source 计数 + 完成按钮，workbench:read）
- `src/pages/masterdata/ItemsPage.tsx` / `ResourcesPage.tsx`：物品/资源管理（列表+创建，item:read / resource:read）
- `src/data/apiClient.ts`：统一身份头与错误归一的薄数据层（masterdataApi / workbenchApi 复用；orgApi 沿 3-D 先例独立）

## M5 预研登记（PWA / 离线 / 扫码报工——三块形状，2026-10-25）

依据：ADR-0006（移动端同代码 PWA）+ ADR-0009 参照清单 + 决策簿 M5 定义
（"PWA/响应式/离线/扫码报工优化+性能验收"——本预研做前三者的形状，性能验收与
响应式打磨不做）。

### 1. PWA 可安装骨架（vite-plugin-pwa 2.0，MIT）

- `vite.config.ts`：generateSW 策略。manifest（name/短名 Cadence、standalone、
  theme 色 #18181b、SVG 几何占位图标——非品牌资源）；SW 生成 `dist/sw.js`。
- 缓存策略：导航请求 NetworkFirst（4s 超时）失败回退 precache 的离线壳页
  `/offline.html`（workbox `precacheFallback`）；静态资源（js/css/html/svg/
  webmanifest）precache。注意：插件默认 `navigateFallback: 'index.html'` 的
  NavigationRoute 会先于 runtime 路由注册、抢走全部导航——已显式置 null 关闭
  （取舍记录在 vite.config.ts 注释）。
- SW 注册：`injectRegister: 'inline'`，双入口 html 各内联一行（登录页也注册，
  SW scope '/' 全站一份）；`registerType: 'autoUpdate'`。
- **dev 模式禁用 SW**（`devOptions.enabled: false` 显式声明）：dev 下 SW 缓存
  会掩盖最新改动、与 HMR 打架；PWA 行为只对 build/preview 验证。
- 构建产物：`dist/manifest.webmanifest` + `dist/sw.js` + `dist/workbox-*.js` +
  `dist/offline.html` + `dist/icons/icon.svg`。

### 2. 离线策略形状（product-ui `src/offline.ts`，纯域）

`OfflineQueue<T>`（幂等键去重 keep-first / 严格 FIFO 重放、队头阻塞 / 失败保留
原位 / 序列化往返 localStorage 键 `cadence.offline-queue.v1.<name>` / drop-oldest
容量淘汰）+ `NetworkStateModel`（online/offline/restored 订阅式事件）+ navigator
桥。取舍与单测见该包 `tests/offline.test.ts`。

### 3. 扫码报工页（`src/pages/scan/`）

- `useScanSession.ts`：扫码段装配自 ScanPage 抽出（两页共用，不复制）；
- `ScanPage.tsx`：改用 hook，行为不变；
- `ScanReportPage.tsx`（`/scan/report`，权限码 `report:write`，挂制造运营组）：
  扫码→草稿表单（对象引用/数量/备注，纯前端状态）→ 提交分路（在线走 mock
  提交通道；离线或在线失败自动入 OfflineQueue 并持久化；恢复在线出提示条，
  手动"重放"驱动严格 FIFO 重放）；
- `reportDraft.ts`：提交载荷构造/守卫（纯形状，M2 对接点载荷）；
- `src/data/reportingApi.ts`：提交通道形状出口——mock 恒成功（250ms），M2
  对接点在该文件注释（换成 apiClient `request('/reports', ...)`，页面不改）。
- 页面码三问记录（ADR-0010）在 `ScanReportPage.tsx` 文件头：scan + report 均
  通用词（report 在内核白名单），路由 `/scan/report`、权限码 `report:write`。

## M5 首波登记（移动页面集对接真实后端，2026-10-25）

预研三块形状（PWA/离线/扫码报工）在本波接上 M2 真实 API，产出车间工人可用
的移动页面集（功能拆解 105~137 移动镜像项的呈现面——逻辑归各模块 API）：

- **移动路由组** `src/mobile.ts`（`MOBILE_MENU`/`mobileRoutes`）+ `src/shell/MobileLayout.tsx`：
  `/m/*` 底部标签导航壳（Authenticated 守卫 + 权限投影复用 `filterMenuByPermissions`），
  与桌面壳 ShellLayout 并列（main.tsx 按路径分流）。四页 `src/pages/m/`：
  | 页面码 | 路由 | 权限 | 后端 |
  | --- | --- | --- | --- |
  | m.workbench | /m | workbench:read | GET /workbench/todos（+快捷入口） |
  | m.report | /m/report | report:submit | POST /reports（CommandEnvelope） |
  | m.hours | /m/hours | hours:read | GET /hours/my?month= |
  | m.stock | /m/stock | stock:read | GET /inventory/stock?itemId= |
- **API 层真实化**：`src/data/reportingApi.ts` 预研 mock 通道已在正式线换
  `request('/reports')`（Bearer 会话头 + committed/rejected/indeterminate 三态归一）；
  本波补 `src/data/hoursApi.ts` / `src/data/inventoryApi.ts`（同 apiClient 通道），
  product-ui 补 `hours.ts` / `inventory.ts` 视图模型（解析器 + 权限码）。
- **报工页升级**（预研 /scan/report → m.report）：草稿补 `laborMinutes` 真实录入
  （预研缺省 1 分钟占位移除，`reportDraft.ts` 原位升级；校验对齐后端
  requireLaborMinutes）；离线链不变（在线直发 / 失败入队 / restored 提示重放，
  幂等键同源重放不产生重复报工）。桌面菜单移除预研 scan-report 条目。
- 测试：`tests/mobile.test.ts`（注册表/RBAC 投影）、`tests/mobile-api.test.ts`
  （hours/stock HTTP 接缝）、`tests/reporting-api.test.ts` / `tests/scan-report.test.ts`
  适配 laborMinutes；容器级报工链实证在 `tests/e2e-scan-report.test.ts`（RUN_E2E=1）。

### M5 正式线接缝（本预研不做）

响应式/移动布局打磨；推送通知；iOS 特化与 SW 复杂策略调优（BackgroundSync、
prompt 更新交互）；真实 reporting 后端对接（M2，接缝在 reportingApi 一处）；
性能验收 p95；多端编辑冲突解决；离线队列淘汰策略复核（drop-oldest 的替代项
与容量告警 UX）；manifest 真实图标（PNG 192/512——安装横幅在部分浏览器要位图）。
