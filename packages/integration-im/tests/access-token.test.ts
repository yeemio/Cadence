import { describe, expect, it } from 'vitest';
import { TransportTokenProvider, type TokenExchange } from '../src/index.js';
import { mockImTransport } from './helpers/mock-transport.js';

interface FakeConfig {
  readonly secretEcho: string;
}

const EXCHANGE: TokenExchange<FakeConfig> = {
  describeRequest(config, resolvedSecret) {
    return {
      method: 'POST',
      url: 'https://token.test/exchange',
      headers: { 'content-type': 'application/json' },
      body: { config: config.secretEcho, secret: resolvedSecret },
    };
  },
  parseResponse(body) {
    const parsed = body as { token?: string; expires_in?: number };
    if (parsed.token === 'POISON') {
      throw new Error('integration-im: poisoned token response');
    }
    if (typeof parsed.token !== 'string' || typeof parsed.expires_in !== 'number') {
      throw new Error('integration-im: non-conformant token response');
    }
    return { token: parsed.token, expiresInSeconds: parsed.expires_in };
  },
};

describe('TransportTokenProvider（两适配器共享层）', () => {
  it('有效期内复用缓存；进入刷新边际后重新交换', async () => {
    let nowMs = 1_000_000;
    const transport = mockImTransport([
      { status: 200, body: { token: 'TOKEN-A', expires_in: 7200 } },
      { status: 200, body: { token: 'TOKEN-B', expires_in: 7200 } },
    ]);
    const provider = new TransportTokenProvider<FakeConfig>({
      transport,
      clock: () => nowMs,
      config: { secretEcho: 'cfg' },
      exchange: EXCHANGE,
      credentialRef: { kind: 'secret-ref', ref: 'secret://test/cred' },
      resolveSecret: async (ref) => `resolved(${ref.ref})`,
    });

    expect(await provider.accessToken()).toBe('TOKEN-A');
    expect(await provider.accessToken()).toBe('TOKEN-A');
    expect(transport.requests).toHaveLength(1);

    nowMs += 7_200_000 - 60_000 + 1; // 过 expiresAt - margin 边界
    expect(await provider.accessToken()).toBe('TOKEN-B');
    expect(transport.requests).toHaveLength(2);
  });

  it('解析失败抛错且不污染缓存，下一次调用重试', async () => {
    const transport = mockImTransport([
      { status: 200, body: { token: 'POISON', expires_in: 7200 } },
      { status: 200, body: { token: 'TOKEN-OK', expires_in: 7200 } },
    ]);
    const provider = new TransportTokenProvider<FakeConfig>({
      transport,
      clock: () => 0,
      config: { secretEcho: 'cfg' },
      exchange: EXCHANGE,
      credentialRef: { kind: 'secret-ref', ref: 'secret://test/cred' },
      resolveSecret: async () => 'resolved',
    });

    await expect(provider.accessToken()).rejects.toThrow('poisoned token response');
    expect(await provider.accessToken()).toBe('TOKEN-OK');
  });
});
