/**
 * ApprovalConfigModule —— 审批流配置模块（T 波 #102，approval 域）。
 *
 * 存储端口注入点与 OrgModule 同一模式：组合根注入 PG 实现（business-store
 * `./approval-config`，子路径导出登记归合流），缺省回落内存实现（零 DB boot
 * 语义完整）。TenantContext 由 CoreModule（global）导出注入。
 * ApprovalService 运行时按租户装载持久化配置（替换装配期静态配置）的接线
 * 归合流，本模块只做配置面 CRUD/校验。
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import { InMemoryApprovalFlowConfigStore } from './in-memory-approval-config-stores.js';
import { ApprovalConfigController } from './approval-config.controllers.js';
import { ApprovalConfigService } from './approval-config.service.js';
import type { ApprovalFlowConfigStore } from './approval-config-stores.js';

export const APPROVAL_FLOW_CONFIG_STORE = Symbol('smes.approvalConfig.flowConfigStore');

export interface ApprovalConfigModuleOptions {
  /** 审批流配置存储；缺省 = 内存实现（重启即失）。显式 undefined 同缺省。 */
  readonly flowConfigStore?: ApprovalFlowConfigStore | undefined;
}

@Module({})
export class ApprovalConfigModule {
  static register(options: ApprovalConfigModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      {
        provide: APPROVAL_FLOW_CONFIG_STORE,
        useValue: options.flowConfigStore ?? new InMemoryApprovalFlowConfigStore(),
      },
      {
        provide: ApprovalConfigService,
        useFactory: (store: ApprovalFlowConfigStore) => new ApprovalConfigService(store),
        inject: [APPROVAL_FLOW_CONFIG_STORE],
      },
    ];

    return {
      module: ApprovalConfigModule,
      controllers: [ApprovalConfigController],
      providers,
    };
  }
}
