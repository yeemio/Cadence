/**
 * 会话保活三规则纯判定测试（M1 收尾波-③；ADR-0009 参照 §3.1）：
 * 临期主动续期阈值、空闲仅页面可见且无进行中请求时累计。
 */
import { describe, expect, it } from 'vitest';
import {
  isIdleSessionExpired,
  PROACTIVE_REFRESH_THRESHOLD_MS,
  shouldProactivelyRefresh,
} from '../src/session-keepalive';

describe('规则 1：临期主动续期（剩余 TTL < 1/3 起）', () => {
  const expiresAt = Date.parse('2026-10-25T16:00:00.000Z'); // 签发 08:00，TTL 8h
  const threshold = PROACTIVE_REFRESH_THRESHOLD_MS; // ≈2h40m

  it('未到阈值不续期；到达阈值续期；过期后仍尝试（refresh 窗口语义由服务端收口）', () => {
    expect(shouldProactivelyRefresh(expiresAt, Date.parse('2026-10-25T12:00:00.000Z'), threshold)).toBe(false);
    expect(shouldProactivelyRefresh(expiresAt, Date.parse('2026-10-25T13:20:00.000Z'), threshold)).toBe(true);
    expect(shouldProactivelyRefresh(expiresAt, Date.parse('2026-10-25T17:00:00.000Z'), threshold)).toBe(true);
  });

  it('阈值 = 8h TTL 的 1/3（约 2 小时 40 分）', () => {
    expect(PROACTIVE_REFRESH_THRESHOLD_MS).toBe((8 * 60 * 60 * 1000) / 3);
  });
});

describe('规则 3：空闲计时仅在页面可见且无进行中请求时累计', () => {
  const base = {
    nowMs: Date.parse('2026-10-25T12:00:00.000Z'),
    lastActivityMs: Date.parse('2026-10-25T11:00:00.000Z'), // 距今 1h
    idleTimeoutMs: 30 * 60 * 1000, // 30min
    pageVisible: true,
    inFlightRequests: 0,
  };

  it('页面可见 + 无请求 + 超阈值 → 到点', () => {
    expect(isIdleSessionExpired(base)).toBe(true);
  });

  it('页面不可见 → 不计时（后台标签不累计）', () => {
    expect(isIdleSessionExpired({ ...base, pageVisible: false })).toBe(false);
  });

  it('有进行中请求 → 不判空闲', () => {
    expect(isIdleSessionExpired({ ...base, inFlightRequests: 1 })).toBe(false);
  });

  it('可见 + 无请求 + 未到阈值 → 未到点', () => {
    expect(isIdleSessionExpired({ ...base, lastActivityMs: base.nowMs - 10 * 60 * 1000 })).toBe(false);
  });
});
