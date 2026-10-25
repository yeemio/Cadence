import { describe, expect, it } from 'vitest';
import {
  createDeviceId,
  createScanCode,
  isDeviceId,
  isScanCode,
  isScanResult,
  makeScanResult,
} from '../src/index.js';

describe('ScanCode / DeviceId 品牌化', () => {
  it('createScanCode 接受普通码值（含空格，不 trim）', () => {
    expect(createScanCode('WO-2026-0001')).toBe('WO-2026-0001');
    expect(createScanCode('AB 123')).toBe('AB 123');
  });

  it('createScanCode 拒绝空串 / 超长 / 控制字符', () => {
    expect(() => createScanCode('')).toThrow();
    expect(() => createScanCode('x'.repeat(2049))).toThrow();
    expect(() => createScanCode('AB\x1bC')).toThrow();
  });

  it('isScanCode 做同款运行时校验', () => {
    expect(isScanCode('WO-1')).toBe(true);
    expect(isScanCode('')).toBe(false);
    expect(isScanCode(42)).toBe(false);
  });

  it('createDeviceId 拒绝空 / 纯空白 / 超长', () => {
    expect(createDeviceId('wedge-station-01')).toBe('wedge-station-01');
    expect(() => createDeviceId('')).toThrow();
    expect(() => createDeviceId('   ')).toThrow();
    expect(() => createDeviceId('x'.repeat(129))).toThrow();
    expect(isDeviceId('d1')).toBe(true);
    expect(isDeviceId('')).toBe(false);
  });
});

describe('ScanResult 统一形状', () => {
  const code = createScanCode('WO-2026-0001');

  it('四要素齐备：码值品牌化、来源档位、时间戳、设备标识可空', () => {
    const result = makeScanResult({
      code,
      tier: 'tier3-device-wedge',
      scannedAt: '2026-10-25T10:00:00.000Z',
    });
    expect(result.code).toBe('WO-2026-0001');
    expect(result.tier).toBe('tier3-device-wedge');
    expect(result.scannedAt).toBe('2026-10-25T10:00:00.000Z');
    expect('deviceId' in result).toBe(false);
  });

  it('带 deviceId 时回填', () => {
    const deviceId = createDeviceId('wedge-01');
    const result = makeScanResult({
      code,
      tier: 'tier3-device-wedge',
      scannedAt: '2026-10-25T10:00:00.000Z',
      deviceId,
    });
    expect(result.deviceId).toBe('wedge-01');
  });

  it('构造即冻结', () => {
    const result = makeScanResult({ code, tier: 'tier1-camera', scannedAt: '2026-10-25T10:00:00.000Z' });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('拒绝坏档位 / 坏时间戳 / 坏设备标识', () => {
    expect(() =>
      makeScanResult({ code, tier: 'tier4-drone' as never, scannedAt: '2026-10-25T10:00:00.000Z' }),
    ).toThrow(/tier/);
    expect(() => makeScanResult({ code, tier: 'tier1-camera', scannedAt: 'not-a-date' })).toThrow(
      /scannedAt/,
    );
    expect(() =>
      makeScanResult({ code, tier: 'tier1-camera', scannedAt: '2026-10-25T10:00:00.000Z', deviceId: '' as never }),
    ).toThrow(/deviceId/);
  });

  it('isScanResult 结构校验', () => {
    const result = makeScanResult({ code, tier: 'tier2-im-sdk', scannedAt: '2026-10-25T10:00:00.000Z' });
    expect(isScanResult(result)).toBe(true);
    expect(isScanResult({ code: 'X', tier: 'tier1-camera' })).toBe(false);
    expect(isScanResult(null)).toBe(false);
  });
});
