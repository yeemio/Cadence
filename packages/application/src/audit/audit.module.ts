/**
 * AuditModule —— 操作日志模块（S1 backfill：0920 #103，系统管理域）。
 *
 * 独立模块而非并入 org/masterdata：操作日志是横切运维面（不属任何业务域），
 * 按 ADR-0004 以独立可启停模块落进注册表（MODULE_DEFINITIONS.audit，非默认
 * 装配——同 M2/M3 环节模块口径；组合根显式 MODULES_ENABLED 开启）。
 * AuditService 同时导出给组合根的 AuditWriteInterceptor（APP_INTERCEPTOR
 * 条件装配，见 app-registry.ts）。
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import { AuditController } from './audit.controller.js';
import { AuditService } from './audit.service.js';
import { InMemoryAuditLogStore } from './in-memory-audit-stores.js';
import type { AuditLogStore } from './audit-stores.js';

export const AUDIT_LOG_STORE = Symbol('smes.audit.logStore');

export interface AuditModuleOptions {
  /** 操作日志存储；缺省 = 内存实现（重启即失）。显式 undefined 同缺省。 */
  readonly logStore?: AuditLogStore | undefined;
}

@Module({})
export class AuditModule {
  static register(options: AuditModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      { provide: AUDIT_LOG_STORE, useValue: options.logStore ?? new InMemoryAuditLogStore() },
      {
        provide: AuditService,
        useFactory: (logs: AuditLogStore) => new AuditService(logs),
        inject: [AUDIT_LOG_STORE],
      },
    ];

    return {
      module: AuditModule,
      controllers: [AuditController],
      providers,
      exports: [AuditService],
    };
  }
}
