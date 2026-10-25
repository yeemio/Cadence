/**
 * AuthModule —— 真实认证模块（M1 收尾波-③，core 基础层章程）。
 *
 * global：组合根的 AuthGuard（APP_GUARD）注入 AuthService 做会话解析；
 * PermissionService / TenantContext 由 CoreModule（global）导出注入。
 * 装配恒定（不经 MODULES_ENABLED 开关——鉴权属基础层，与 /health 同类；
 * 见 apps/server/src/app-registry.ts）。存储端口注入点与 OrgModule 同一
 * 模式：组合根注入 PG 实现（business-store `./org`），缺省回落内存实现。
 *
 * 用户存储共享纪律：组合根保证 org 与 auth 拿到**同一** UserStore 实例
 * （buildAppModule 统一构造/注入；同 InMemoryTodoStore 先例）。
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import { PermissionService } from '../core/auth/permission.service.js';
import { InMemoryUserStore } from '../org/in-memory-org-stores.js';
import type { UserStore } from '../org/org-stores.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import type { AuthServiceOptions } from './auth.service.js';
import { InMemorySessionStore } from './session-stores.js';
import type { SessionStore } from './session-stores.js';

export const AUTH_USER_STORE = Symbol('smes.auth.userStore');
export const AUTH_SESSION_STORE = Symbol('smes.auth.sessionStore');

export interface AuthModuleOptions extends AuthServiceOptions {
  /** 用户存储（登录按 username 取凭据）；缺省 = 内存实现。 */
  readonly userStore?: UserStore | undefined;
  /** 会话存储；缺省 = 内存实现（重启即失——零 DB 形态登录本就无种子用户）。 */
  readonly sessionStore?: SessionStore | undefined;
}

@Module({})
export class AuthModule {
  static register(options: AuthModuleOptions = {}): DynamicModule {
    const { userStore, sessionStore, ...serviceOptions } = options;
    const providers: Provider[] = [
      { provide: AUTH_USER_STORE, useValue: userStore ?? new InMemoryUserStore() },
      { provide: AUTH_SESSION_STORE, useValue: sessionStore ?? new InMemorySessionStore() },
      {
        provide: AuthService,
        useFactory: (users: UserStore, sessions: SessionStore, permissions: PermissionService) =>
          new AuthService(users, sessions, permissions, serviceOptions),
        inject: [AUTH_USER_STORE, AUTH_SESSION_STORE, PermissionService],
      },
    ];

    return {
      global: true,
      module: AuthModule,
      controllers: [AuthController],
      providers,
      exports: [AUTH_SESSION_STORE, AuthService],
    };
  }
}
