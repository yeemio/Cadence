/**
 * 厂商访问令牌提供器（两适配器共享层）：凭据 → 令牌交换 + 过期缓存。
 *
 * 厂商端点/响应形状差异由 TokenExchange 描述子注入（各适配器定义）；
 * 缓存、刷新边际（TOKEN_REFRESH_MARGIN_MS）、注入式时钟在此统一，纯域可测。
 * 并发首次调用可能重复交换（幂等，可接受）；宿主需要互斥可在外层包裹。
 */
import type { ImSecretRef, ImSecretResolver } from './config.js';
import type { ImTransport, ImTransportRequest } from './transport.js';

export interface VendorTokenExchangeResult {
  readonly token: string;
  readonly expiresInSeconds: number;
}

export interface TokenExchange<C> {
  /** 用渠道配置 + 已解析凭据构造交换请求（厂商 HTTP 细节封在适配器的描述子里）。 */
  describeRequest(config: C, resolvedSecret: string): ImTransportRequest;
  /** 响应不合法即抛错（含厂商错误码），合法返回令牌与有效期。 */
  parseResponse(body: unknown): VendorTokenExchangeResult;
}

export const TOKEN_REFRESH_MARGIN_MS = 60_000;

export interface TransportTokenProviderDeps<C> {
  readonly transport: ImTransport;
  /** epoch 毫秒；注入以便单测推进时间。 */
  readonly clock: () => number;
  readonly config: C;
  readonly exchange: TokenExchange<C>;
  readonly credentialRef: ImSecretRef;
  readonly resolveSecret: ImSecretResolver;
}

export class TransportTokenProvider<C> {
  private cached: { token: string; expiresAtMs: number } | undefined;

  constructor(private readonly deps: TransportTokenProviderDeps<C>) {}

  async accessToken(): Promise<string> {
    const nowMs = this.deps.clock();
    if (this.cached !== undefined && nowMs < this.cached.expiresAtMs - TOKEN_REFRESH_MARGIN_MS) {
      return this.cached.token;
    }
    const secret = await this.deps.resolveSecret(this.deps.credentialRef);
    const response = await this.deps.transport.send(this.deps.exchange.describeRequest(this.deps.config, secret));
    const parsed = this.deps.exchange.parseResponse(response.body);
    this.cached = { token: parsed.token, expiresAtMs: this.deps.clock() + parsed.expiresInSeconds * 1000 };
    return parsed.token;
  }
}
