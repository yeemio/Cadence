/**
 * GET /modules —— 当前已装配模块清单（注册表结果读回，验收 feature flag 生效的观测端点）。
 */
import { Controller, Get, Inject } from '@nestjs/common';

export const ENABLED_MODULE_NAMES = Symbol('smes.enabledModuleNames');

@Controller()
export class ModulesController {
  constructor(
    @Inject(ENABLED_MODULE_NAMES) private readonly enabled: readonly string[],
  ) {}

  @Get('modules')
  modules(): { modules: readonly string[] } {
    return { modules: this.enabled };
  }
}
