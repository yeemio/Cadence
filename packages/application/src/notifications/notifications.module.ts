/**
 * NotificationsModule —— 站内通知中心模块（T 波 #101，core 基础层定位）。
 *
 * 存储端口注入点与 WorkbenchModule 同一模式：组合根注入 PG 实现
 * （business-store `./notifications`，子路径导出登记归合流），缺省回落内存
 * 实现（零 DB boot 语义完整）。TenantContext 由 CoreModule（global）导出注入。
 * NotificationSourcePort 的发布钩子接线（点名/派修/IM 事件点各一行）归合流。
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import { InMemoryNotificationStore } from './in-memory-notifications-stores.js';
import { NotificationsController } from './notifications.controllers.js';
import { NotificationService } from './notifications.service.js';
import type { NotificationStore } from './notifications-stores.js';

export const NOTIFICATION_STORE = Symbol('smes.notifications.store');

export interface NotificationsModuleOptions {
  /** 通知存储；缺省 = 内存实现（重启即失）。显式 undefined 同缺省。 */
  readonly notificationStore?: NotificationStore | undefined;
}

@Module({})
export class NotificationsModule {
  static register(options: NotificationsModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      {
        provide: NOTIFICATION_STORE,
        useValue: options.notificationStore ?? new InMemoryNotificationStore(),
      },
      {
        provide: NotificationService,
        useFactory: (store: NotificationStore) => new NotificationService(store),
        inject: [NOTIFICATION_STORE],
      },
    ];

    return {
      module: NotificationsModule,
      controllers: [NotificationsController],
      providers,
    };
  }
}
