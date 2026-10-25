// product-ui 视图模型公共面（ADR-0006/0009/0010）。UI 装配在 apps/web。
export type { PermissionCode } from './permissions.js';
export {
  ADMIN_PERMISSION,
  isAdminPermissions,
  isPermissionCode,
  permissionCode,
} from './permissions.js';
export type { AppModuleManifest, MarketCategory, MenuConfig } from './manifest.js';
export type { MenuNode, MenuRoute } from './menu.js';
export {
  buildMenuTree,
  filterMenuByPermissions,
  flattenRoutes,
  toSidebarMenu,
} from './menu.js';
export type { MockIdentity, MockSession, SessionStore } from './session.js';
export {
  authenticateMockIdentity,
  createBrowserSessionStore,
  createMemorySessionStore,
  DEFAULT_SESSION_STORAGE_KEY,
  DEMO_IDENTITIES,
} from './session.js';
export type { MockAuthProviderOptions } from './auth.js';
export {
  createMockAuthProvider,
  sessionHasPermission,
  toPermissionCodes,
} from './auth.js';

// ---- 真实认证（M1 收尾波-③）：token 会话 + 注入式传输层的 authProvider ----
export type { TokenSession, TokenSessionStore } from './token-session.js';
export {
  createBrowserTokenSessionStore,
  createMemoryTokenSessionStore,
  isTokenSessionExpired,
  parseTokenSession,
  TOKEN_SESSION_STORAGE_KEY,
} from './token-session.js';
export type {
  AuthSessionPayload,
  AuthTransport,
  TokenAuthProviderOptions,
} from './auth.js';
export {
  AuthRejectedError,
  createTokenAuthProvider,
  toTokenSession,
} from './auth.js';

// ---- 组织管理视图模型（M1 增量 3-D） ----
export type { OrgRoleView, OrgUserView } from './org.js';
export {
  ORG_ROLE_READ,
  ORG_ROLE_WRITE,
  ORG_USER_READ,
  ORG_USER_WRITE,
  OrgViewError,
  buildCreateRolePayload,
  buildCreateUserPayload,
  buildPermissionCodesPayload,
  buildRoleNamesPayload,
  parseOrgRolesResponse,
  parseOrgUser,
  parseOrgUsersResponse,
} from './org.js';

// ---- 基础数据视图模型（M1 增量 4-I） ----
export type { ItemView, ResourceView } from './masterdata.js';
export {
  ITEM_READ,
  ITEM_WRITE,
  RESOURCE_READ,
  RESOURCE_WRITE,
  MasterdataViewError,
  buildCreateItemPayload,
  buildCreateResourcePayload,
  parseItem,
  parseItemsResponse,
  parseResource,
  parseResourcesResponse,
} from './masterdata.js';

// ---- 工作台/待办视图模型（M1 增量 4-I） ----
export type { TodoSourceCountView, TodoView, WorkbenchSummaryView } from './workbench.js';
export {
  buildCreateTodoPayload,
  parseTodo,
  parseTodosResponse,
  parseWorkbenchSummaryResponse,
  TODO_WRITE,
  WORKBENCH_READ,
  WorkbenchViewError,
} from './workbench.js';

// ---- 工时视图模型（M5 首波：移动端我的工时页） ----
export type { MyHoursDayView, MyHoursView } from './hours.js';
export {
  HOURS_READ,
  HoursViewError,
  parseMyHoursResponse,
} from './hours.js';

// ---- 库存视图模型（M5 首波：移动端库存查询页） ----
export type { StockLevelView } from './inventory.js';
export {
  InventoryViewError,
  parseStockLevelsResponse,
  STOCK_READ,
} from './inventory.js';

// ---- 扫码会话视图模型 + IM 容器识别（M1 收尾波-②；泛型消费边缘包形状，ADR-0011） ----
export type {
  ImContainerKind,
  ImContainerProbeInput,
  ScanDegradationEntry,
  ScanSessionModel,
  ScanSessionModelOptions,
  ScanSessionState,
  ScanSessionStatus,
} from './scan.js';
export { createScanSessionModel, detectImContainer, SCAN_READ } from './scan.js';

// ---- 离线策略纯形状（M5 预研：离线队列 + 网络状态事件流） ----
export type {
  BrowserNetworkSource,
  EnqueueOutcome,
  EnqueueResult,
  NetworkEvent,
  NetworkEventKind,
  NetworkSnapshot,
  NetworkStateModel,
  OfflineQueue,
  OfflineQueueEntry,
  OfflineQueueOptions,
  ReplaySummary,
} from './offline.js';
export {
  connectBrowserNetworkState,
  createNetworkStateModel,
  createOfflineQueue,
  hydrateOfflineQueue,
  OFFLINE_QUEUE_STORAGE_KEY_PREFIX,
  offlineQueueStorageKey,
} from './offline.js';
