/**
 * 租户解析失败 → 421 全局异常处理（M4 部署期收尾波；形态 = Express 全局
 * 错误中间件，非 Nest ExceptionFilter——取舍见下）。
 *
 * 为什么是 Express 4 参错误中间件而非 useGlobalFilters：hostBasedTenantResolver
 * 在租户中间件（app.use 注册）内同步抛 TenantResolutionError，属 Express
 * 中间件层异常——不进 Nest 路由与异常过滤器层（deploy/README 接缝记录：此前
 * 落 500）。Express 对同步中间件异常走 next(error) → 首个 4 参错误中间件——
 * 本处理器注册在该层（main.ts，租户中间件之后）。
 *
 * 状态码取舍（写明）：421 Misdirected Request（RFC 9110：请求被定向到无法为其
 * 产出响应的目标）——Host 不指向本栈已知租户，是"错误定向"而非服务器内部错误
 * （500 会让探针/网关把配置性问题误判为服务不健康）。不取 404：与域层"资源
 * 不存在"（drawing 同形 404 等）撞语义，无法区分"租户错"与"路径错"；不取
 * 400：请求语法本身合法。其余异常原样 next(error) 放行（保留既有路径：
 * body-parser 400 / Express 缺省 500 等不受影响）。
 */
import { TenantResolutionError } from '@smes/business-core';

/** 最小响应面（与各域错误过滤器的 MinimalResponse 同风格，零 express 类型依赖）。 */
interface MinimalStatusJsonResponse {
  status(code: number): { json(body: unknown): void };
}

/**
 * Express 全局错误中间件（4 参 = 错误形态，Express 据参数个数路由到本层）。
 * TenantResolutionError → 421 + 域过滤器同形 JSON 体；其余 next(error) 原样放行。
 */
export function tenantResolutionErrorHandler(
  error: unknown,
  _request: unknown,
  response: unknown,
  next: (err?: unknown) => void,
): void {
  if (error instanceof TenantResolutionError) {
    (response as MinimalStatusJsonResponse).status(421).json({
      statusCode: 421,
      error: 'Misdirected Request',
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  next(error);
}
