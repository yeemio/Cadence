import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { APP_GUARD } from '@nestjs/core';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import { AuthGuard } from '../src/auth.guard.js';
import { DevPolicyController } from '../src/dev-policy.controller.js';
import {
  DEFAULT_MODULES_ENABLED,
  MODULE_DEFINITIONS,
  ModuleRegistryError,
  REQUIRED_MODULE,
  buildAppModule,
  parseModulesEnabled,
} from '../src/app-registry.js';

describe('应用注册表（ADR-0004 feature flag 装配）', () => {
  it('MODULES_ENABLED 未设置 → 默认装配六模块 core,org,masterdata,workbench,approval,demo（core 置首，M1 收尾波-① 口径）', () => {
    expect(parseModulesEnabled(undefined)).toEqual(['core', 'org', 'masterdata', 'workbench', 'approval', 'demo']);
    expect(parseModulesEnabled(null)).toEqual(['core', 'org', 'masterdata', 'workbench', 'approval', 'demo']);
  });

  it("MODULES_ENABLED='core' → 只装配 core，org/masterdata/workbench/approval/demo 停用", () => {
    expect(parseModulesEnabled('core')).toEqual(['core']);
  });

  it('容忍空白与大小写，去重，core 恒置首（其余按输入顺序）', () => {
    expect(parseModulesEnabled(' demo, APPROVAL , ORG , CORE ,demo')).toEqual(['core', 'demo', 'approval', 'org']);
    expect(parseModulesEnabled('CORE')).toEqual(['core']);
  });

  it('缺 core → 拒绝启动（必装基础层，ADR-0004）', () => {
    expect(() => parseModulesEnabled('demo')).toThrow(ModuleRegistryError);
    expect(() => parseModulesEnabled('demo')).toThrow(/core/);
  });

  it('未知模块 → 拒绝并列出可用清单（拼写错误不静默）', () => {
    // 样例名刻意避开真实/规划模块名（workorder/baseline 自 M2 Wave-1 起已注册）
    expect(() => parseModulesEnabled('core,unknownmod')).toThrow(/unknownmod/);
  });

  it('显式置空 → 拒绝启动', () => {
    expect(() => parseModulesEnabled('')).toThrow(ModuleRegistryError);
    expect(() => parseModulesEnabled('  ')).toThrow(ModuleRegistryError);
  });

  it('buildAppModule 返回可交给 NestFactory.create 的根模块类', () => {
    const root = buildAppModule(parseModulesEnabled(undefined));
    expect(typeof root).toBe('function');
  });

  it('注册表常量与 ADR-0004 对齐（六模块默认装配：approval 进默认集，M1 收尾波-①）', () => {
    expect(REQUIRED_MODULE).toBe('core');
    expect(DEFAULT_MODULES_ENABLED).toBe('core,org,masterdata,workbench,approval,demo');
    expect(Object.hasOwn(MODULE_DEFINITIONS, 'org')).toBe(true);
    expect(Object.hasOwn(MODULE_DEFINITIONS, 'masterdata')).toBe(true);
    expect(Object.hasOwn(MODULE_DEFINITIONS, 'workbench')).toBe(true);
    expect(Object.hasOwn(MODULE_DEFINITIONS, 'approval')).toBe(true);
  });

  it('组合根恒注册全局鉴权守卫（APP_GUARD -> AuthGuard，M1 增量 2-B）', () => {
    const root = buildAppModule(parseModulesEnabled(undefined));
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, root) as unknown[];
    const guard = providers.find(
      (p) => (p as { provide?: unknown }).provide === APP_GUARD,
    ) as { useClass?: unknown } | undefined;
    expect(guard?.useClass).toBe(AuthGuard);
  });

  it('策略注入测试钩子默认不装配；显式开启才挂 DevPolicyController', () => {
    const controllersOf = (root: object): unknown[] =>
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, root) as unknown[];
    expect(controllersOf(buildAppModule(parseModulesEnabled(undefined)))).not.toContain(
      DevPolicyController,
    );
    expect(
      controllersOf(buildAppModule(parseModulesEnabled(undefined), { devPolicyEndpoint: true })),
    ).toContain(DevPolicyController);
  });
});
