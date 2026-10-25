/**
 * 能力探测输入 + 降级决策纯函数（M1 增量 3-F，Done-when 3）
 *
 * 边界：能力"探测"本身（getUserMedia 存在性与授权、IM 容器 / SDK ready、
 * 外设串入源挂接）是环境相关动作，由接线层实现并折算成布尔；本模块只做
 * 纯决策：能力集 → 按序降级链（planScanChain）与档位推进（stepDown）。
 * 探测时机假设：进入扫码页面时探测一次，失败降级换档时接线层可复核。
 */
import { SCANNER_TIERS, type ScannerTier } from './scan-result.js';
import type { ScanError } from './scanner-port.js';

/** 三档固定优先序：浏览器摄像头 → IM JS-SDK → 外设扫码枪（与 SCANNER_TIERS 同源） */
export const SCANNER_TIER_ORDER: readonly ScannerTier[] = SCANNER_TIERS;

export interface ScannerCapabilities {
  /** 浏览器摄像头可用（mediaDevices 存在 + 授权通过） */
  readonly camera: boolean;
  /** 运行在具备 JS-SDK 扫码能力的 IM 容器内（企微 / 飞书等，由桥实现方探测） */
  readonly imContainer: boolean;
  /** 外设扫码枪在线（键盘串入源已挂接） */
  readonly deviceWedge: boolean;
}

export interface ScanPlan {
  /** 按序尝试的降级链（非空、冻结） */
  readonly tiers: readonly ScannerTier[];
  /** 首选档 */
  readonly entry: ScannerTier;
}

/** 全档不可用（Done-when 3 第 4 分支） */
export class NoScannerAvailableError extends Error {
  constructor(message = 'no scanner tier available: camera / imContainer / deviceWedge are all unavailable') {
    super(message);
    this.name = 'NoScannerAvailableError';
  }
}

const TIER_CAPABILITY: Record<ScannerTier, keyof ScannerCapabilities> = {
  'tier1-camera': 'camera',
  'tier2-im-sdk': 'imContainer',
  'tier3-device-wedge': 'deviceWedge',
};

/** 能力集 → 降级链：按固定优先序过滤可用档；全不可用抛 NoScannerAvailableError */
export function planScanChain(capabilities: ScannerCapabilities): ScanPlan {
  const tiers = SCANNER_TIER_ORDER.filter((tier) => capabilities[TIER_CAPABILITY[tier]] === true);
  const entry = tiers[0];
  if (entry === undefined) {
    throw new NoScannerAvailableError();
  }
  return Object.freeze({ tiers: Object.freeze(tiers), entry });
}

/**
 * 档位推进：失败档之后的剩余链。链耗尽返回 null（调用方提示人工兜底）。
 * failedTier 不在链内时按"首选档失败"处理（推进到第二档），防御接线层状态漂移。
 */
export function stepDown(plan: ScanPlan, failedTier: ScannerTier): ScanPlan | null {
  const index = plan.tiers.indexOf(failedTier);
  const rest = plan.tiers.slice(index >= 0 ? index + 1 : 1);
  const entry = rest[0];
  if (entry === undefined) return null;
  return Object.freeze({ tiers: Object.freeze(rest), entry });
}

/**
 * 可降级失败类别：能力缺失 / 权限被拒 / 超时。
 * decode-failed（相机前无码，连续扫码常态噪声）与 malformed-input（坏输入，
 * 重试本档即可）不触发降级——避免无码可扫时链被自动打散。
 */
const DEGRADABLE_SCAN_ERROR_KINDS: ReadonlySet<ScanError['kind']> = new Set([
  'unavailable',
  'permission-denied',
  'timeout',
]);

export function isDegradableScanError(error: ScanError): boolean {
  return DEGRADABLE_SCAN_ERROR_KINDS.has(error.kind);
}
