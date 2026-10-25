import type { ImTransport, ImTransportRequest, ImTransportResponse } from '../../src/index.js';

export interface ScriptedImReply {
  readonly status?: number;
  readonly body?: unknown;
  readonly failure?: Error;
}

export interface MockImTransport extends ImTransport {
  readonly requests: readonly ImTransportRequest[];
}

/** 顺序脚本化 mock transport：按序回放，多出的请求直接抛错（暴露编排意外）。 */
export function mockImTransport(script: readonly ScriptedImReply[]): MockImTransport {
  const requests: ImTransportRequest[] = [];
  let cursor = 0;
  return {
    requests,
    async send(request: ImTransportRequest): Promise<ImTransportResponse> {
      requests.push(request);
      const index = cursor;
      cursor += 1;
      const reply = script[index];
      if (reply === undefined) {
        throw new Error(`mock transport: unexpected request #${index + 1} (${request.method} ${request.url})`);
      }
      if (reply.failure !== undefined) {
        throw reply.failure;
      }
      return { status: reply.status ?? 200, body: reply.body };
    },
  };
}
