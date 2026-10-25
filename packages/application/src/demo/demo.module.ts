/**
 * DemoModule —— 示例环节模块壳：代表九循环环节模块"按需启停"的形态
 * （ADR-0004：workorder/listing/dispatch/… 均照此壳生长）。
 */
import { DynamicModule, Module } from '@nestjs/common';
import { DemoController } from './demo.controller.js';

export interface DemoModuleOptions {
  /** 预留：环节模块按需装配参数（ADR-0004）。 */
}

@Module({})
export class DemoModule {
  static register(_options: DemoModuleOptions = {}): DynamicModule {
    return { module: DemoModule, controllers: [DemoController] };
  }
}
