/**
 * CoreModule —— 必装基础层动态模块（ADR-0004 基础层，应用注册表强制装配）。
 * global：组合根与后续模块都可以直接注入 TenantContext / CoreService /
 * PermissionService（组织权限属基础层章程）。
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import { PermissionService } from './auth/permission.service.js';
import { InMemoryPolicyStore } from './auth/in-memory-policy-store.js';
import { POLICY_STORE, type PolicyStore } from './auth/policy-store.js';
import { CoreService } from './core.service.js';
import { TenantContext, TenantResolver } from './tenant-context.js';

export interface CoreModuleOptions {
  /**
   * 租户解析器（ADR-0005 的 SaaS/RLS 接入点）。
   * 缺省 = 单租户固定默认租户 'default'，零可感知开销。
   */
  readonly tenantResolver?: TenantResolver;
  /**
   * 策略存储（M1 增量 2-B 策略端口注入点）。
   * 缺省 = 内存实现（重启即失）；PG adapter 由 business-store 线按同端口接入。
   * （M1 增量 3-D：加 `| undefined` 显式可选——exactOptionalPropertyTypes 下
   * 组合根条件装配需要显式传 undefined，纯类型放宽，行为零变化。）
   */
  readonly policyStore?: PolicyStore | undefined;
}

@Module({})
export class CoreModule {
  static register(options: CoreModuleOptions = {}): DynamicModule {
    const tenantResolver = options.tenantResolver;
    const tenantContextProvider: Provider = tenantResolver
      ? { provide: TenantContext, useValue: new TenantContext().useResolver(tenantResolver) }
      : { provide: TenantContext, useClass: TenantContext };

    const policyStoreProvider: Provider = options.policyStore
      ? { provide: POLICY_STORE, useValue: options.policyStore }
      : { provide: POLICY_STORE, useClass: InMemoryPolicyStore };

    // PermissionService 保持零框架：经 useFactory 构造注入，不挂 @Injectable。
    const permissionServiceProvider: Provider = {
      provide: PermissionService,
      useFactory: (store: PolicyStore) => new PermissionService(store),
      inject: [POLICY_STORE],
    };

    return {
      global: true,
      module: CoreModule,
      providers: [
        tenantContextProvider,
        CoreService,
        policyStoreProvider,
        permissionServiceProvider,
      ],
      exports: [TenantContext, CoreService, PermissionService],
    };
  }
}
