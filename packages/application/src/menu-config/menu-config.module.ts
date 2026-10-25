/**
 * MenuConfigModule —— 菜单管理模块（T 波 #98/99）。
 *
 * 存储端口注入点与 OrgModule 同一模式：组合根注入 PG 实现（business-store
 * `./menu-config`，子路径导出登记归合流），缺省回落内存实现（零 DB boot
 * 语义完整）。TenantContext 由 CoreModule（global）导出注入。
 * 装配期菜单渲染如何消费持久化配置（注册表合并策略）归合流接线。
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import { InMemoryMenuConfigStore } from './in-memory-menu-config-stores.js';
import { MenuConfigController } from './menu-config.controllers.js';
import { MenuConfigService } from './menu-config.service.js';
import type { MenuConfigStore } from './menu-config-stores.js';

export const MENU_CONFIG_STORE = Symbol('smes.menuConfig.store');

export interface MenuConfigModuleOptions {
  /** 菜单配置存储；缺省 = 内存实现（重启即失）。显式 undefined 同缺省。 */
  readonly menuConfigStore?: MenuConfigStore | undefined;
}

@Module({})
export class MenuConfigModule {
  static register(options: MenuConfigModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      {
        provide: MENU_CONFIG_STORE,
        useValue: options.menuConfigStore ?? new InMemoryMenuConfigStore(),
      },
      {
        provide: MenuConfigService,
        useFactory: (store: MenuConfigStore) => new MenuConfigService(store),
        inject: [MENU_CONFIG_STORE],
      },
    ];

    return {
      module: MenuConfigModule,
      controllers: [MenuConfigController],
      providers,
    };
  }
}
