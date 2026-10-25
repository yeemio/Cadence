/**
 * TenantContext —— 双形态多租户基座（ADR-0005）。
 *
 * 单租户形态 = 固定默认租户：AsyncLocalStorage 无 store 时回落默认租户，零可感知开销；
 * SaaS/RLS 形态在 M4 接入（通过 useResolver / CoreModuleOptions.tenantResolver
 * 替换解析函数，接口形状本增量已就位）。
 *
 * 本类是纯运行时设施：不 import 任何 @nestjs/*（装配见 core.module.ts，
 * 装配纪律见 apps/server/README.md）。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { TenantId } from '@smes/business-core';

export const DEFAULT_TENANT_ID = 'default';

/** 租户解析器：从请求解析租户身份。可替换（SaaS 形态接入点）。 */
export type TenantResolver = (request: unknown) => TenantId;

/** 默认解析器：单租户形态恒返回固定默认租户，与请求无关。 */
export function fixedDefaultTenant(_request: unknown): TenantId {
  return TenantId.create(DEFAULT_TENANT_ID);
}

export class TenantContext {
  private readonly storage = new AsyncLocalStorage<TenantId>();
  private resolver: TenantResolver = fixedDefaultTenant;

  /** 替换租户解析器（M4 SaaS/RLS 接入点；单租户形态不需要调用）。 */
  useResolver(resolver: TenantResolver): this {
    this.resolver = resolver;
    return this;
  }

  /** 从请求解析租户身份（委托当前解析器）。 */
  resolve(request: unknown): TenantId {
    return this.resolver(request);
  }

  /** 在指定租户上下文内执行下游处理链（ALS run）。 */
  run<T>(tenant: TenantId, fn: () => T): T {
    return this.storage.run(tenant, fn);
  }

  /** 当前租户：无 ALS store（启动期/队列任务等）时回落固定默认租户。 */
  current(): TenantId {
    return this.storage.getStore() ?? fixedDefaultTenant(null);
  }
}
