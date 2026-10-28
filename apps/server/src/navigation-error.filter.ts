/**
 * 浏览器文档导航错误呈现过滤器（UX 缺陷批 UX-VW-04 / UX-VW-03 / UX-WH-13）。
 *
 * 背景：SPA 与 API 同源部署，页面路由与 API 路径同名撞车（/inventory/warehouses、
 * /inventory/stock 既是菜单页面路由又是 API 路由）。浏览器深链未被 web 反代层
 * （apps/web/nginx.conf）回落进 SPA 时直击 server：
 *   - 未认证 → 401 裸 JSON（此前正文还泄漏 dev/test 回落开关名——该文案已在
 *     auth.guard.ts 源头清除）；
 *   - 未知路径 → Nest 默认 404 英文技术串（"Cannot GET ..."）。
 * 本过滤器按**请求形态**分流，只改呈现层：
 *   - 浏览器文档导航（Accept 含 text/html）：按状态语义渲染中文可读 HTML 错误页
 *     （401 需要登录 / 404 页面不存在），正文不含任何内部开关名、环境变量名、
 *     协议头名等技术细节；
 *   - API 请求（fetch/XHR/脚本，Accept 不含 text/html）：Nest 默认体逐字段透传
 *     （getStatus() + getResponse()）——API 消费方 401/404 响应形状零回归
 *     （web apiClient 依赖 body.message 弹 ApiError）。
 *
 * 边界（M2 安全批域不动）：不触碰鉴权判定、不改状态码语义、不放宽任何 guard
 * ——401/404 原状态保留，仅呈现分流。SPA 深链回落（导航进 SPA 由前端路由处理
 * 登录/权限/404）的第一落点在 web 反代层 nginx；本过滤器是 server 直连形态
 * （SaaS 子域反代直达 server 等拓扑）的可读兜底——server 容器无 SPA 静态资源，
 * 无法回退 index.html，故导航回退为中文错误页而非 SPA。
 *
 * 波及面（有意收窄）：@Catch 仅 UnauthorizedException 与 NotFoundException——
 * 全仓唯一 UnauthorizedException 抛点是 AuthGuard 缺凭据路径；域内"实体不存在"
 * 走各自领域错误类（application 包零 Nest NotFoundException），不受本过滤器影响。
 * 其余 HttpException（403 拒权等）呈现属其他缺陷项（UX-VW-02 等），不在本批。
 */
import {
  Catch,
  HttpException,
  NotFoundException,
  UnauthorizedException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';

interface MinimalRequest {
  readonly headers?: Record<string, unknown>;
}

interface MinimalResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  send(body: string): unknown;
  json(body: unknown): unknown;
}

/** 请求是否浏览器文档导航（Accept 含 text/html；fetch/XHR 缺省 Accept 为任意通配，不命中）。 */
function isDocumentNavigation(request: MinimalRequest | undefined): boolean {
  const raw = request?.headers?.['accept'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.includes('text/html');
}

/** 导航错误页骨架（中文可读；零内部细节；无站内链接——server 直连形态无页面可回）。 */
function renderNavigationErrorPage(title: string, description: string): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title></head>`,
    '<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">',
    `<h1>${title}</h1>`,
    `<p>${description}</p>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** 按状态语义取文案（401 需要登录 / 404 页面不存在；其余状态不进本过滤器）。 */
function navigationPageOf(status: number): string {
  if (status === 401) {
    return renderNavigationErrorPage(
      '需要登录',
      '您尚未登录或登录状态已失效，请从系统网页端登录后再访问该功能。',
    );
  }
  return renderNavigationErrorPage(
    '页面不存在',
    '该地址不是有效的功能页面，请从系统网页端登录后经导航菜单进入。',
  );
}

@Catch(UnauthorizedException, NotFoundException)
export class NavigationErrorFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const request = host.switchToHttp().getRequest<MinimalRequest>();
    const status = exception.getStatus();
    if (!isDocumentNavigation(request)) {
      // API 请求：Nest 默认体逐字段透传（形状零回归——web apiClient 读 body.message）。
      response.status(status);
      response.json(exception.getResponse());
      return;
    }
    // 浏览器文档导航：中文可读错误页（状态原样保留，仅呈现分流）。
    response.status(status);
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.send(navigationPageOf(status));
  }
}
