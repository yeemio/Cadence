/**
 * 浏览器 e2e 共享常量（配置 / 栈编排 / spec 三方唯一事实源）。
 *
 * 端口与既有 vitest e2e 错开（e2e-scan-report 55512/3597、e2e-module-chain
 * 55513/3598）——三套栈可在本机并存互不抢占。preview 端口避开 vite 缺省
 * 4173（防与本机常驻 dev/preview 撞车，strictPort 占用即失败）。
 */
import { fileURLToPath } from 'node:url';

/** 仓根（packages/testkit/e2e/scripts → 上溯四级）。 */
export const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** web 应用目录（vite preview 的 root）。 */
export const APPS_WEB = `${ROOT}apps/web`;

export const PG_PORT = 55514;
export const API_PORT = 3599;
export const WEB_PORT = 4280;

export const API_BASE = `http://127.0.0.1:${API_PORT}`;
export const WEB_BASE = `http://127.0.0.1:${WEB_PORT}`;
export const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/cadence`;

/** 与 e2e-scan-report / e2e-module-chain 同清单：core + 九循环 + org/masterdata/workbench/approval/demo。
 * T1 补登（2026-10-26）：+standardreports——走查 06 标准报表页需要口径目录端点
 * （无该模块 GET /standard-reports/metrics 404 → 求值按钮恒禁用）；PG 形态下
 * 四源由 main.ts 按 DATABASE_URL 装配，与模块开关正交。 */
export const MODULES =
  'core,workorder,baseline,listing,inspection,inventory,dispatch,reporting,hours,costing,org,masterdata,workbench,approval,demo,standardreports';

/** 一次性容器名（pid 后缀防残留占名）。 */
export const CONTAINER = `cadence-e2e-browser-${process.pid}`;

/** 截图与运行工件目录（绝对路径——playwright 截图 path 相对运行 cwd，显式钉死）。 */
export const ARTEFACTS = fileURLToPath(new URL('../artifacts/', import.meta.url));

/**
 * 种子演示管理员（prisma/seed.mjs；口令 demo-password）。
 * T1 修正（2026-10-26）：username 'admin' → 'demo-admin'——auth-setup 断言
 * 顶栏显示"演示管理员（Web 登录流）"，而 username 'admin' 是种子管理员
 * （displayName 种子管理员），spec 与 env 失配必红；两用户同持 admin 角色
 * （seed.mjs grant-role 两条），换用户不改变被测语义（真实登录流 + 主壳渲染）。
 */
export const DEMO_ADMIN = { username: 'demo-admin', password: 'demo-password' } as const;

/** RUN_E2E 门禁（与仓内 vitest e2e 同约定：缺省跳过，不依赖 docker）。 */
export const RUN_E2E = process.env['RUN_E2E'] === '1';
