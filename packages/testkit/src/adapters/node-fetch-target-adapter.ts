/**
 * NodeFetchTargetAdapter——HTTP 目标适配器（node 内置 fetch，零依赖）。
 *
 * - query 追加到 URL；body 存在时 JSON 序列化并置 content-type: application/json
 *   （headers 显式给 content-type 时不覆盖）
 * - 响应体：content-type 含 application/json → 解析为 JSON（解析失败回落原文）；
 *   否则原文文本。状态码原样返回（非 2xx 也是有效观察，不抛错）。
 * - 超时：AbortSignal.timeout（默认 10s）。
 * - fetchImpl 可注入（单测用 mock）。
 */
import type { TargetAdapter, TargetRequest, TargetResponse } from '../types.js';

export interface NodeFetchTargetOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class NodeFetchTargetAdapter implements TargetAdapter {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: NodeFetchTargetOptions) {
    this.name = options.baseUrl.replace(/\/+$/, '');
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async invoke(request: TargetRequest): Promise<TargetResponse> {
    const url = new URL(request.path, `${this.baseUrl}/`);
    if (request.query !== undefined) {
      for (const [key, value] of Object.entries(request.query)) {
        url.searchParams.set(key, String(value));
      }
    }
    const headers = new Headers(request.headers);
    const hasBody = request.body !== undefined;
    if (hasBody && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    const response = await this.fetchImpl(url, {
      method: request.method,
      headers,
      ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    let body: unknown = text;
    if (contentType.includes('application/json')) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text; // JSON 声明但解析失败：保留原文，比对器按字符串处理
      }
    }
    return { status: response.status, body };
  }
}
