/**
 * 大屏组合根单测（A8/A10 首波，6a-3 裁决 4：screen 域零测试补齐）：
 *  - parseDailyTenants：SMES_TENANTS 解析（trim/空/缺省单租户）；
 *  - **A10 存储装配链（裁决 1 锚定）**：MODULE_DEFINITIONS.screen 工厂实参
 *    恒带 machiningDailyStatsStore 键（options 注入优先；未注入 → 内存缺省）——
 *    修复前工厂调用处漏传该键，`!` 断言掩盖 → 端点 500；
 *  - ScreenFrameBroadcaster：无订阅零聚合、按订阅租户推帧、写面断连摘除；
 *    D-20 锚定：tick 逐租户经 runWithRlsTenant 包裹（双租户各收本租户非空帧）；
 *  - MachiningDailyScheduler.runOnce：逐租户跑批（前一自然日幂等落行）；
 *    D-20 同类锚定：runOnce 写面逐租户 RLS 会话包裹；
 *  - 纯函数：sseMessageOf / ssePreamble / nextDailyRunAt。
 * HTTP 面门禁与 SSE 真实通道见 screen-boot.e2e.test.ts；包裹失效防御
 * （skip+warn）见 screen-rls-guard.test.ts（vi.mock 隔离故障形态）。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TenantId, WorkOrderId } from '@smes/business-core';
import type { TenantId as TenantIdType } from '@smes/business-core';
import {
  DigitalOperationScreenService,
  InMemoryMachiningDailyStatsStore,
  MachiningDailyStatsService,
} from '@smes/application';
import type {
  MachiningDailyStatsStore,
  UpsertMachiningDailyStatsInput,
  WorkOrder,
} from '@smes/application';
// D-20 锚定用：读 store 侧 RLS 会话租户（与实现同源——rls-session 自持 ALS）
import { currentRlsTenant } from '@smes/business-store/org';
import {
  MODULE_DEFINITIONS,
  buildAppModule,
  parseModulesEnabled,
  type StorePorts,
} from '../src/app-registry.js';
import { parseDailyTenants } from '../src/screen-http.module.js';
import {
  MachiningDailyScheduler,
  ScreenFrameBroadcaster,
  nextDailyRunAt,
  sseMessageOf,
  ssePreamble,
} from '../src/screen-broadcast.js';

describe('parseDailyTenants（A10 跑批租户集解析）', () => {
  it('缺省/空串 → 单租户 default；逗号清单 trim 收口；品牌类型 TenantId', () => {
    expect(parseDailyTenants(undefined)).toEqual([TenantId.create('default')]);
    expect(parseDailyTenants('')).toEqual([TenantId.create('default')]);
    expect(parseDailyTenants(' , , ')).toEqual([TenantId.create('default')]);
    // 注：重复项不去重（runDaily 幂等 upsert，重复租户重跑无害——实现实态）
    expect(parseDailyTenants(' tenant-a , tenant-b ')).toEqual([
      TenantId.create('tenant-a'),
      TenantId.create('tenant-b'),
    ]);
  });
});

describe('A10 存储装配链（6a-3 裁决 1：screen 工厂实参传键断言）', () => {
  /**
   * 包裹 screen 工厂捕获实参（finally 恢复原工厂——注册表是可变 Record，
   * 不恢复会污染同进程其他测试的装配）。
   */
  async function withCapturedScreenFactory(
    run: (captured: readonly StorePorts[]) => Promise<void> | void,
  ): Promise<void> {
    const captured: StorePorts[] = [];
    const original = MODULE_DEFINITIONS['screen'];
    if (original === undefined) {
      throw new Error('前置违约：MODULE_DEFINITIONS.screen 未注册');
    }
    MODULE_DEFINITIONS['screen'] = (stores, wiring) => {
      captured.push(stores);
      return original(stores, wiring);
    };
    try {
      await run(captured);
    } finally {
      MODULE_DEFINITIONS['screen'] = original;
    }
  }

  it('screen 启用：工厂实参恒带 machiningDailyStatsStore（未注入 → 内存缺省实例）', async () => {
    await withCapturedScreenFactory(async (captured) => {
      buildAppModule(parseModulesEnabled('core,screen'));
      expect(captured).toHaveLength(1);
      const first = captured[0];
      expect(first).toBeDefined();
      expect(first?.machiningDailyStatsStore).toBeInstanceOf(InMemoryMachiningDailyStatsStore);
    });
  });

  it('options 注入优先：PG 句柄原样传到工厂（同一实例——main.ts connectMachiningDailyStore 链）', async () => {
    const injected = new InMemoryMachiningDailyStatsStore();
    await withCapturedScreenFactory(async (captured) => {
      buildAppModule(parseModulesEnabled('core,screen'), {
        machiningDailyStatsStore: injected,
      });
      expect(captured).toHaveLength(1);
      const first = captured[0];
      expect(first).toBeDefined();
      expect(first?.machiningDailyStatsStore).toBe(injected);
    });
  });

  it('screen 未启用：工厂不被调用（零构造开销）', async () => {
    await withCapturedScreenFactory(async (captured) => {
      buildAppModule(parseModulesEnabled('core'));
      expect(captured).toHaveLength(0);
    });
  });
});

