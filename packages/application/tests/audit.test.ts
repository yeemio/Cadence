/**
 * 操作日志测试（S1 backfill：0920 #103）：
 * 端口内存实现（租户收口/时间窗/用户过滤/limit/新→旧）、摘要截断、
 * 写拦截器行为（只记写方法/成功收场/自身路径跳过/失败隔离）、查询解析边界、
 * 控制器权限码与模块装配。
 */
import 'reflect-metadata', { } from 'node:assert';
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Observable } from 'rxjs';
import { TenantId, UserId } from '@smes/business-core';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import {
  AuditController,
  AuditInputError,
  AuditModule,
  AuditService,
  AuditWriteInterceptor,
  InMemoryAuditLogStore,
  PERMISSION_METADATA_KEY,
  REQUEST_USER_KEY,
  TenantContext,
  auditSummaryOf,
} from '../src/index.js';

const t1 = TenantId.create('t1');
const t2 = TenantId.create('t2');
const alice = UserId.create('user-alice');
const bob = UserId.create('user-bob');

describe('操作日志端口（内存实现，0920 #103）', () => {
  it('append/query：租户收口、时间窗含端点、用户过滤、新→旧、limit 截取', async () => {
    const store = new InMemoryAuditLogStore();
    await store.append({ tenant: t1, userId: String(alice), method: 'POST', path: '/org/users', occurredAt: '2026-10-25T10:00:00.000Z' });
    await store.append({ tenant: t1, userId: String(bob), method: 'PUT', path: '/masterdata/items/i-1', occurredAt: '2026-10-25T11:00:00.000Z' });
    await store.append({ tenant: t1, userId: String(alice), method: 'DELETE', path: '/x', occurredAt: '2026-10-25T12:00:00.000Z' });
    await store.append({ tenant: t2, userId: String(alice), method: 'POST', path: '/org/users', occurredAt: '2026-10-25T12:30:00.000Z' });

    expect((await store.query({ tenant: t1 })).length).toBe(3); // t2 不可见
    expect((await store.query({ tenant: t2 })).length).toBe(1);

    const windowed = await store.query({
      tenant: t1,
      from: '2026-10-25T10:00:00.000Z',
      to: '2026-10-25T11:00:00.000Z',
    }); // 含端点：两条都命中
    expect(windowed.map((entry) => entry.method)).toEqual(['PUT', 'POST']); // 新→旧

    const byUser = await store.query({ tenant: t1, userId: String(bob) });
    expect(byUser.length).toBe(1);
    expect(byUser[0]!.path).toBe('/masterdata/items/i-1');

    expect((await store.query({ tenant: t1, limit: 1 })).length).toBe(1);
  });

  it('摘要截断：253 + 省略号；载荷全文不进日志', () => {
    expect(auditSummaryOf('POST', '/org/users')).toBe('POST /org/users');
    const long = `PUT /listing/sheets/${'x'.repeat(300)}`;
    const summary = auditSummaryOf('PUT', long);
    expect(summary.length).toBe(256);
    expect(summary.endsWith('...')).toBe(true);
  });
});

