/**
 * POST /dev/policies —— 策略注入测试钩子（M1 增量 2-B，可替换的 dev/test 形状）。
 *
 * 默认不装配（SMES_DEV_POLICY_ENDPOINT=on 才注册，见 main.ts/app-registry.ts），
 * 生产形态不开。
 * 【生产替换点】组织/用户/角色管理 CRUD（core 基础层章程，M1 后续增量）
 * + PolicyStore 的 PG adapter（business-store 线）——本端点与它们写的是同一条
 * 端口路径（PermissionService.apply -> casbin autoSave -> PolicyStore），
 * 替换后链路语义不变。
 *
 * 请求体：{ "rules": [ {kind, tenant, ...} ... ] }，逐条经 parsePolicyRule
 * 校验（违规 400，不静默丢弃），全部合法才落库。
 */
import { BadRequestException, Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  PermissionService,
  parsePolicyRule,
  PolicyRuleError,
  type PolicyRule,
} from '@smes/application';

@Controller()
export class DevPolicyController {
  constructor(private readonly permissions: PermissionService) {}

  @Post('dev/policies')
  @HttpCode(200)
  async appendPolicies(@Body() body: unknown): Promise<{ applied: number }> {
    const raw = (body as { rules?: unknown } | null | undefined)?.rules;
    if (!Array.isArray(raw)) {
      throw new BadRequestException('请求体须为 {"rules": [...]} 且 rules 为数组');
    }
    let rules: PolicyRule[];
    try {
      rules = raw.map((rule) => parsePolicyRule(rule));
    } catch (error) {
      const message = error instanceof PolicyRuleError ? error.message : String(error);
      throw new BadRequestException(`策略规则非法：${message}`);
    }
    await this.permissions.apply(rules);
    return { applied: rules.length };
  }
}
