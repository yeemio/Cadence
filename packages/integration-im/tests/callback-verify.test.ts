import { describe, expect, it } from 'vitest';
import { verifyImCallbackSignature, DEFAULT_CALLBACK_WINDOW_SECONDS } from '../src/index.js';

const NOW = 1_700_000_000; // epoch 秒
/** 伪哈希：使"合法签名"可在纯域内构造——哈希原语是 TODO 钩子，决策逻辑才是被测对象。 */
const FAKE_HASH = (canonical: string) => `H(${canonical})`;
const canonicalOf = (parts: string[]) => [...parts].sort().join('');

describe('回调验签纯函数（Done-when #5）', () => {
  const deps = { now: () => NOW, windowSeconds: DEFAULT_CALLBACK_WINDOW_SECONDS, hash: FAKE_HASH };

  it('合法：token+timestamp+nonce 字典序规范化后哈希命中 → 通过', () => {
    const canonical = canonicalOf(['callback-token-resolved', String(NOW), 'nonce-1']);
    const decision = verifyImCallbackSignature(
      { token: 'callback-token-resolved', timestamp: NOW, nonce: 'nonce-1', signature: FAKE_HASH(canonical), encryptedPayload: undefined },
      deps,
    );
    expect(decision).toEqual({ accepted: true });
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it('时间窗超界拒：|now - timestamp| > windowSeconds（含密文体场景照拒）', () => {
    const stale = NOW - DEFAULT_CALLBACK_WINDOW_SECONDS - 1;
    const future = NOW + DEFAULT_CALLBACK_WINDOW_SECONDS + 1;
    for (const timestamp of [stale, future]) {
      const canonical = canonicalOf(['callback-token-resolved', String(timestamp), 'nonce-1']);
      const decision = verifyImCallbackSignature(
        { token: 'callback-token-resolved', timestamp, nonce: 'nonce-1', signature: FAKE_HASH(canonical), encryptedPayload: undefined },
        deps,
      );
      expect(decision).toEqual({ accepted: false, reason: 'timestamp-out-of-window' });
    }
  });

  it('边界恰好在窗内 → 不以时间窗拒（交由签名比对裁决）', () => {
    const timestamp = NOW - DEFAULT_CALLBACK_WINDOW_SECONDS;
    const canonical = canonicalOf(['callback-token-resolved', String(timestamp), 'nonce-1']);
    const decision = verifyImCallbackSignature(
      { token: 'callback-token-resolved', timestamp, nonce: 'nonce-1', signature: FAKE_HASH(canonical), encryptedPayload: undefined },
      deps,
    );
    expect(decision).toEqual({ accepted: true });
  });

  it('签名不符拒：篡改任一部分（nonce / 密文体）都失配', () => {
    const canonical = canonicalOf(['callback-token-resolved', String(NOW), 'nonce-1']);
    const decision = verifyImCallbackSignature(
      { token: 'callback-token-resolved', timestamp: NOW, nonce: 'nonce-1', signature: FAKE_HASH(canonical), encryptedPayload: undefined },
      { ...deps, hash: (c) => `DIFFERENT(${c})` },
    );
    expect(decision).toEqual({ accepted: false, reason: 'signature-mismatch' });

    // 有密文体时密文参与规范化：不带密文的合法签名会失配
    const withoutCipher = FAKE_HASH(canonicalOf(['callback-token-resolved', String(NOW), 'nonce-1']));
    const decision2 = verifyImCallbackSignature(
      { token: 'callback-token-resolved', timestamp: NOW, nonce: 'nonce-1', signature: withoutCipher, encryptedPayload: 'cipher-body' },
      deps,
    );
    expect(decision2).toEqual({ accepted: false, reason: 'signature-mismatch' });

    // 带密文体构造的签名则通过
    const withCipher = FAKE_HASH(canonicalOf(['callback-token-resolved', String(NOW), 'nonce-1', 'cipher-body']));
    const decision3 = verifyImCallbackSignature(
      { token: 'callback-token-resolved', timestamp: NOW, nonce: 'nonce-1', signature: withCipher, encryptedPayload: 'cipher-body' },
      deps,
    );
    expect(decision3).toEqual({ accepted: true });
  });
});
