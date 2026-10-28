/**
 * AuthGuard —— 全局鉴权守卫（M1 增量 2-B；收尾波-③ 真实认证改造）。
 *
 * 身份解析（优先级与语义写明）：
 *  1. 生产路径：`Authorization: Bearer <token>` → AuthService.resolveSession
 *     （会话有效 → 身份 + 租户）。会话租户必须与 TenantContext 当前租户一致
 *     （单租户形态恒同；不一致 = 无效凭据）——多租户形态在 M4 由租户解析器
 *     从会话侧统一（本守卫只做一致性校验）。
 *  2. dev/test 回落：仅 `SMES_DEV_AUTH=on` 时接受请求头 `x-smes-user`
 *     （DEV_USER_HEADER）——供既有 e2e/boot 测试与本地脚本使用；生产默认
 *     无此路径（头被完全忽略）。Bearer 存在但无效时不回落 dev 头（显式坏
 *     凭据不得静默降级）。
 *
 * 401 / 403 分离（合同语义）：身份缺失或无效 = 401（UnauthorizedException）；
 * 身份有效但权限判定拒绝 = 403（ForbiddenException）。
 *
 * 协同方式：
 *  - 租户：TenantContext（ALS）中间件已包裹整条下游处理链（ADR-0005）；
 *  - 判定：零本地逻辑，全部委托 PermissionService（application 包，零框架）；
 *  - 放行规则：未声明 @RequirePermission 的路由 = 公开路由（/health、/modules、
 *    /auth/* 等既有行为零回归）；@RequireLogin（fix-wave-6 6b-3，A14 首用）
 *    = 仅登录档——解析身份并传递，但不做权限码判定（本人本人数据，登录即
 *    有权，PRD 22 册 RREQ-INT-032）。
 *
 * 身份传递：判定通过后把 UserId 写入请求属性 REQUEST_USER_KEY，
 * 供受保护 handler 经 @Req() 读回（见 request-user.ts；users.active 启停
 * 端点据此取操作者）。
 */
import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserId } from '@smes/business-core';
import {
  PERMISSION_METADATA_KEY,
  PermissionService,
  REQUEST_USER_KEY,
  REQUIRE_LOGIN_METADATA_KEY,
  TenantContext,
  permissionCode,
} from '@smes/application';
import { AuthService } from '@smes/application';

/** dev/test 身份回落开关（环境变量名）。 */
export const DEV_AUTH_FLAG = 'SMES_DEV_AUTH';
/** dev/test 身份头（仅 SMES_DEV_AUTH=on 时被接受）。 */
export const DEV_USER_HEADER = 'x-smes-user';

interface MinimalRequest {
  readonly headers: Record<string, unknown>;
  [key: string]: unknown;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContext: TenantContext,
    private readonly permissions: PermissionService,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<unknown>(PERMISSION_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const requireLogin = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_LOGIN_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (required === undefined && !requireLogin) {
      return true; // 公开路由：未声明权限码且未声明仅登录 = 不设防（既有端点零回归）
    }
    if (required !== undefined && typeof required !== 'string') {
      throw new ForbiddenException('路由权限码元数据类型非法');
    }
    const code = required === undefined ? null : permissionCode(required); // 装饰器已在定义期校验过；此处兜底 fail-closed

    const request = context.switchToHttp().getRequest<MinimalRequest>();
    const user = await this.resolveUser(request);
    if (user === undefined) {
      throw new UnauthorizedException('缺少或无效的访问令牌，请先登录后再访问');
    }

    // 仅登录档（required 为空）：身份有效即放行——不做权限码判定（A14 先例：
    // 本人本人的偏好数据，登录即有权）。身份仍写入请求供 handler 读回。
    if (code === null) {
      request[REQUEST_USER_KEY] = user;
      return true;
    }

    const tenant = this.tenantContext.current(); // ALS 内：当前请求租户
    const allowed = await this.permissions.authorize(tenant, user, code);
    if (!allowed) {
      // UX-VW-R2-02：可见文案人话化——租户/用户 id/权限码不进响应体（页面直出
      // message，技术标识经文案泄漏给终端用户）；判定逻辑零改动，定位仍以
      // 服务端日志/权限配置为准。
      throw new ForbiddenException('当前账号没有访问该功能的权限，请联系管理员开通');
    }

    request[REQUEST_USER_KEY] = user; // 身份传递给 handler
    return true;
  }

  /**
   * 身份解析：Bearer 会话优先；无 Bearer 且 SMES_DEV_AUTH=on 时回落
   * dev/test 头。非法（空/数组头）一律视为缺失 → 401。
   */
  private async resolveUser(request: MinimalRequest): Promise<UserId | undefined> {
    const bearer = readBearerToken(request.headers);
    if (bearer !== undefined) {
      const session = await this.auth.resolveSession(bearer);
      if (session === null) {
        return undefined;
      }
      // 会话租户与请求租户上下文必须一致（多租户接入点见文件头注释）
      return session.tenant === this.tenantContext.current() ? session.userId : undefined;
    }
    if (process.env[DEV_AUTH_FLAG] !== 'on') {
      return undefined; // 生产默认：无 dev 头路径
    }
    return this.resolveDevUser(request);
  }

  /** dev/test 身份解析（仅 SMES_DEV_AUTH=on）。 */
  private resolveDevUser(request: MinimalRequest): UserId | undefined {
    const raw = request.headers?.[DEV_USER_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string' || value.trim().length === 0) {
      return undefined;
    }
    return UserId.create(value.trim());
  }
}

/** 从请求头读 Bearer token（无/形状不符 → undefined）。 */
function readBearerToken(headers: Record<string, unknown> | undefined): string | undefined {
  const raw = headers?.['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith('bearer ')) {
    return undefined;
  }
  const token = trimmed.slice(7).trim();
  return token.length > 0 ? token : undefined;
}
