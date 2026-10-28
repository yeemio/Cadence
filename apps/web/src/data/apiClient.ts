/**
 * 共享薄请求层（M1 增量 4-I；收尾波-③ 真实认证改造）：fetch 直连 server +
 * Bearer token 注入。
 *
 * orgApi.ts 自带同形状的 request（M1 增量 3-D 先例）；本文件是 4-I 新增数据层
 * （masterdata/workbench）的共享入口。身份头（收尾波-③ 起）：Authorization:
 * Bearer <token>（x-smes-user dev 头只在服务端 SMES_DEV_AUTH=on 的测试形态存在，
 * 浏览器端不再发送）。
 *
 * 会话规则（ADR-0009 参照，收尾波-③ 落地）：
 *  - 401 才清会话：其他失败（含网络错误抛 TypeError）一律不动本地会话；
 *  - refresh 竞态防误清：请求携带的 token 已被保活模块换新时（401 但存储里
 *    已是另一个 token），用新 token 原样重试一次而不是清会话；
 *  - 进行中请求计数：空闲计时仅在"页面可见 + 无进行中请求"时累计（见
 *    session-keepalive.ts，本文件只暴露计数快照）。
 */
import { createBrowserTokenSessionStore } from '@smes/product-ui';

const API_BASE = (import.meta.env['VITE_API_BASE_URL'] as string | undefined) ?? '';

const sessionStore = createBrowserTokenSessionStore(window.localStorage);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    // i18n 波 2（ADR-0012 决定 3）：服务端错误响应语义 code（{ statusCode, code, message }）
    // 原样透出；非 ApiError 形状/缺 code 字段时为 undefined，消费方按未知 code 回落。
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 进行中请求数（空闲计时用；fetch 抛错也对称递减）。 */
let inFlight = 0;

export function authInFlightCount(): number {
  return inFlight;
}

function clearSessionAndRedirect(): void {
  sessionStore.clear();
  if (window.location.pathname !== '/login') {
    window.location.assign('/login'); // MPA 整页跳转（与登录入口同语义）
  }
}

/** 带 Bearer 会话头的 JSON 请求；非 2xx 抛 ApiError（含服务端 message）。 */
export async function request(path: string, init?: RequestInit): Promise<unknown> {
  return requestOnce(path, init, 0);
}

async function requestOnce(
  path: string,
  init: RequestInit | undefined,
  retry: number,
): Promise<unknown> {
  const usedToken = sessionStore.read()?.token;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (usedToken !== undefined) {
    headers['authorization'] = `Bearer ${usedToken}`;
  }

  inFlight += 1;
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
    });
  } finally {
    inFlight -= 1; // 网络失败（fetch 抛 TypeError）同样递减，且不动会话
  }

  if (response.status === 401) {
    const currentToken = sessionStore.read()?.token;
    if (retry === 0 && currentToken !== undefined && currentToken !== usedToken) {
      // 保活换新竞态：本请求带的是旧 token，存储里已有新 token——重试一次
      return requestOnce(path, init, retry + 1);
    }
    clearSessionAndRedirect(); // 401 才清会话（继续抛 ApiError 给调用方）
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
    const message =
      record !== null && typeof record['message'] === 'string'
        ? record['message']
        : `HTTP ${response.status}`;
    // 语义 code 随 message 同源透出（i18n 波 2：前端按 code 映射文案，未知回落原文）
    const code =
      record !== null && typeof record['code'] === 'string' && record['code'].length > 0
        ? record['code']
        : undefined;
    throw new ApiError(response.status, message, code);
  }
  return body;
}
