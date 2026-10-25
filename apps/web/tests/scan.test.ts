/**
 * 扫码装配接线测试（M1 收尾波-②，node 纯逻辑）：
 * 证明 product-ui 泛型扫码视图模型能以 integration-scan 的真实形状
 * （ScannerTier / ScanResult / ScanError / planScanChain / isDegradableScanError）
 * 结构兼容接入（ADR-0011：web 是唯一允许同时消费两包的组合根）。
 */
import { describe, expect, it } from 'vitest';
import {
  isDegradableScanError,
  makeScanError,
  makeScanResult,
  createScanCode,
  planScanChain,
} from '@smes/integration-scan';
import type { ScanError, ScanResult, ScannerTier } from '@smes/integration-scan';
import { createScanSessionModel, detectImContainer } from '@smes/product-ui';

function wireSession(camera: boolean, deviceWedge = true) {
  const plan = planScanChain({ camera, imContainer: false, deviceWedge });
  return createScanSessionModel<ScannerTier, ScanResult, ScanError>({
    tiers: plan.tiers,
    isDegradableError: isDegradableScanError,
  });
}

describe('扫码降级链装配（integration-scan × product-ui 结构兼容）', () => {
  it('有摄像头：链 = camera → wedge，首选 camera', () => {
    const session = wireSession(true);
    const state = session.getState();
    expect(state.tiers).toEqual(['tier1-camera', 'tier3-device-wedge']);
    expect(state.currentTier).toBe('tier1-camera');
  });

  it('无摄像头（如 HTTP 非安全上下文）：链直接落到扫码枪', () => {
    const session = wireSession(false);
    expect(session.getState().currentTier).toBe('tier3-device-wedge');
  });

  it('真实 ScanError 驱动自动降级：permission-denied → 落到扫码枪并记历史', () => {
    const session = wireSession(true);
    session.start();
    session.pushError(
      makeScanError('tier1-camera', 'permission-denied', 'camera permission denied: NotAllowedError'),
    );
    const degraded = session.getState();
    expect(degraded.currentTier).toBe('tier3-device-wedge');
    expect(degraded.degradations).toHaveLength(1);
    expect(degraded.degradations[0]).toMatchObject({
      fromTier: 'tier1-camera',
      toTier: 'tier3-device-wedge',
    });

    // 扫码枪链尾再报可降级错误 → 链耗尽
    session.pushError(makeScanError('tier3-device-wedge', 'unavailable', 'wedge source gone'));
    expect(session.getState().status).toBe('exhausted');
  });

  it('真实 ScanResult 入列（makeScanResult 产物直接进最近结果列表）', () => {
    const session = wireSession(false);
    session.start();
    session.pushResult(
      makeScanResult({
        code: createScanCode('WO-2026-0042'),
        tier: 'tier3-device-wedge',
        scannedAt: '2026-10-25T10:00:00.000Z',
      }),
    );
    const state = session.getState();
    expect(state.recentResults).toHaveLength(1);
    expect(state.recentResults[0]?.code).toBe('WO-2026-0042');
    expect(state.recentResults[0]?.tier).toBe('tier3-device-wedge');
  });

  it('解码噪声（decode-failed）不打断会话、不降档', () => {
    const session = wireSession(true);
    session.start();
    session.pushError(makeScanError('tier1-camera', 'decode-failed', 'continuous decode failure'));
    const state = session.getState();
    expect(state.status).toBe('active');
    expect(state.currentTier).toBe('tier1-camera');
    expect(state.lastError?.kind).toBe('decode-failed');
  });

  it('容器探测纯函数在真实 UA 形状上的三态（浏览器侧横幅数据源）', () => {
    expect(detectImContainer({ userAgent: 'Mozilla/5.0 ... Chrome/130' })).toBe('browser');
    expect(detectImContainer({ userAgent: 'Mozilla/5.0 wxwork/4.1 MicroMessenger' })).toBe('wecom');
    expect(detectImContainer({ userAgent: 'Mozilla/5.0 feishu/7.22' })).toBe('feishu');
  });
});
