/**
 * ColumnPreferencesModule —— 列显隐偏好模块（fix-wave-6 6b-3，A14 /
 * RREQ-INT-032）。与 MenuConfigModule 同一模式：存储端口注入点，组合根注入
 * PG 实现（business-store `./column-preferences`），缺省回落内存实现（零 DB
 * boot 语义完整）。TenantContext 由 CoreModule（global）导出注入。
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import { InMemoryColumnPreferenceStore } from './in-memory-column-preferences-stores.js';
import { ColumnPreferenceController } from './column-preferences.controllers.js';
import { ColumnPreferenceService } from './column-preferences.service.js';
import type { ColumnPreferenceStore } from './column-preferences-stores.js';

export const COLUMN_PREFERENCE_STORE = Symbol('smes.columnPreferences.store');

export interface ColumnPreferencesModuleOptions {
  /** 列显隐偏好存储；缺省 = 内存实现（重启即失）。显式 undefined 同缺省。 */
  readonly columnPreferenceStore?: ColumnPreferenceStore | undefined;
}

@Module({})
export class ColumnPreferencesModule {
  static register(options: ColumnPreferencesModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      {
        provide: COLUMN_PREFERENCE_STORE,
        useValue: options.columnPreferenceStore ?? new InMemoryColumnPreferenceStore(),
      },
      {
        provide: ColumnPreferenceService,
        useFactory: (store: ColumnPreferenceStore) => new ColumnPreferenceService(store),
        inject: [COLUMN_PREFERENCE_STORE],
      },
    ];

    return {
      module: ColumnPreferencesModule,
      controllers: [ColumnPreferenceController],
      providers,
    };
  }
}
