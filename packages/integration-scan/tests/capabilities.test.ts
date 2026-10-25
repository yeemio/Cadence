import { describe, expect, it } from 'vitest';
import {
  isDegradableScanError,
  makeScanError,
  NoScannerAvailableError,
  planScanChain,
  stepDown,
  type ScannerCapabilities,
} from '../src/index.js';

const all: ScannerCapabilities = { camera: true, imContainer: true, deviceWedge: true };

describe('降级决策纯函数（Done-when 3 四分支）', () => {
  it('全可用：取一档，链为完整三档序', () => {
    const plan = planScanChain(all);
    expect(plan.entry).toBe('tier1-camera');
    expect(plan.tiers).toEqual(['tier1-camera', 'tier2-im-sdk', 'tier3-device-wedge']);
    expect(Object.isFrozen(plan.tiers)).toBe(true);
  });

  it('一档失败：降二档', () => {
    const plan = planScanChain(all);
    const next = stepDown(plan, 'tier1-camera');
    expect(next?.entry).toBe('tier2-im-sdk');
    expect(next?.tiers).toEqual(['tier2-im-sdk', 'tier3-device-wedge']);
  });

  it('二档不可用：落三档（链上直接跳过不可用档）', () => {
    // 仅二、三档在：首取三档
    const onlyT3 = planScanChain({ camera: false, imContainer: false, deviceWedge: true });
    expect(onlyT3.entry).toBe('tier3-device-wedge');
    expect(onlyT3.tiers).toEqual(['tier3-device-wedge']);

    // 一档可用、二档不可用：一档失败后直接落三档
    const noIm = planScanChain({ camera: true, imContainer: false, deviceWedge: true });
    expect(noIm.tiers).toEqual(['tier1-camera', 'tier3-device-wedge']);
    expect(stepDown(noIm, 'tier1-camera')?.entry).toBe('tier3-device-wedge');
  });

  it('全不可用：报 NoScannerAvailable', () => {
    const none: ScannerCapabilities = { camera: false, imContainer: false, deviceWedge: false };
    expect(() => planScanChain(none)).toThrow(NoScannerAvailableError);
    try {
      planScanChain(none);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).name).toBe('NoScannerAvailableError');
    }
  });
});

describe('stepDown 边界', () => {
  it('链耗尽返回 null', () => {
    const plan = planScanChain({ camera: false, imContainer: false, deviceWedge: true });
    expect(stepDown(plan, 'tier3-device-wedge')).toBeNull();
  });

  it('末档失败返回 null；不在链内的失败档按首选档失败处理', () => {
    const plan = planScanChain(all);
    expect(stepDown(plan, 'tier3-device-wedge')).toBeNull();
    // failedTier（tier2）不在链 [tier1, tier3] 内：按 entry 失败推进到下一档
    const twoTiers = planScanChain({ camera: true, imContainer: false, deviceWedge: true });
    expect(stepDown(twoTiers, 'tier2-im-sdk')?.entry).toBe('tier3-device-wedge');
  });
});

describe('可降级失败判定', () => {
  it('unavailable / permission-denied / timeout 可降级；decode-failed / malformed-input 不降级', () => {
    expect(isDegradableScanError(makeScanError('tier1-camera', 'unavailable', 'x'))).toBe(true);
    expect(isDegradableScanError(makeScanError('tier1-camera', 'permission-denied', 'x'))).toBe(true);
    expect(isDegradableScanError(makeScanError('tier2-im-sdk', 'timeout', 'x'))).toBe(true);
    expect(isDegradableScanError(makeScanError('tier1-camera', 'decode-failed', 'x'))).toBe(false);
    expect(isDegradableScanError(makeScanError('tier3-device-wedge', 'malformed-input', 'x'))).toBe(false);
    expect(isDegradableScanError(makeScanError('tier2-im-sdk', 'unknown', 'x'))).toBe(false);
  });

  it('ScanError 冻结且 cause 可选回填', () => {
    const error = makeScanError('tier1-camera', 'unavailable', 'no camera', new Error('root'));
    expect(Object.isFrozen(error)).toBe(true);
    expect((error.cause as Error).message).toBe('root');
    expect('cause' in makeScanError('tier1-camera', 'unavailable', 'no camera')).toBe(false);
  });
});
