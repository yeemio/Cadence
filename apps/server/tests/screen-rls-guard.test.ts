/**
 * D-20 防御锚单测（与 screen-http.test.ts 分文件——vi.mock 文件级生效）：
 * tick 的租户包裹失效（runWithRlsTenant 被绕过/移除/失效的故障形态）时，
 * 聚合会话租户与订阅租户分叉 → **不推可能失真的帧**：跳过推送 + warn，
 * 订阅端保持上一好帧（取舍见 screen-broadcast.ts 文件头 D-20 节——不加
 * degraded 字段，帧信封是源契约冻结面）。
 *
 * 桩法：vi.mock 部分替换 '@smes/business-store/org' 的 runWithRlsTenant 为
 * 直通（模拟"包裹缺失"——即 D-20 修复前的实态）；currentRlsTenant 保持真实
 * （无 ALS 时回落 'default'，故障形态下订阅租户 ≠ 会话租户即由此可观察）。
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TenantId } from '@smes/business-core';
import { DigitalOperationScreenService } from '@smes/application';
import { currentRlsTenant } from '@smes/business-store/org';
import type { TenantId as TenantIdType } from '@smes/business-core';
import { ScreenFrameBroadcaster } from '../src/screen-broadcast.js';

vi.mock('@smes/business-store/org', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@smes/business-store/org')
  >();
  return {
    ...actual,
    // 直通 = 包裹缺失故障形态（D-20 修复前：定时器聚合无租户会话）
    runWithRlsTenant: <T>(_tenant: TenantIdType, fn: () => T): T => fn(),
  };
});

describe('D-20 防御：租户包裹失效时跳过推送 + warn（不推失真帧）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('订阅租户 ≠ 回落会话租户（tenant-a vs default）→ 零帧下行 + 结构化 warn；订阅保留', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const screen = new DigitalOperationScreenService({});
    const broadcaster = new ScreenFrameBroadcaster(
      screen,
      5_000,
      () => new Date('2026-10-26T08:30:00.000Z'),
    );
    const frames: string[] = [];
    broadcaster.subscribe(TenantId.create('tenant-a'), {
      write: (chunk) => void frames.push(chunk),
    });
    expect(String(currentRlsTenant())).toBe('default'); // 前置：故障形态的会话回落值

    await broadcaster.tick();

    expect(frames).toHaveLength(0); // 不推可能失真的空帧
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0]?.join(' '));
    expect(message).toContain('tenant=tenant-a');
    expect(message).toContain('mismatch');
    expect(message).toContain('active=default');
    // 订阅不摘除（防御跳过 ≠ 连接故障）——包裹恢复后下一节拍照常推帧
    expect(broadcaster.subscribedTenantCount).toBe(1);
  });

  it('对照组：回落会话租户恰为订阅租户（default，单机形态）→ 直通不触发防御，帧照常下行', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const screen = new DigitalOperationScreenService({});
    const broadcaster = new ScreenFrameBroadcaster(
      screen,
      5_000,
      () => new Date('2026-10-26T08:30:00.000Z'),
    );
    const frames: string[] = [];
    broadcaster.subscribe(TenantId.create('default'), {
      write: (chunk) => void frames.push(chunk),
    });
    await broadcaster.tick();

    expect(frames).toHaveLength(1); // 会话与订阅同租户：帧不失真，防御不拦
    expect(frames[0]).toMatch(/^data: \{"type":"digital_operation\.snapshot"/);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
