/**
 * 回调验签纯函数（Done-when #5）：token + timestamp + nonce（+ 可选密文体）形状的验签决策。
 *
 * 决策逻辑在本实现：时间窗（注入式时钟）→ 字典序规范化拼接 → 哈希比对。
 * 哈希原语经 deps.hash 注入——与 jsdk.ts 同理，无真实凭据不落厂商哈希/编码常量
 * （TODO 钩子：接入真实凭据后提供默认哈希实现 + 厂商测试向量）。
 * 时间单位：epoch 秒（厂商回调时间戳口径）。
 */
import { deepFreeze } from './internal/freeze.js';

export interface ImCallbackVerifyInput {
  /** 已解析的回调 token 值（宿主经 ImSecretResolver 解析后注入；勿硬编码）。 */
  readonly token: string;
  readonly timestamp: number;
  readonly nonce: string;
  /** 厂商回调携带的待验签名。 */
  readonly signature: string;
  /** 企微密文消息体；有则参与规范化（飞书明文模式为 undefined）。 */
  readonly encryptedPayload: string | undefined;
}

export interface ImCallbackVerifyDeps {
  /** epoch 秒；注入以便单测固定时间。 */
  readonly now: () => number;
  readonly windowSeconds: number;
  readonly hash: (canonical: string) => string;
}

export type ImCallbackVerifyDecision =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: 'timestamp-out-of-window' | 'signature-mismatch' };

export const DEFAULT_CALLBACK_WINDOW_SECONDS = 300;

export function verifyImCallbackSignature(
  input: ImCallbackVerifyInput,
  deps: ImCallbackVerifyDeps,
): ImCallbackVerifyDecision {
  const driftSeconds = Math.abs(deps.now() - input.timestamp);
  if (driftSeconds > deps.windowSeconds) {
    return deepFreeze({ accepted: false, reason: 'timestamp-out-of-window' } as const);
  }
  const parts = [input.token, String(input.timestamp), input.nonce];
  if (input.encryptedPayload !== undefined) {
    parts.push(input.encryptedPayload);
  }
  const canonical = parts.sort().join('');
  const expected = deps.hash(canonical);
  return expected === input.signature
    ? deepFreeze({ accepted: true } as const)
    : deepFreeze({ accepted: false, reason: 'signature-mismatch' } as const);
}
