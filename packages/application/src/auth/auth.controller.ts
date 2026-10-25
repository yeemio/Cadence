/**
 * 认证路由（M1 收尾波-③）——全部公开路由（不声明 @RequirePermission，
 * AuthGuard 直通；凭据语义在控制器内自解 Authorization 头）。
 *
 *   POST /auth/login    { username, password } → { token, expiresAt, user, admin, permissions }
 *   POST /auth/refresh  Bearer 旧 token        → 同上（旧 token 即刻失效）
 *   POST /auth/logout   Bearer token           → 204
 *   GET  /auth/me       Bearer token           → { expiresAt, user, admin, permissions }
 *
 * 控制器零逻辑：解析输入、委托 AuthService、Date → ISO 字符串序列化边界；
 * 租户一律取 TenantContext（ADR-0005：租户身份从上下文进，不从请求体自报）。
 * login/refresh 响应顺带权限投影（admin + permissions），减少 Web 登录后一次往返。
 *
 * 【OAuth 接口缝（留形不实装）】企微/飞书 OAuth 落地时在此并列
 * POST /auth/oauth/:provider（换码端点）——认证模块组合根形状不变，
 * 仅新增 provider 策略注入（无凭据不可验证，与 G 线同款理由，不预造实现）。
 */
import { Body, Controller, Get, Headers, HttpCode, Post } from '@nestjs/common';
import { TenantContext } from '../core/tenant-context.js';
import type { PermissionCode } from '../core/auth/permission-code.js';
import type { UserAccount } from '../org/org-stores.js';
import { requireBearerToken } from './auth-input.js';
import type { AuthAccountView, IssuedSession } from './auth.service.js';
import { AuthService } from './auth.service.js';

interface SessionResponse {
  readonly token: string;
  readonly expiresAt: string;
  readonly user: UserAccount;
  readonly admin: boolean;
  readonly permissions: readonly PermissionCode[];
}

interface AccountResponse {
  readonly expiresAt: string;
  readonly user: UserAccount;
  readonly admin: boolean;
  readonly permissions: readonly PermissionCode[];
}

function toAccountResponse(view: AuthAccountView): AccountResponse {
  return {
    expiresAt: view.expiresAt.toISOString(),
    user: view.user,
    admin: view.admin,
    permissions: view.permissions,
  };
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly auth: AuthService,
  ) {}

  @Post('login')
  async login(@Body() body: unknown): Promise<SessionResponse> {
    const tenant = this.tenantContext.current();
    const issued: IssuedSession = await this.auth.login(tenant, body);
    // currentAccount 以刚签发的 token 反查会话——同一次请求内有效性必然成立
    const view = await this.auth.currentAccount(tenant, issued.token);
    return { token: issued.token, ...toAccountResponse(view) };
  }

  @Post('refresh')
  async refresh(@Headers('authorization') authorization: unknown): Promise<SessionResponse> {
    const tenant = this.tenantContext.current();
    const token = requireBearerToken(authorization);
    const issued = await this.auth.refresh(tenant, token);
    const view = await this.auth.currentAccount(tenant, issued.token);
    return { token: issued.token, ...toAccountResponse(view) };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Headers('authorization') authorization: unknown): Promise<void> {
    await this.auth.logout(requireBearerToken(authorization));
  }

  @Get('me')
  async me(@Headers('authorization') authorization: unknown): Promise<AccountResponse> {
    const tenant = this.tenantContext.current();
    const token = requireBearerToken(authorization);
    return toAccountResponse(await this.auth.currentAccount(tenant, token));
  }
}
