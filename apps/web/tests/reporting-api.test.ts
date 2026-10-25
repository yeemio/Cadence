/**
 * 报工真实通道接缝测试（M5 正式，node 纯逻辑 + fetch/window stub）：
 * 钉住 reportingApi → apiClient → POST /reports 的确切 HTTP 形状——
 * - 信封映射（key→operationId / ref→dispatchId / quantity→doneQty /
 *   laborMinutes→laborMinutes（M5 首波起来自草稿真实录入，缺省 1 占位已移除）/
 *   note→remark / submittedAt→businessTime）；
 * - Bearer 会话头注入（token 会话存储 → authorization）；
 * - 响应三态归一：committed resolve；rejected / indeterminate 抛错
 *   （离线入队兜底的触发依据）；网络失败（fetch TypeError）原样抛出。
 * 后端真实落库由 tests/e2e-scan-report.test.ts 容器实证（RUN_E2E=1，不在本文件）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOKEN_SESSION_STORAGE_KEY, createBrowserTokenSessionStore } from '@smes/product-ui';
import type { ReportDraftSubmission } from '../src/pages/scan/reportDraft.js';
import { buildReportDraftSubmission } from '../src/pages/scan/reportDraft.js';

// ---- window / localStorage stub（apiClient 模块加载即读 window.localStorage） ----
const storageBacking = new Map<string, string>();
const localStorageStub: Storage = {
  getItem: (key) => storageBacking.get(key) ?? null,
  setItem: (key, value) => void storageBacking.set(key, value),
  removeItem: (key) => void storageBacking.delete(key),
  clear: () => storageBacking.clear(),
  key: () => null,
  get length() {
    return storageBacking.size;
  },
};
vi.stubGlobal('window', {
  localStorage: localStorageStub,
  location: { pathname: '/', assign: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
});

// stub 之后动态 import（模块级 window.localStorage 读取发生在加载时）
const { submitReportDraft, reportSubmitEnvelope } = await import('../src/data/reportingApi.js');

function draft(overrides: Partial<ReportDraftSubmission> = {}): ReportDraftSubmission {
  return buildReportDraftSubmission({
    key: 'rpt-e2e-0001',
    ref: 'dsp-seed-0001',
    quantity: 5,
    laborMinutes: 90,
    note: '白班报工',
    submittedAt: '2026-10-25T04:00:00.000Z',
    ...overrides,
  });
}

/** 记录 fetch 调用并按序回放响应。 */
let calls: Array<{ url: string; init: RequestInit | undefined }> = [];
let responder: (() => Promise<unknown>) | null = null;

function respond(body: unknown, status = 201): void {
  responder = async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

beforeEach(() => {
  calls = [];
  responder = null;
  storageBacking.clear();
  createBrowserTokenSessionStore(localStorageStub, TOKEN_SESSION_STORAGE_KEY).write({
    userId: 'user-e2e' as never,
    tenantId: 'tenant-e2e' as never,
    displayName: 'e2e',
    permissions: [],
    token: 'token-e2e-abc',
    expiresAt: '2026-10-25T16:00:00.000Z',
  });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (responder === null) throw new TypeError('fetch not stubbed');
    return responder();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reportSubmitEnvelope：草稿 → report.submit.v1 信封映射', () => {
  it('全字段映射 + laborMinutes 直传（草稿真实录入，缺省占位已移除）+ expectedRevision initial', () => {
    expect(reportSubmitEnvelope(draft())).toEqual({
      operationId: 'rpt-e2e-0001',
      expectedRevision: 'initial',
      command: {
        kind: 'report.submit.v1',
        payload: {
          dispatchId: 'dsp-seed-0001',
          doneQty: 5,
          laborMinutes: 90,
          businessTime: '2026-10-25T04:00:00.000Z',
          remark: '白班报工',
        },
      },
    });
  });

  it('laborMinutes 覆盖值与 note null 均直传（后端可空字段）', () => {
    const envelope = reportSubmitEnvelope(draft({ note: null, laborMinutes: 44640 }));
    expect(envelope.command.payload.laborMinutes).toBe(44640);
    expect(envelope.command.payload.remark).toBeNull();
  });
});

describe('submitReportDraft：HTTP 形状与三态归一', () => {
  it('committed → resolve；请求带 Bearer 与确切信封体', async () => {
    respond({ status: 'committed', newRevision: 2, report: { id: 'wrk-1' } });
    await expect(submitReportDraft(draft())).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/reports');
    expect(calls[0]?.init?.method).toBe('POST');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer token-e2e-abc');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(reportSubmitEnvelope(draft()));
  });

  it('rejected（HTTP 201 业务拒绝）→ 抛错并带回 reason（入队兜底依据）', async () => {
    respond({ status: 'rejected', reason: "派工单 'dsp-seed-0001' 不存在或派工读端口未接线（reporting submit 前置校验 fail-closed）" });
    await expect(submitReportDraft(draft())).rejects.toThrow(/报工被拒绝.*fail-closed/);
  });

  it('未知 status（indeterminate 形状）→ 抛错', async () => {
    respond({ status: 'indeterminate' });
    await expect(submitReportDraft(draft())).rejects.toThrow(/结果不确定/);
  });

  it('响应缺 status → 形状非法抛错', async () => {
    respond({ something: 'else' });
    await expect(submitReportDraft(draft())).rejects.toThrow(/形状非法/);
  });

  it('网络失败（fetch TypeError，离线判定路径）→ 原样抛错', async () => {
    responder = null;
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(submitReportDraft(draft())).rejects.toThrow(TypeError);
  });
});
