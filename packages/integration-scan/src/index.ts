// 占位：见 architecture/status.md 与 ADR-0003/0004。落地里程碑见仓库 README。
export const INTEGRATION_SCAN_PLACEHOLDER = 'integration-scan:stub';

// ---- 解码结果形状（Done-when 5，词汇过 ADR-0010 三问：通用词） ----
export type {
  ScannerTier,
  ScanCode,
  DeviceId,
  ScanResult,
  ScanResultInput,
} from './scan-result.js';
export {
  SCANNER_TIERS,
  isScannerTier,
  MAX_SCAN_CODE_LENGTH,
  createScanCode,
  isScanCode,
  createDeviceId,
  isDeviceId,
  makeScanResult,
  isScanResult,
} from './scan-result.js';

// ---- 统一端口（Done-when 2） ----
export type { Unsubscribe, ScanErrorKind, ScanError, ScannerPort } from './scanner-port.js';
export { makeScanError, isScanError } from './scanner-port.js';

// ---- Tier1：浏览器摄像头（html5-qrcode 懒加载适配器，M1 收尾波-②） ----
export type {
  CameraScannerPort,
  CameraScannerOptions,
  CameraFacingMode,
  CameraScanTarget,
  CameraSupportEnvironment,
  Html5QrcodeLike,
  Html5QrcodeModuleLike,
} from './tier1-camera.js';
export { createCameraScanner, hasCameraSupport } from './tier1-camera.js';

// ---- Tier2：IM JS-SDK 桥端口（桥由 integration-im 侧实现） ----
export type { ImScanBridge, ImSdkScannerPort, ImSdkScannerOptions } from './tier2-im-sdk.js';
export { createImSdkScanner, DEFAULT_IM_SCAN_TIMEOUT_MS } from './tier2-im-sdk.js';

// ---- Tier3：外设扫码枪（键盘串入监听端口） ----
export type {
  WedgeKeystrokeSource,
  DeviceWedgeScannerPort,
  DeviceWedgeScannerOptions,
} from './tier3-device-wedge.js';
export { createDeviceWedgeScanner } from './tier3-device-wedge.js';

// ---- 能力探测输入与降级决策（Done-when 3，纯函数） ----
export type { ScannerCapabilities, ScanPlan } from './capabilities.js';
export {
  SCANNER_TIER_ORDER,
  planScanChain,
  stepDown,
  NoScannerAvailableError,
  isDegradableScanError,
} from './capabilities.js';

// ---- 键盘串入解析器（Done-when 4，纯函数） ----
export type {
  WedgeKeyStroke,
  WedgeParserOptions,
  WedgeParserState,
  WedgeRejectReason,
  WedgeParseEvent,
} from './wedge-parser.js';
export {
  DEFAULT_WEDGE_PARSER_OPTIONS,
  resolveWedgeParserOptions,
  nextWedgeParserState,
  parseWedgeSequence,
} from './wedge-parser.js';
