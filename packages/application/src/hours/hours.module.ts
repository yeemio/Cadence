/**
 * HoursModule —— 工时账模块（M2-W6，08-hours.md v1.0）。账本域：无状态机、
 * 无 engine-flow 依赖（ADR-0010）；体例与 BaselineModule 同模式——存储端口
 * 注入点 + 缺省内存回落（零 DB boot 语义完整）。跨模块端口（reporting 订阅 /
 * baseline StandardTime 对标）缺省空实现，兄弟模块合流时经 register 注入
 * 真实端口——本模块只经端口互调（依赖铁律）。
 *
 * 注册（总控合流接 app-registry，本文件不改注册表）：
 *   hours: (stores) =>
 *     HoursModule.register({
 *       entryStore: stores.hoursEntryStore, // …PG 注入点，余类推
 *       monthStore: stores.hoursMonthStore,
 *       eventStore: stores.hoursEventStore,
 *       operationStore: stores.hoursOperationStore,
 *       // 跨模块端口（合流接线）：
 *       reportFeed, standardTime,
 *     }),
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import {
  InMemoryHoursDomainEventStore,
  InMemoryHoursOperationStore,
  InMemoryLaborEntryStore,
  InMemoryLaborLedgerMonthStore,
} from './in-memory-hours-stores.js';
import type {
  HoursDomainEventStore,
  HoursOperationStore,
  LaborEntryStore,
  LaborLedgerMonthStore,
} from './hours-stores.js';
import { EMPTY_REPORT_EVENT_FEED, EMPTY_STANDARD_TIME, type ReportEventFeedPort, type StandardTimePort } from './hours-ports.js';
import { HoursLedgerController } from './hours.controllers.js';
import { HoursService, type HoursServiceOptions } from './hours.service.js';

export const HOURS_ENTRY_STORE = Symbol('smes.hours.entryStore');
export const HOURS_MONTH_STORE = Symbol('smes.hours.monthStore');
export const HOURS_EVENT_STORE = Symbol('smes.hours.eventStore');
export const HOURS_OPERATION_STORE = Symbol('smes.hours.operationStore');
export const HOURS_REPORT_FEED = Symbol('smes.hours.reportFeed');
export const HOURS_STANDARD_TIME = Symbol('smes.hours.standardTime');
export const HOURS_SERVICE_OPTIONS = Symbol('smes.hours.serviceOptions');

export interface HoursModuleOptions {
  /** 工时账目存储；缺省 = 内存实现（重启即失）。显式 undefined 同缺省。 */
  readonly entryStore?: LaborEntryStore | undefined;
  /** 月度归集快照存储；缺省 = 内存实现。 */
  readonly monthStore?: LaborLedgerMonthStore | undefined;
  /** 域事件（BusinessEvent + Outbox）存储；缺省 = 内存实现（PG 侧映射 event_records）。 */
  readonly eventStore?: HoursDomainEventStore | undefined;
  /** 命令幂等记账存储；缺省 = 内存实现。 */
  readonly operationStore?: HoursOperationStore | undefined;
  /** reporting ReportVerified/ReportRevoked 订阅端口；缺省 = 空实现（零接线 boot）。 */
  readonly reportFeed?: ReportEventFeedPort | undefined;
  /** baseline StandardTime 额定工时对标端口；缺省 = 空实现（对标列空）。 */
  readonly standardTime?: StandardTimePort | undefined;
  /** 服务选项（时钟注入）；缺省 = 系统时钟。 */
  readonly serviceOptions?: HoursServiceOptions | undefined;
}

@Module({})
export class HoursModule {
  static register(options: HoursModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      { provide: HOURS_ENTRY_STORE, useValue: options.entryStore ?? new InMemoryLaborEntryStore() },
      { provide: HOURS_MONTH_STORE, useValue: options.monthStore ?? new InMemoryLaborLedgerMonthStore() },
      { provide: HOURS_EVENT_STORE, useValue: options.eventStore ?? new InMemoryHoursDomainEventStore() },
      { provide: HOURS_OPERATION_STORE, useValue: options.operationStore ?? new InMemoryHoursOperationStore() },
      { provide: HOURS_REPORT_FEED, useValue: options.reportFeed ?? EMPTY_REPORT_EVENT_FEED },
      { provide: HOURS_STANDARD_TIME, useValue: options.standardTime ?? EMPTY_STANDARD_TIME },
      { provide: HOURS_SERVICE_OPTIONS, useValue: options.serviceOptions ?? {} },
      {
        provide: HoursService,
        useFactory: (
          entries: LaborEntryStore,
          months: LaborLedgerMonthStore,
          events: HoursDomainEventStore,
          operations: HoursOperationStore,
          feed: ReportEventFeedPort,
          standardTime: StandardTimePort,
          serviceOptions: HoursServiceOptions,
        ) =>
          new HoursService(
            { entries, months, events, operations },
            { feed, standardTime },
            serviceOptions,
          ),
        inject: [
          HOURS_ENTRY_STORE,
          HOURS_MONTH_STORE,
          HOURS_EVENT_STORE,
          HOURS_OPERATION_STORE,
          HOURS_REPORT_FEED,
          HOURS_STANDARD_TIME,
          HOURS_SERVICE_OPTIONS,
        ],
      },
    ];

    return {
      module: HoursModule,
      controllers: [HoursLedgerController],
      providers,
    };
  }
}
