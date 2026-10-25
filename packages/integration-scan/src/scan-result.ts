/**
 * 扫码统一解码结果形状（M1 增量 3-F，Done-when 5）
 *
 * 词汇通用性（ADR-0010 三问）：
 * 1. 扫码只在单一行业有意义？——否，离散制造 / 物流 / 零售通用的数据采集动作；
 * 2. 能否重述为通用上位概念？——ScanCode / ScanResult / ScannerTier 本身已是
 *    厂商与码制无关的上位词，无需再上位化；
 * 3. 已有通用上位概念可挂靠？——business-core 现集（Tenant/User/WorkOrder…）
 *    无采集类概念，本包即其边缘实现，不回填内核。
 * 厂商词（企微 / 飞书等）只出现在注释与 README，不进导出词汇（接口用 Im 泛称）。
 *
 * 品牌化复用 business-core 的 Brand 机制（ADR-0003 #2）。码内容不直接用
 * defineId：其运行时上限 128 字符对 QR 载荷（GS1 / JSON 可超）过紧，故本地
 * 取 2048 上限；机制同源（类型级身份、零运行时开销），约束按扫码域口径。
 */
import type { Brand } from '@smes/business-core';

/** 三档档位标识（按降级优先序排列） */
export type ScannerTier = 'tier1-camera' | 'tier2-im-sdk' | 'tier3-device-wedge';

export const SCANNER_TIERS: readonly ScannerTier[] = Object.freeze([
  'tier1-camera',
  'tier2-im-sdk',
  'tier3-device-wedge',
]);

export function isScannerTier(value: unknown): value is ScannerTier {
  return typeof value === 'string' && (SCANNER_TIERS as readonly string[]).includes(value);
}

/** 码内容（品牌化）：非空、无控制字符、不 trim、≤2048 字符 */
export type ScanCode = Brand<string, 'ScanCode'>;

/** 外设 / 终端设备标识（品牌化）：非空、≤128 字符 */
export type DeviceId = Brand<string, 'DeviceId'>;

export const MAX_SCAN_CODE_LENGTH = 2048;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function createScanCode(value: string): ScanCode {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('invalid scan code: expected a non-empty string');
  }
  if (value.length > MAX_SCAN_CODE_LENGTH) {
    throw new Error(
      `invalid scan code: expected at most ${MAX_SCAN_CODE_LENGTH} chars, got ${value.length}`,
    );
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new Error('invalid scan code: control characters are not allowed');
  }
  return value as ScanCode;
}

export function isScanCode(value: unknown): value is ScanCode {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SCAN_CODE_LENGTH &&
    !CONTROL_CHARACTERS.test(value)
  );
}

export function createDeviceId(value: string): DeviceId {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw new Error('invalid deviceId: expected a non-empty string of 1~128 chars');
  }
  return value as DeviceId;
}

export function isDeviceId(value: unknown): value is DeviceId {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}

export interface ScanResult {
  /** 码值（品牌化，原样保留不 trim） */
  readonly code: ScanCode;
  /** 来源档位 */
  readonly tier: ScannerTier;
  /** ISO 8601，解码完成时刻 */
  readonly scannedAt: string;
  /** 设备标识：Tier3 外设可带；摄像头 / IM 档通常省略 */
  readonly deviceId?: DeviceId;
}

export interface ScanResultInput {
  readonly code: ScanCode;
  readonly tier: ScannerTier;
  readonly scannedAt: string;
  readonly deviceId?: DeviceId;
}

/** 构造即冻结的统一解码结果（ADR-0003 #4 不可变快照纪律） */
export function makeScanResult(input: ScanResultInput): ScanResult {
  const { code, tier, scannedAt, deviceId } = input;
  if (!isScanCode(code)) {
    throw new Error('invalid scan result: code must be a valid ScanCode');
  }
  if (!isScannerTier(tier)) {
    throw new Error(`invalid scan result: tier must be one of ${SCANNER_TIERS.join(' / ')}`);
  }
  if (typeof scannedAt !== 'string' || Number.isNaN(Date.parse(scannedAt))) {
    throw new Error('invalid scan result: scannedAt must be an ISO 8601 date-time string');
  }
  if (deviceId !== undefined && !isDeviceId(deviceId)) {
    throw new Error('invalid scan result: deviceId must be a valid DeviceId when present');
  }
  return Object.freeze<ScanResult>({
    code,
    tier,
    scannedAt,
    ...(deviceId === undefined ? {} : { deviceId }),
  });
}

export function isScanResult(value: unknown): value is ScanResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isScanCode(candidate['code']) &&
    isScannerTier(candidate['tier']) &&
    typeof candidate['scannedAt'] === 'string' &&
    !Number.isNaN(Date.parse(candidate['scannedAt'])) &&
    (candidate['deviceId'] === undefined || isDeviceId(candidate['deviceId']))
  );
}
