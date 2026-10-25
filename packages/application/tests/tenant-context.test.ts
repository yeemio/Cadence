import { describe, expect, it } from 'vitest';
import { TenantId } from '@smes/business-core';
import {
  DEFAULT_TENANT_ID,
  TenantContext,
  fixedDefaultTenant,
} from '../src/core/tenant-context.js';

describe('TenantContext（ADR-0005 单租户形态）', () => {
  it('无 ALS store 时 current() 回落固定默认租户（零开销形态）', () => {
    const ctx = new TenantContext();
    expect(ctx.current()).toBe(DEFAULT_TENANT_ID);
  });

  it('run() 期间 current() 返回指定租户，退出后回落', () => {
    const ctx = new TenantContext();
    const outside = ctx.current();
    const inside = ctx.run(TenantId.create('t-001'), () => ctx.current());
    expect(inside).toBe('t-001');
    expect(ctx.current()).toBe(outside);
  });

  it('默认解析器与请求无关，恒返回默认租户', () => {
    expect(fixedDefaultTenant({ url: '/health' })).toBe(DEFAULT_TENANT_ID);
    expect(new TenantContext().resolve({ headers: {} })).toBe(DEFAULT_TENANT_ID);
  });

  it('useResolver 可替换解析器（SaaS/RLS 接入点形状，M4 前不用）', () => {
    const ctx = new TenantContext();
    ctx.useResolver((request) =>
      TenantId.create(`t-${(request as { host: string }).host}`),
    );
    expect(ctx.resolve({ host: 'acme' })).toBe('t-acme');
  });

  it('默认租户值经 TenantId.create 构造（品牌化 ID，ADR-0003 #2）', () => {
    expect(TenantId.is(fixedDefaultTenant(null))).toBe(true);
  });
});
