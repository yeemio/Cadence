/**
 * 大屏前端路由表（O-1 修复：前端路由与 API 路径冲突）。
 *
 * == 前缀取舍（写明） ==
 * 旧路由 /screen/digital-operation 与后端 API `GET /screen/digital-operation`
 * 完全同路径——直接打开/刷新时 web nginx（location / try_files 未命中静态
 * 文件 → @server 反代）把页面请求递给后端，回 401 JSON（应用内导航正常，
 * 因 SPA 客户端路由不经过服务器）。修复 = 前端路由整段搬家到 /bigscreen：
 *  - 取 /bigscreen 弃 /screen/view：/screen/view/:scene 仍住在 /screen 前缀
 *    里，后端 API 命名空间（nginx 不做前缀分流，整段 /screen/* 反代语义）
 *    与前端呈现面继续同住一个屋檐——未来后端新增 /screen/view/* 端点即再次
 *    冲突；/bigscreen 让 /screen/* 整段归 API、/bigscreen/* 整段归页面，
 *    命名空间级分离（retest-e0eabfc O-1 建议同款）。web nginx /screen 反代
 *    不动——API 归 API。
 *  - 不做 /bigscreen/:scene 参数通配：当前唯一场景 digital-operation，通配
 *    会把任意垃圾路径渲染成同一页（不诚实）；后续新场景加显式路由即可。
 *
 * == 已知边界（非本修复面） ==
 * MPA 形态（appType: 'mpa'）不做 SPA history fallback：直接打开/刷新
 * /bigscreen/... 在容器里仍会经 nginx @server 反代到后端得 404 JSON（与
 * 桌面深链同类，/m 先例的窄域回落 location 由 nginx.conf/vite.config 承担，
 * 不在本次写入面——是否加 /bigscreen 窄域回落归总控/Owner 决策）。本修复
 * 闭合的是「与 API 路径重叠 → 401 JSON + 未来权限面歧义」这一冲突类。
 */

/** 大屏前端路由前缀（与后端 API /screen/* 命名空间彻底分离）。 */
export const SCREEN_ROUTE_PREFIX = '/bigscreen';

/** 场景标识：digital-operation（数字运营大屏；新场景在此登记 + main.tsx 加路由）。 */
export const SCREEN_SCENE_DIGITAL_OPERATION = 'digital-operation';

/** 场景 → 页面路由（显式清单制，不做通配——取舍见文件头）。 */
export function screenPageRoute(scene: string): string {
  return `${SCREEN_ROUTE_PREFIX}/${scene}`;
}
