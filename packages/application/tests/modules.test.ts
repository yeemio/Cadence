import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { DynamicModule } from '@nestjs/common';
import { TenantId } from '@smes/business-core';
import { CoreService } from '../src/core/core.service.js';
import { CoreModule } from '../src/core/core.module.js';
import { TenantContext } from '../src/core/tenant-context.js';
import { DemoModule } from '../src/demo/demo.module.js';

function findProvider(
  dynamic: DynamicModule,
  token: unknown,
): Record<string, unknown> | undefined {
  const providers = (dynamic.providers ?? []) as unknown[];
  return providers.find(
    (p): p is Record<string, unknown> =>
      typeof p === 'object' &&
      p !== null &&
      (p as { provide?: unknown }).provide === token,
  );
}

describe('模块装配壳（ADR-0004 动态模块形态）', () => {
  it('CoreModule.register() 默认：global、TenantContext/CoreService 可导出', () => {
    const dynamic = CoreModule.register();
    expect(dynamic.module).toBe(CoreModule);
    expect(dynamic.global).toBe(true);
    expect(dynamic.exports).toContain(TenantContext);
    expect(dynamic.exports).toContain(CoreService);
  });

  it('CoreModule.register() 缺省时 TenantContext 走 useClass（默认固定租户）', () => {
    const provider = findProvider(CoreModule.register(), TenantContext);
    expect(provider?.useClass).toBe(TenantContext);
  });

  it('CoreModule.register({ tenantResolver }) 注入替换后的解析器', () => {
    const dynamic = CoreModule.register({
      tenantResolver: () => TenantId.create('t-custom'),
    });
    const provider = findProvider(dynamic, TenantContext);
    const instance = provider?.useValue as TenantContext | undefined;
    expect(instance?.resolve({})).toBe('t-custom');
  });

  it('DemoModule.register() 提供一个控制器壳（/demo/ping 路由证据）', () => {
    const dynamic = DemoModule.register();
    expect(dynamic.module).toBe(DemoModule);
    expect(dynamic.controllers?.length).toBe(1);
  });
});
