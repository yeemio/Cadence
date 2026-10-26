/**
 * StandardReportsModule —— 标准报表模块（S1 backfill：0920 #89/#91/#92/#96）。
 *
 * 独立模块而非并入 reporting：reporting 是 M2 报工域（业务事实写入面），
 * 标准报表是口径消费面（engine-reporting 求值 + business-store 事实源只读）
 * ——混入会让报工模块依赖口径引擎（依赖方向劣化）。按 ADR-0004 以独立可
 * 启停模块落进注册表（MODULE_DEFINITIONS.standardreports，非默认装配——
 * 组合根显式 MODULES_ENABLED 开启，同 M2 环节模块口径）。
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import { REPORT_CENTER_PACK } from '@smes/engine-reporting';
import { StandardReportsController } from './standardreports.controllers.js';
import { StandardReportsService } from './standardreports.service.js';
import { ReportCenterController } from './report-center.controllers.js';
import { ReportCenterReportsService } from './report-center.service.js';
import {
  UNBOUND_REPORT_SOURCE_PROVIDER,
  type ReportSourceProvider,
} from './standardreports-stores.js';
import { STANDARD_REPORTS_PACK } from './standard-reports-pack.js';

export const STANDARD_REPORTS_SOURCE_PROVIDER = Symbol('smes.standardreports.sourceProvider');

export interface StandardReportsModuleOptions {
  /** 事实源解析（按租户）；缺省 = 未绑定形态（零 DB boot：求值显式 503）。 */
  readonly sourceProvider?: ReportSourceProvider | undefined;
}

@Module({})
export class StandardReportsModule {
  static register(options: StandardReportsModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      {
        provide: STANDARD_REPORTS_SOURCE_PROVIDER,
        useValue: options.sourceProvider ?? UNBOUND_REPORT_SOURCE_PROVIDER,
      },
      {
        provide: StandardReportsService,
        useFactory: (sources: ReportSourceProvider) =>
          new StandardReportsService(STANDARD_REPORTS_PACK, sources),
        inject: [STANDARD_REPORTS_SOURCE_PROVIDER],
      },
      // 报表中心服务（r2/r7/r8/r9/r12/r13 六张）：同一 ReportSourceProvider 端口
      // （sourceKind→适配器路由在组合根同一映射里补六源绑定——service 头注口径）；
      // 6a-3 裁决 1 修复：此前 ReportCenterController 未注册（编译在、路由死代码，
      // GET /report-center/metrics 404）——控制器与服务一并装入本模块。
      {
        provide: ReportCenterReportsService,
        useFactory: (sources: ReportSourceProvider) =>
          new ReportCenterReportsService(REPORT_CENTER_PACK, sources),
        inject: [STANDARD_REPORTS_SOURCE_PROVIDER],
      },
    ];

    return {
      module: StandardReportsModule,
      controllers: [StandardReportsController, ReportCenterController],
      providers,
    };
  }
}
