# integration-scan（三档扫码降级链）

M1 增量 3-F。三档扫码能力的端口与降级决策逻辑：能力探测 → 按序降级 → 统一解码
结果形状。纯域可测（不开真摄像头、不真调厂商 SDK）。

## 三档（统一实现 `ScannerPort`：start / stop / onResult / onError）

| 档位 | 端口 | 承载 | 现状 |
| --- | --- | --- | --- |
| Tier1 | `CameraScannerPort`（`createCameraScanner`） | 浏览器摄像头（html5-qrcode 封装） | 真实适配器（M1 收尾波-②）：动态 import 懒加载 + 能力探测 `hasCameraSupport` + 降级白名单错误映射；测试注入 mock 模块（不真开摄像头） |
| Tier2 | `ImSdkScannerPort`（`createImSdkScanner`） | IM JS-SDK 扫码（企微/飞书等） | 桥注入可运行实现；once 语义（模态单次） |
| Tier3 | `DeviceWedgeScannerPort`（`createDeviceWedgeScanner`） | 外设扫码枪（键盘串入） | 按键源注入可运行实现；解析由 `wedge-parser` 纯函数承担 |

## 降级决策（纯函数，`capabilities.ts`）

- `planScanChain(ScannerCapabilities)` → `ScanPlan`：按固定优先序
  camera → im-sdk → device-wedge 过滤可用档，产出按序降级链与首选档；
  全不可用抛 `NoScannerAvailableError`。
- `stepDown(plan, failedTier)` → 剩余链或 null（链耗尽，转人工兜底）。
- `isDegradableScanError(error)`：仅 unavailable / permission-denied / timeout
  可降级；decode-failed（相机前无码的常态噪声）与 malformed-input 不降级，
  避免无码可扫时链被自动打散。
- 能力"探测"本身是环境动作（getUserMedia 存在性、IM 容器 ready、串入源挂接），
  由接线层折算成 `ScannerCapabilities` 布尔后进入纯决策。

## 键盘串入解析（纯函数，`wedge-parser.ts`）

- `nextWedgeParserState(state, stroke, options?)`：增量 reducer，时间戳由调用方
  注入；中断（相邻间隔 > `interKeyGapMs`，默认 50ms）与超时（整段 >
  `maxBurstMs`，默认 2s）丢弃整段；前缀区偏离立即拒绝；终结键（默认 `Enter`）
  触发终结校验（前缀/后缀剥离、长度、控制字符），通过才产出 `ScanCode`。
- `parseWedgeSequence(strokes, options?)`：批量折叠，首个 accepted 优先；
  否则首个 rejected（第一处坏输入）；否则 pending。
- 格式假设：通用 wedge 格式（可选前缀 + 码值 + 可选后缀 + 终结键），厂商无关；
  `minLength` 默认 4（人类单键误触不成码），站点可按码制放宽。

## 解码结果形状（`scan-result.ts`）

`ScanResult = { code: ScanCode; tier: ScannerTier; scannedAt: string; deviceId?: DeviceId }`，
构造即冻结。`ScanCode` / `DeviceId` 为品牌化类型（复用 business-core `Brand`；
不直接用 `defineId` 的原因是其 128 字符上限对 QR 载荷过紧，本地取 2048）。
词汇过 ADR-0010 三问：扫码为跨行业通用采集动作，厂商词不进导出词汇。

## 依赖决策（html5-qrcode）

**M1 收尾波-②已真实引入**（html5-qrcode ^2.3.8，Apache-2.0，ADR-0007 白名单内），
仅经 `tier1-camera.ts` 的动态 import 懒加载：首次 `start()` 才加载并 memoize，
组合根主 bundle 不含解码器（Vite/Rollup 按字面量 `import()` 自动分块）。测试经
`loadModule` 注入 mock 模块，不真开摄像头（真实摄像头验收见接线增量记录）。

## 桥接口方向（Tier2 / integration-im）

`ImScanBridge`（isAvailable / scanOnce）在本包定义；具体厂商 SDK（企微
wx.scanCode / 飞书 tt.scanCode）属 integration-im（ADR-0003 #6 边缘包独占外部
SDK）。实现方向：integration-im 或组合根适配器提供 `ImScanBridge` 实现，依赖
箭头 integration-im → integration-scan（dep-cruiser 允许 integration 互依）；
本包零反向依赖，当前不触碰 integration-im。

## 依赖关系

`@smes/business-core`（类型级 `Brand`，运行时零加载）+ `html5-qrcode`（仅
tier1 适配器懒加载消费）。受 `.dep-cruiser.cjs` `integration-tier-edges` 约束：
只能依赖 business-core / application（后者当前未依赖）。
