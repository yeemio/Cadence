/**
 * 扫码会话 React 装配 hook（M5 预研自 M1 收尾波-② ScanPage 抽出——扫码报工页
 * 复用同一段装配，不复制实现）：
 *
 * - 能力探测：integration-scan `hasCameraSupport()` + `planScanChain`
 *   （IM 桥能力位恒 false——同 M1 取舍）→ product-ui
 *   `createScanSessionModel`（泛型视图模型，代入边缘包类型）
 * - 扫码器生命周期：随会话状态/档位变化重建（StrictMode 双挂载与降级换档都覆盖）
 * - 同码去抖（连续取景逐帧回调只记一次）与扫码枪串入噪声提示（不进会话错误态）
 *
 * 页面只负责渲染（视频区/档位切换/结果展示由各页面自定），本 hook 暴露
 * model / session 快照 / wedgeHint 三件套。
 */
import { useEffect, useRef, useState } from 'react';
import {
  createCameraScanner,
  createDeviceWedgeScanner,
  hasCameraSupport,
  isDegradableScanError,
  planScanChain,
} from '@smes/integration-scan';
import type {
  ScanError,
  ScanResult,
  ScannerPort,
  ScannerTier,
  WedgeKeystrokeSource,
} from '@smes/integration-scan';
import { createScanSessionModel } from '@smes/product-ui';
import type { ScanSessionModel, ScanSessionState } from '@smes/product-ui';

/** 摄像头扫码器挂载点元素 id（摄像头模式页面须渲染带此 id 的容器）。 */
export const SCAN_VIDEO_ELEMENT_ID = 'cadence-scan-video';

/** 档位 → 展示名（装配层词汇；product-ui/边缘包不持有展示文案）。 */
export const SCAN_TIER_LABELS: Record<ScannerTier, string> = {
  'tier1-camera': '摄像头扫码',
  'tier2-im-sdk': 'IM 原生扫码',
  'tier3-device-wedge': '扫码枪',
};

/** 连续同码去抖窗口：html5-qrcode 连续扫码会对同一码逐帧回调。 */
const DUPLICATE_RESULT_WINDOW_MS = 1_500;

/** window keydown → WedgeKeystrokeSource（DOM 适配，页面焦点监听键盘串入）。 */
function createWindowKeystrokeSource(): WedgeKeystrokeSource {
  return {
    onKeyStroke(handler) {
      const listener = (event: KeyboardEvent): void => {
        // 修饰键自身不构成数据键（解析器也会拒绝，先跳过少噪声）
        if (event.key.length > 1 && event.key !== 'Enter') return;
        handler(event.key, event.timeStamp);
      };
      window.addEventListener('keydown', listener);
      return () => window.removeEventListener('keydown', listener);
    },
  };
}

/** 能力探测 + 降级链规划（进入页面时一次）。 */
function planSession(): ScanSessionModel<ScannerTier, ScanResult, ScanError> | null {
  try {
    const plan = planScanChain({
      camera: hasCameraSupport(),
      imContainer: false, // 非目标：不真调 IM JS-SDK，容器仅识别展示（桥接入后置 true 即进降级链）
      deviceWedge: true, // DOM 键盘串入源总可挂接
    });
    return createScanSessionModel<ScannerTier, ScanResult, ScanError>({
      tiers: plan.tiers,
      isDegradableError: isDegradableScanError,
    });
  } catch {
    return null; // 全档不可用（实际不会发生：wedge 恒可用），页面兜底提示
  }
}

export interface UseScanSession {
  readonly model: ScanSessionModel<ScannerTier, ScanResult, ScanError> | null;
  readonly session: ScanSessionState<ScannerTier, ScanResult, ScanError> | null;
  /** 扫码枪串入噪声提示（timeout/malformed-input 不进会话错误态，仅提示行）。 */
  readonly wedgeHint: string | null;
}

export function useScanSession(): UseScanSession {
  const [model] = useState(planSession);
  const [session, setSession] = useState<ScanSessionState<ScannerTier, ScanResult, ScanError> | null>(
    () => model?.getState() ?? null,
  );
  useEffect(() => {
    if (model === null) return;
    setSession(model.getState());
    return model.subscribe(setSession);
  }, [model]);

  const lastResultRef = useRef<{ code: string; atMs: number } | null>(null);
  const [wedgeHint, setWedgeHint] = useState<string | null>(null);

  // 扫码器生命周期：会话状态/档位变化时重建
  useEffect(() => {
    if (model === null || session === null) return;
    if (session.status !== 'active' || session.currentTier === null) return;
    const tier = session.currentTier;

    let scanner: ScannerPort;
    if (tier === 'tier1-camera') {
      scanner = createCameraScanner({ elementId: SCAN_VIDEO_ELEMENT_ID });
    } else if (tier === 'tier3-device-wedge') {
      scanner = createDeviceWedgeScanner(createWindowKeystrokeSource());
    } else {
      return; // tier2：能力位恒 false 不会到达；桥接入后在此装配
    }

    const offResult = scanner.onResult((result) => {
      const atMs = Date.now();
      const last = lastResultRef.current;
      if (last !== null && last.code === result.code && atMs - last.atMs < DUPLICATE_RESULT_WINDOW_MS) {
        return; // 同码去抖：连续取景逐帧回调只记一次
      }
      lastResultRef.current = { code: result.code, atMs };
      model.pushResult(result);
    });
    const offError = scanner.onError((error) => {
      if (tier === 'tier3-device-wedge' && (error.kind === 'timeout' || error.kind === 'malformed-input')) {
        // 串入噪声（疑似人工输入/坏段）：提示行即可，不进会话错误态
        setWedgeHint('检测到疑似非扫码枪输入，本次输入已忽略');
        return;
      }
      model.pushError(error);
    });
    scanner.start();
    return () => {
      offResult();
      offError();
      scanner.stop();
    };
  }, [model, session?.status, session?.currentTier]);

  // 换档时清提示
  useEffect(() => {
    setWedgeHint(null);
  }, [session?.currentTier]);

  return { model, session, wedgeHint };
}
