/**
 * 传输端口（Done-when #3）：注入式 HTTP 客户端形状。
 *
 * 企微/飞书适配器只依赖本端口，不依赖具体 fetch/undici/axios 实现；
 * 厂商 HTTP 细节（URL、令牌交换、载荷形状）封在本包内（ADR-0003 #6）。
 * 单测注入 mock transport；生产由组合根注入真实客户端（可指向网关代理）。
 */
export type ImHttpMethod = 'GET' | 'POST';

export interface ImTransportRequest {
  readonly method: ImHttpMethod;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** GET 无体 → undefined；POST 为 JSON 可序列化值。 */
  readonly body: unknown;
}

export interface ImTransportResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface ImTransport {
  send(request: ImTransportRequest): Promise<ImTransportResponse>;
}
