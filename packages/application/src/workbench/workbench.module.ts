/**
 * WorkbenchModule —— 工作台/待办模块（M1 增量 4-I，core 基础层章程）。
 *
 * ADR-0004 定位：工作台/待办属必装基础层，以独立可启停模块形态落进注册表
 * （MODULE_DEFINITIONS.workbench，默认装配）。存储端口注入点与 OrgModule
 * 同一模式：组合根注入 PG 实现（business-store `./workbench`），缺省回落
 * 内存实现（零 DB boot 语义完整）。TenantContext 由 CoreModule（global）
 * 导出注入。
 */
import { DynamicModule, Module, Provider } from '@nestjs/common';
import { InMemoryTodoStore } from './in-memory-workbench-stores.js';
import { WorkbenchController } from './workbench.controllers.js';
import { WorkbenchService } from './workbench.service.js';
import type { TodoStore } from './workbench-stores.js';

export const WORKBENCH_TODO_STORE = Symbol('smes.workbench.todoStore');

export interface WorkbenchModuleOptions {
  /** 待办存储；缺省 = 内存实现（重启即失）。显式 undefined 同缺省。 */
  readonly todoStore?: TodoStore | undefined;
}

@Module({})
export class WorkbenchModule {
  static register(options: WorkbenchModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      { provide: WORKBENCH_TODO_STORE, useValue: options.todoStore ?? new InMemoryTodoStore() },
      {
        provide: WorkbenchService,
        useFactory: (todos: TodoStore) => new WorkbenchService(todos),
        inject: [WORKBENCH_TODO_STORE],
      },
    ];

    return {
      module: WorkbenchModule,
      controllers: [WorkbenchController],
      providers,
    };
  }
}