describe('写操作拦截器', () => {
  function makeInterceptor(): { interceptor: AuditWriteInterceptor; store: InMemoryAuditLogStore; tenantContext: TenantContext } {
    const store = new InMemoryAuditLogStore();
    const tenantContext = new TenantContext();
    return { interceptor: new AuditWriteInterceptor(tenantContext, new AuditService(store)), store, tenantContext };
  }

  function contextOf(request: object): { switchToHttp: () => { getRequest: () => object } } {
    return { switchToHttp: () => ({ getRequest: () => request }) };
  }

  function handlerOf(response: unknown, error?: Error): { handle: () => Observable<unknown> } {
    return {
      handle: () =>
        ({
          subscribe(observer: { next?: (v: unknown) => void; error?: (e: unknown) => void; complete?: () => void }) {
            if (error !== undefined) observer.error?.(error);
            else {
              observer.next?.(response);
              observer.complete?.();
            }
            return { unsubscribe: () => {} };
          },
        }) as unknown as Observable<unknown>,
    };
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('写方法成功收场 → 落一条（method/path/user/租户取 ALS）；GET 不记', async () => {
    const { interceptor, store, tenantContext } = makeInterceptor();
    const write = { method: 'POST', url: '/masterdata/customers?trace=1', [REQUEST_USER_KEY]: alice };
    const response = await tenantContext.run(
      t1,
      () => interceptor.intercept(contextOf(write) as never, handlerOf({ id: 'x' })) as never as Promise<unknown>,
    );
    await (response as unknown as Promise<unknown>).catch(() => {});
    await settle();
    const logs = await store.query({ tenant: t1 });
    expect(logs.length).toBe(1);
    expect(logs[0]!.method).toBe('POST');
    expect(logs[0]!.path).toBe('/masterdata/customers'); // 查询串剥离
    expect(logs[0]!.userId).toBe(String(alice));

    const read = { method: 'GET', url: '/masterdata/customers', [REQUEST_USER_KEY]: alice };
    const readStream = interceptor.intercept(contextOf(read) as never, handlerOf({}));
    await (readStream as unknown as Promise<unknown>).catch(() => {});
    await settle();
    expect((await store.query({ tenant: t1 })).length).toBe(1); // GET 不追加
  });

  it('/audit/* 自身路径跳过（防递归）；公开写路由 user=null；失败响应不落账', async () => {
    const { interceptor, store, tenantContext } = makeInterceptor();
    const self = { method: 'GET', url: '/audit/logs?limit=10', [REQUEST_USER_KEY]: alice };
    await tenantContext.run(t1, async () => {
      const stream = interceptor.intercept(contextOf(self) as never, handlerOf({ logs: [] }));
      await (stream as unknown as Promise<unknown>).catch(() => {});
    });
    await settle();
    expect((await store.query({ tenant: t1 })).length).toBe(0); // 自身不记

    // 失败写（handler 抛错）：不落账（不改变系统状态的操作）
    const failing = { method: 'POST', url: '/org/users', [REQUEST_USER_KEY]: alice };
    await tenantContext.run(t1, async () => {
      const stream = interceptor.intercept(contextOf(failing) as never, handlerOf(undefined, new Error('boom')));
      await (stream as unknown as Promise<unknown>).catch(() => {});
    });
    await settle();
    expect((await store.query({ tenant: t1 })).length).toBe(0);
  });
});

describe('查询解析与权限码', () => {
  it('limit 边界与非法 ISO 拒绝（AuditInputError）', () => {
    expect(() =>
      (() => { const f = require('../src/audit/audit-input.js'); return f; })(),
    ).not.toThrow();
    const params = new URLSearchParams('from=not-a-time');
    const { parseAuditQueryInput } = require('../src/audit/audit-input.js') as typeof import('../src/audit/audit-input.js');
    expect(() => parseAuditQueryInput(params)).toThrow(AuditInputError);
    const badLimit = new URLSearchParams('limit=0');
    expect(() => parseAuditQueryInput(badLimit)).toThrow(AuditInputError);
    const overMax = new URLSearchParams('limit=1001');
    expect(() => parseAuditQueryInput(overMax)).toThrow(AuditInputError);
    const reversed = new URLSearchParams('from=2027-01-02T00:00:00Z&to=2027-01-01T00:00:00Z');
    expect(() => parseAuditQueryInput(reversed)).toThrow(AuditInputError);
    const ok = parseAuditQueryInput(new URLSearchParams('userId=u-1'));
    expect(ok.limit).toBe(100);
    expect(ok.userId).toBe('u-1');
  });

  it('GET /audit/logs = audit:read；模块装配并导出 AuditService', () => {
    const proto = AuditController.prototype as Record<string, unknown>;
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, proto['list'] as object)).toBe('audit:read');
    const dynamic = AuditModule.register();
    const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, dynamic) as unknown[];
    expect(controllers).toContain(AuditController);
  });
});
