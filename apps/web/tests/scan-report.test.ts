/**
 * 报工接缝测试（M5 预研建、首波正式适配）：钉住对接点两侧的形状——
 * - reportDraft：提交载荷构造/守卫（在线直发与离线入队同一形状；M5 首波
 *   补 laborMinutes 真实录入字段——预研缺省 1 分钟占位随 reportingApi 移除）；
 * - OfflineQueue 以页面同款存储键与守卫装配，提交通道（reportingApi →
 *   POST /reports）驱动 FIFO 重放出队。
 * 通道侧 fetch 恒 committed（网络失败路径在 reporting-api.test.ts）；真实
 * HTTP 落库由 tests/e2e-scan-report.test.ts 容器实证（RUN_E2E=1）。
 */
import { beforeEach, vi } from 'vitest';
import { describe, expect, it } from 'vitest';
import { createOfflineQueue, hydrateOfflineQueue, offlineQueueStorageKey } from '@smes/product-ui';
import { buildReportDraftSubmission, isReportDraftSubmission } from '../src/pages/scan/reportDraft.js';
import type { ReportDraftSubmission } from '../src/pages/scan/reportDraft.js';

// ---- window stub（apiClient 模块加载即读 window.localStorage） ----
const storageBacking = new Map<string, string>();
vi.stubGlobal('window', {
  localStorage: {
    getItem: (key: string) => storageBacking.get(key) ?? null,
    setItem: (key: string, value: string) => void storageBacking.set(key, value),
    removeItem: (key: string) => void storageBacking.delete(key),
  },
  location: { pathname: '/', assign: () => {} },
});

const { submitReportDraft } = await import('../src/data/reportingApi.js');

beforeEach(() => {
  // 通道侧 fetch 恒 committed（重放出队依据）
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    status: 201,
    json: async () => ({ status: 'committed', newRevision: 2, report: { id: 'wrk-stub' } }),
  }));
});

const QUEUE_NAME = 'report-draft'; // 与移动报工页同款（页面内常量，此处镜像并断言键名约定）

function submission(ref: string, quantity: number): ReportDraftSubmission {
  return buildReportDraftSubmission({
    key: `rpt-${ref}-${quantity}`,
    ref,
    quantity,
    laborMinutes: 60,
    note: null,
    submittedAt: '2026-10-25T04:00:00.000Z',
  });
}

describe('reportDraft：提交载荷形状（对接点载荷）', () => {
  it('构造：ref trim / 空 note 归一 null / 全字段保留（含 laborMinutes）', () => {
    const draft = buildReportDraftSubmission({
      key: 'rpt-1',
      ref: ' WO-2026-0042 ',
      quantity: 3,
      laborMinutes: 75,
      note: '  ',
      submittedAt: '2026-10-25T04:00:00.000Z',
    });
    expect(draft).toEqual({
      key: 'rpt-1',
      ref: 'WO-2026-0042',
      quantity: 3,
      laborMinutes: 75,
      note: null,
      submittedAt: '2026-10-25T04:00:00.000Z',
    });
    expect(isReportDraftSubmission(draft)).toBe(true);
  });

  it('非法输入抛错；守卫拒绝坏形状（hydrate 丢弃依据）', () => {
    expect(() => submission(' ', 1)).toThrow();
    expect(() => submission('WO-1', 0)).toThrow();
    expect(() => submission('WO-1', Number.NaN)).toThrow();
    // M5 首波：laborMinutes 校验对齐后端 requireLaborMinutes（正整数分钟、上限 44640）
    expect(() =>
      buildReportDraftSubmission({
        key: 'rpt-2',
        ref: 'WO-1',
        quantity: 1,
        laborMinutes: 0,
        note: null,
        submittedAt: '2026-10-25T04:00:00.000Z',
      }),
    ).toThrow(/laborMinutes/);
    expect(() =>
      buildReportDraftSubmission({
        key: 'rpt-3',
        ref: 'WO-1',
        quantity: 1,
        laborMinutes: 1.5,
        note: null,
        submittedAt: '2026-10-25T04:00:00.000Z',
      }),
    ).toThrow(/整数分钟/);
    expect(
      isReportDraftSubmission({
        key: 'k',
        ref: 'WO-1',
        quantity: -1,
        laborMinutes: 60,
        note: null,
        submittedAt: '2026-10-25T04:00:00.000Z',
      }),
    ).toBe(false);
    // 预研期旧队列条目（无 laborMinutes 字段）——hydrate 守卫丢弃依据
    expect(
      isReportDraftSubmission({
        key: 'k',
        ref: 'WO-1',
        quantity: 1,
        note: null,
        submittedAt: '2026-10-25T04:00:00.000Z',
      }),
    ).toBe(false);
    expect(isReportDraftSubmission(null)).toBe(false);
  });
});

describe('报工离线接缝（页面同款装配 + 真实通道形状出口）', () => {
  it('存储键约定与页面一致', () => {
    expect(offlineQueueStorageKey(QUEUE_NAME)).toBe('cadence.offline-queue.v1.report-draft');
  });

  it('离线入队 → 序列化往返（守卫生效）→ 提交通道 FIFO 重放出队', async () => {
    const queue = createOfflineQueue<ReportDraftSubmission>({
      name: QUEUE_NAME,
      isPayload: isReportDraftSubmission,
    });
    queue.enqueue('rpt-a', submission('WO-A', 1));
    queue.enqueue('rpt-b', submission('WO-B', 2));

    // 往返：守卫过滤坏条目（同存储槽被其他形状污染时的韧性）
    const raw = `{"v":1,"name":"${QUEUE_NAME}","items":[${
      JSON.stringify({ key: 'rpt-a', payload: submission('WO-A', 1), attempts: 1, seq: 1 })
    },{"key":"rpt-x","payload":"not-a-draft","attempts":0,"seq":2},${
      JSON.stringify({ key: 'rpt-b', payload: submission('WO-B', 2), attempts: 0, seq: 3 })
    }]}`;
    const restored = hydrateOfflineQueue<ReportDraftSubmission>(raw, {
      name: QUEUE_NAME,
      isPayload: isReportDraftSubmission,
    });
    expect(restored?.pending().map((entry) => entry.key)).toEqual(['rpt-a', 'rpt-b']);
    expect(restored?.pending()[0]?.attempts).toBe(1); // 计数随往返保留

    // 重放走提交通道（reportingApi → POST /reports，fetch stub committed）；全部成功即清空
    const summary = await restored!.replay((entry) => submitReportDraft(entry.payload));
    expect(summary).toMatchObject({ attempted: 2, done: 2, failed: 0, remaining: 0 });
    expect(restored!.size()).toBe(0);
  });
});