describe('ScreenFrameBroadcaster（SSE 节拍推送）', () => {
  /** 计数聚合服务：无订阅零聚合的观察锚。 */
  class CountingScreenService extends DigitalOperationScreenService {
    buildCalls = 0;
    override async buildFrame(
      tenant: TenantIdType,
      now?: string,
    ): ReturnType<DigitalOperationScreenService['buildFrame']> {
      this.buildCalls += 1;
      return super.buildFrame(tenant, now);
    }
  }

  it('无订阅租户 → tick 零聚合（大屏没人看不空转）；有订阅 → 逐租户一帧 data: 下行', async () => {
    const screen = new CountingScreenService({});
    const broadcaster = new ScreenFrameBroadcaster(screen, 5_000);
    await broadcaster.tick();
    expect(screen.buildCalls).toBe(0);

    const tenantA: string[] = [];
    const tenantB: string[] = [];
    const unsubscribeA = broadcaster.subscribe(TenantId.create('ta'), { write: (chunk) => void tenantA.push(chunk) });
    broadcaster.subscribe(TenantId.create('tb'), { write: (chunk) => void tenantB.push(chunk) });
    expect(broadcaster.subscribedTenantCount).toBe(2);
    await broadcaster.tick();
    expect(screen.buildCalls).toBe(2);
    expect(tenantA).toHaveLength(1);
    expect(tenantA[0]).toMatch(/^data: \{"type":"digital_operation\.snapshot"/);
    expect(tenantB).toHaveLength(1);

    // 撤销后该租户退出节拍
    unsubscribeA();
    expect(broadcaster.subscribedTenantCount).toBe(1);
    await broadcaster.tick();
    expect(screen.buildCalls).toBe(3);
    expect(tenantA).toHaveLength(1); // 撤销后不再收帧
  });

  it('写面抛错（连接半开）→ 摘除订阅者不炸节拍；stop 清空订阅', async () => {
    const screen = new DigitalOperationScreenService({});
    const broadcaster = new ScreenFrameBroadcaster(screen, 5_000);
    const frames: string[] = [];
    broadcaster.subscribe(TenantId.create('ta'), {
      write: () => {
        throw new Error('connection reset');
      },
    });
    broadcaster.subscribe(TenantId.create('ta'), { write: (chunk) => void frames.push(chunk) });
    await expect(broadcaster.tick()).resolves.toBeUndefined(); // 半开摘除，好连接照常收帧
    expect(frames).toHaveLength(1);
    expect(broadcaster.subscribedTenantCount).toBe(1);

    broadcaster.start(); // 幂等启动
    broadcaster.stop();
    expect(broadcaster.subscribedTenantCount).toBe(0);
  });

  /** D-20 造数：一条在制工作令（KPI③/项目进度行的最小读面）。 */
  function inProgressOrder(tenant: string, id: string, projectName: string): WorkOrder {
    return {
      id: WorkOrderId.create(id),
      tenant: TenantId.create(tenant),
      flowConfigId: 'wo-nine-state',
      state: 'executing',
      objectVersion: 1,
      customerRef: null,
      projectName,
      salesRep: null,
      manager: null,
      plannedDeliveryAt: null,
      packagingArrivalAt: null,
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
    };
  }

  it('D-20：tick 聚合逐租户经 runWithRlsTenant 包裹——双租户各收本租户非空帧（修复前回落 default 读 0 推空帧）', async () => {
    // 读面记录「订阅租户@聚合时 RLS 会话租户」——包裹正确则两者恒相等
    const seenContexts: string[] = [];
    const ordersByTenant = new Map<string, readonly WorkOrder[]>([
      ['tenant-a', [inProgressOrder('tenant-a', 'wo-a1', '项目A-1'), inProgressOrder('tenant-a', 'wo-a2', '项目A-2')]],
      ['tenant-b', [inProgressOrder('tenant-b', 'wo-b1', '项目B-1')]],
    ]);
    const screen = new DigitalOperationScreenService({
      workOrders: {
        list: async (tenant) => {
          seenContexts.push(`${String(tenant)}@${String(currentRlsTenant())}`);
          return ordersByTenant.get(String(tenant)) ?? [];
        },
      },
    });
    const broadcaster = new ScreenFrameBroadcaster(
      screen,
      5_000,
      () => new Date('2026-10-26T08:30:00.000Z'),
    );
    const framesA: string[] = [];
    const framesB: string[] = [];
    broadcaster.subscribe(TenantId.create('tenant-a'), { write: (chunk) => void framesA.push(chunk) });
    broadcaster.subscribe(TenantId.create('tenant-b'), { write: (chunk) => void framesB.push(chunk) });
    await broadcaster.tick();

    // 每租户聚合发生在本租户 RLS 会话内（store 事务 SET app.current_tenant 的租户源）
    expect(seenContexts).toEqual(['tenant-a@tenant-a', 'tenant-b@tenant-b']);

    // 双租户各收本租户非空帧（数据面隔离：a 两令/b 一令，互不可见）
    const payloadOf = (raw: string): {
      kpi: { inProgressWorkOrders: number | null };
      projectProgressRows: { projectName: string }[];
    } => {
      const envelope = JSON.parse(raw.slice('data: '.length).trim()) as {
        payload: { kpi: { inProgressWorkOrders: number | null }; projectProgressRows: { projectName: string }[] };
      };
      return envelope.payload;
    };
    expect(framesA).toHaveLength(1);
    expect(payloadOf(framesA[0]!).kpi.inProgressWorkOrders).toBe(2);
    expect(payloadOf(framesA[0]!).projectProgressRows.map((row) => row.projectName)).toEqual(['项目A-1', '项目A-2']);
    expect(framesB).toHaveLength(1);
    expect(payloadOf(framesB[0]!).kpi.inProgressWorkOrders).toBe(1);
    expect(payloadOf(framesB[0]!).projectProgressRows.map((row) => row.projectName)).toEqual(['项目B-1']);
  });
});

describe('MachiningDailyScheduler.runOnce（A10 跑批逐租户）', () => {
  it('一轮对全部租户落前一日行（幂等 upsert 同一日覆盖不重行）', async () => {
    const store = new InMemoryMachiningDailyStatsStore();
    const daily = new MachiningDailyStatsService(store);
    const scheduler = new MachiningDailyScheduler(daily, [
      TenantId.create('ta'),
      TenantId.create('tb'),
    ]);
    await scheduler.runOnce('2026-10-26T12:00:00.000Z');
    expect((await store.listRecent(TenantId.create('ta'), 30)).map((row) => row.statisticsDate)).toEqual(['2026-10-25']);
    expect((await store.listRecent(TenantId.create('tb'), 30)).map((row) => row.statisticsDate)).toEqual(['2026-10-25']);
    await scheduler.runOnce('2026-10-26T13:00:00.000Z'); // 重跑同日
    expect(await store.listRecent(TenantId.create('ta'), 30)).toHaveLength(1);
  });

  it('D-20 同类：runOnce 写面逐租户经 runWithRlsTenant 包裹（跑批租户 = RLS 会话租户）', async () => {
    const inner = new InMemoryMachiningDailyStatsStore();
    const seenContexts: string[] = [];
    const observing: MachiningDailyStatsStore = {
      upsert: (input: UpsertMachiningDailyStatsInput) => {
        seenContexts.push(`${String(input.tenant)}@${String(currentRlsTenant())}`);
        return inner.upsert(input);
      },
      find: (tenant, statisticsDate) => inner.find(tenant, statisticsDate),
      findLatest: (tenant) => inner.findLatest(tenant),
      listRecent: (tenant, days) => inner.listRecent(tenant, days),
    };
    const scheduler = new MachiningDailyScheduler(new MachiningDailyStatsService(observing), [
      TenantId.create('ta'),
      TenantId.create('tb'),
    ]);
    await scheduler.runOnce('2026-10-26T12:00:00.000Z');
    expect(seenContexts).toEqual(['ta@ta', 'tb@tb']);
  });
});

describe('SSE 报文与跑批时点纯函数', () => {
  it('sseMessageOf：data: + JSON + 双换行（EventSource onmessage 直收形态）', () => {
    const message = sseMessageOf({ type: 'digital_operation.snapshot', ts: 1, payload: null });
    expect(message).toBe(`data: {"type":"digital_operation.snapshot","ts":1,"payload":null}\n\n`);
  });

  it('ssePreamble：retry 3s 重连提示 + 注释行即刻刷缓冲', () => {
    expect(ssePreamble()).toBe('retry: 3000\n: stream open\n\n');
  });

  it('nextDailyRunAt：now 之后首个 UTC 00:10（00:05 → 当日；00:10 起 → 次日）', () => {
    expect(nextDailyRunAt(new Date('2026-10-26T00:05:00.000Z')).toISOString()).toBe('2026-10-26T00:10:00.000Z');
    expect(nextDailyRunAt(new Date('2026-10-26T00:10:00.000Z')).toISOString()).toBe('2026-10-27T00:10:00.000Z');
    expect(nextDailyRunAt(new Date('2026-10-26T23:59:00.000Z')).toISOString()).toBe('2026-10-27T00:10:00.000Z');
  });
});
