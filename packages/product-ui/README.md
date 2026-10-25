# @smes/product-ui

React 视图模型层（shadcn/ui 之下，ADR-0006；依赖铁律见 .dep-cruiser.cjs `ui-tier-edges`）。

职责（M1 骨架）：

- **应用注册表 manifest 形状**（`src/manifest.ts`）：字段集参照 ADR-0009（code / routePath /
  entryPoint / menuConfig / isPro / marketCategory），零代码复用。
- **菜单 RBAC 过滤纯函数**（`src/menu.ts`）：精确权限码匹配、admin bypass、空壳隐藏、
  hideInMenu 只留路由不进侧栏。
- **refine 无头 authProvider 形状与 mock**（`src/auth.ts`、`src/session.ts`）：
  login / check / logout / getPermissions 骨架；会话经 SessionStore 抽象，
  登录 MPA 入口与主壳共享存储、不共享 bundle。
- **扫码会话视图模型**（`src/scan.ts`，M1 收尾波-②）：泛型状态机（档位/降级链/
  结果），泛型消费边缘包形状（ADR-0011 依赖倒置）；含 IM 容器识别纯函数。
- **离线策略纯形状**（`src/offline.ts`，M5 预研）：`OfflineQueue<T>`（幂等键
  去重 keep-first、严格 FIFO 重放、失败保留原位、localStorage 序列化往返、
  drop-oldest 容量淘汰）+ `NetworkStateModel`（online/offline/restored 订阅式
  事件流）+ navigator 桥（结构注入）。取舍见该文件头注释。
- 品牌化 ID 复用 `@smes/business-core`（TenantId / UserId）。

不做什么：不引任何 UI 组件库预设（UI 在 apps/web 用 shadcn/ui 自持）；
不碰后端包（application 之外的后端件禁直连，由铁律强制）。
