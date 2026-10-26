/**
 * DrawingService 行为测试（M3，m3-drafts/03-drawing.md v1.0 Done-when 与 §7 对账要点）。
 *
 * 覆盖面（差异表逐行 + 合同冻结语义）：
 *  - #1 drawing.publish.v1 领域命令（发布=通知上游动作；通知 from→to 联动）；
 *  - #2 品牌化 ID（ports.test.ts 承担类型级；此处验证行 id 前缀）；
 *  - #3 钉版引用读回不漂移（v4 发布后 v3 引用读回仍 v3——§7 对账锚）；
 *  - #4 查看权限+保密等级+DrawingViewed 留痕（两不变量：必过权限、必留痕；
 *    两级 公开/受限——R-M3-6 推荐默认；超等级与不存在同形 404 不泄漏存在性）；
 *  - #6 fileRef 保密语义=不变量不锁实现（水印/签名 URL 实施层——此处验证
 *    fileRef 唯一取得路径=留痕后的 viewRevision）；
 *  - G1 先解析校验后记账（被拒命令不占用 operationId）；
 *  - §3 查询全集：修订链/通知游标/按工作令图纸清单/查看留痕审计；
 *  - §7 对账：同一发布序列的修订链与通知 from→to 集合等价；留痕无漏记。
 */
import { describe, expect, it } from 'vitest';
import { OperationId, TenantId, UserId, makeCommandEnvelope } from '@smes/business-core';
import {
  DRAWING_EVENT_TYPES,
  DrawingId,
  DrawingInputError,
  DrawingNotFoundError,
  DrawingService,
  InMemoryDrawingRevisionStore,
  inMemoryDrawingStores,
  isDrawingConflict,
  type DrawingCommandEnvelope,
  type DrawingRevisionRow,
  type DrawingViewer,
} from '../src/index.js';

// ---- 测试装配 ----

const TENANT = TenantId.create('t-drawing-test');
const TECH = UserId.create('u-tech-1'); // 工艺/技术：发布 + restricted 许可
const LINE = UserId.create('u-line-1'); // 一线班组：public 许可

/** 取拒绝原因消息（同类同消息模板断言用）。 */
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '(unexpectedly resolved)';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const techViewer: DrawingViewer = { userId: TECH, clearance: 'restricted' };
const lineViewer: DrawingViewer = { userId: LINE, clearance: 'public' };

interface Harness {
  readonly service: DrawingService;
  readonly revisions: InMemoryDrawingRevisionStore;
  readonly allViews: () => Promise<readonly { id: string; drawingId: string; version: number; viewedBy: string; classification: string }[]>;
  readonly allNotices: () => Promise<{ notices: readonly { fromVersion: number; toVersion: number }[] }>;
}

function makeHarness(): Harness {
  const stores = inMemoryDrawingStores();
  const service = new DrawingService(stores, { now: () => '2026-11-01T08:00:00.000Z' });
  return {
    service,
    revisions: stores.revisions as InMemoryDrawingRevisionStore,
    allViews: async () =>
      (await stores.views.list(TENANT)).map((row) => ({
        id: row.id,
        drawingId: row.drawingId,
        version: row.version,
        viewedBy: row.viewedBy,
        classification: row.classification,
      })),
    allNotices: async () => ({
      notices: (await stores.notices.readByDrawing(TENANT, DrawingId.create('dwg-001'))).map((n) => ({
        fromVersion: n.fromVersion,
        toVersion: n.toVersion,
      })),
    }),
  };
}

let opCounter = 0;
function envelope(
  payload: unknown,
  expectedRevision: number | 'initial' = 'initial',
  operationId?: string,
): DrawingCommandEnvelope {
  opCounter += 1;
  return makeCommandEnvelope({
    tenantId: TENANT,
    issuedBy: TECH,
    operationId: OperationId.create(operationId ?? `op-drawing-${String(opCounter).padStart(4, '0')}`),
    expectedRevision,
    issuedAt: '2026-11-01T08:00:00.000Z',
    command: { kind: 'drawing.publish.v1', payload },
  });
}

async function publish(
  h: Harness,
  payload: Record<string, unknown>,
  expectedRevision: number | 'initial' = 'initial',
  operationId?: string,
) {
  return h.service.execute(TENANT, envelope(payload, expectedRevision, operationId));
}

/** 常规四连发：dwg-001 v1(public)→v2(public)→v3(restricted)→v4(restricted)。 */
async function publishChain(h: Harness, drawingId = 'dwg-001'): Promise<void> {
  const steps: readonly { readonly changeNote: string; readonly classification?: string }[] = [
    { changeNote: '首发' },
    { changeNote: '增加 M8 孔位' },
    { changeNote: '孔位公差收紧', classification: 'restricted' },
    { changeNote: '材料改 6061', classification: 'restricted' },
  ];
  let expected: number | 'initial' = 'initial';
  for (const step of steps) {
    const result = await publish(h, { drawingId, fileRef: `storage://drawings/${drawingId}/v${expected === 'initial' ? 1 : expected + 1}.pdf`, ...step }, expected);
    expect(result.status).toBe('committed');
    expected = expected === 'initial' ? 1 : expected + 1;
  }
}

// ---- drawing.publish.v1（差异表 #1：领域命令 + 通知联动） ----

describe('drawing.publish.v1（append-only 修订链 + 自动变更通知）', () => {
  it('首发 v1 committed：事件+通知（from 0→to 1）；修订链可追溯（谁/何时/改了什么）', async () => {
    const h = makeHarness();
    const result = await publish(h, { drawingId: 'dwg-001', fileRef: 'storage://drawings/dwg-001/v1.pdf', changeNote: '首发' });
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    expect(result.revision?.version).toBe(1);
    expect(result.revision?.status).toBe('current');
    expect(result.revision?.id.startsWith('dr-')).toBe(true);
    expect(result.revision?.classification).toBe('public'); // 缺省等级=公开
    expect(result.revision?.changedBy).toBe(TECH);
    expect(result.notice?.fromVersion).toBe(0);
    expect(result.notice?.toVersion).toBe(1);
    expect(result.events.map((event) => event.eventType)).toEqual([DRAWING_EVENT_TYPES.drawingRevisionPublished]);
    // 修订链全程可追溯（§7 Done-when：谁、何时、改了什么）
    const chain = await h.service.revisionChain(TENANT, techViewer, DrawingId.create('dwg-001'));
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ version: 1, changeNote: '首发', changedBy: TECH, changedAt: '2026-11-01T08:00:00.000Z' });
  });

  it('修订链 append-only + supersedes 链 + 通知 from→to 集合与链等价（§7 对账锚）', async () => {
    const h = makeHarness();
    await publishChain(h);
    const chain: readonly DrawingRevisionRow[] = await h.revisions.chain(TENANT, DrawingId.create('dwg-001'));
    expect(chain.map((row) => row.version)).toEqual([1, 2, 3, 4]);
    expect(chain.map((row) => row.supersedes)).toEqual([null, chain[0]!.id, chain[1]!.id, chain[2]!.id]);
    expect(chain.map((row) => row.supersedesVersion)).toEqual([undefined, 1, 2, 3]);
    // 同一发布序列：通知 from→to 集合 = 修订链步进（0→1,1→2,2→3,3→4）
    const { notices } = await h.allNotices();
    expect(notices).toEqual([
      { fromVersion: 0, toVersion: 1 },
      { fromVersion: 1, toVersion: 2 },
      { fromVersion: 2, toVersion: 3 },
      { fromVersion: 3, toVersion: 4 },
    ]);
  });

  it('钉版引用不漂移（#3/§7）：v4 发布后 v3 引用读回仍 v3', async () => {
    const h = makeHarness();
    await publishChain(h);
    // 钉版引用 = { drawingId, version: 3 }（消费方结构同形载荷）
    const pinned = await h.service.viewRevision(TENANT, techViewer, DrawingId.create('dwg-001'), 3);
    expect(pinned.version).toBe(3);
    expect(pinned.fileRef).toBe('storage://drawings/dwg-001/v3.pdf');
    expect(pinned.changeNote).toBe('孔位公差收紧');
    expect(pinned.status).toBe('superseded'); // v4 已发布，v3 是历史修订——引用不漂移
    const latest = await h.service.viewRevision(TENANT, techViewer, DrawingId.create('dwg-001'), 'latest');
    expect(latest.version).toBe(4);
    expect(latest.status).toBe('current');
  });

  it('乐观锁与 G1：错配 rejected 不占用 operationId；同 id 修正重发 committed；已落账重发 rejected', async () => {
    const h = makeHarness();
    await publish(h, { drawingId: 'dwg-001', fileRef: 'f://1', changeNote: '首发' });
    // 已存在却走 initial → rejected（不占用 op-fix）
    const rejected = await publish(h, { drawingId: 'dwg-001', fileRef: 'f://2', changeNote: '二版' }, 'initial', 'op-fix');
    expect(rejected.status).toBe('rejected');
    // 同 operationId 修正 expectedRevision 重发 → committed（被拒不占用 id）
    const retried = await publish(h, { drawingId: 'dwg-001', fileRef: 'f://2', changeNote: '二版' }, 1, 'op-fix');
    expect(retried.status).toBe('committed');
    // 已 committed 的同 id 再发 → 幂等拒绝（不变量 3）
    const replay = await publish(h, { drawingId: 'dwg-001', fileRef: 'f://3', changeNote: '三版' }, 2, 'op-fix');
    expect(replay.status).toBe('rejected');
    if (replay.status === 'rejected') expect(replay.reason).toContain('幂等冲突');
    // 版本错配
    const mismatch = await publish(h, { drawingId: 'dwg-001', fileRef: 'f://3', changeNote: '三版' }, 9);
    expect(mismatch.status).toBe('rejected');
    if (mismatch.status === 'rejected') expect(mismatch.reason).toContain('乐观锁冲突');
    // 不存在的图纸声明数字乐观锁 → rejected
    const nothing = await publish(h, { drawingId: 'dwg-none', fileRef: 'f://1', changeNote: 'x' }, 3);
    expect(nothing.status).toBe('rejected');
  });

  it('载荷门禁：changeNote 必填、classification 未知词拒绝、fileRef 越界拒绝（不静默）', async () => {
    const h = makeHarness();
    await expect(publish(h, { drawingId: 'dwg-001', fileRef: 'f://1' })).rejects.toBeInstanceOf(DrawingInputError);
    await expect(publish(h, { drawingId: 'dwg-001', fileRef: 'f://1', changeNote: '  ' })).rejects.toBeInstanceOf(DrawingInputError);
    await expect(
      publish(h, { drawingId: 'dwg-001', fileRef: 'f://1', changeNote: 'ok', classification: 'secret' }),
    ).rejects.toThrowError(/公开\/受限|public\/restricted/);
    await expect(
      publish(h, { drawingId: 'dwg-001', fileRef: 'x'.repeat(1025), changeNote: 'ok' }),
    ).rejects.toBeInstanceOf(DrawingInputError);
  });

  it('并发竞态防线：(tenant, drawingId, version) 冲突 → DrawingConflictError（镜像 name 识别）', async () => {
    const h = makeHarness();
    await publish(h, { drawingId: 'dwg-001', fileRef: 'f://1', changeNote: '首发' });
    const mirror = new (class extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'DrawingConflictError';
      }
    })('镜像冲突');
    expect(isDrawingConflict(mirror)).toBe(true); // business-store 同形镜像类可识别
    // 直接对存储层塞同版本 → 真类冲突
    await expect(
      h.revisions.insert({
        tenant: TENANT,
        drawingId: DrawingId.create('dwg-001'),
        version: 1,
        fileRef: 'f://race',
        changeNote: '并发',
        classification: 'public',
        changedBy: TECH,
        changedAt: '2026-11-01T08:00:00.000Z',
        supersedes: null,
        objectVersion: 1,
        auditStatus: 'published',
      }),
    ).rejects.toThrowError(/已存在/);
  });
});

// ---- 查看留痕与保密门禁（差异表 #4；R-M3-6 两级公开/受限） ----

describe('查看留痕与保密门禁（两不变量：必过权限、必留痕）', () => {
  it('每次查看留痕：留痕行（谁/何时/哪修订/当时等级）+ DrawingViewed 事件；无漏记', async () => {
    const h = makeHarness();
    await publishChain(h);
    await h.service.viewRevision(TENANT, lineViewer, DrawingId.create('dwg-001'), 1);
    await h.service.viewRevision(TENANT, lineViewer, DrawingId.create('dwg-001'), 2);
    await h.service.viewRevision(TENANT, techViewer, DrawingId.create('dwg-001'), 3);
    const views = await h.allViews();
    expect(views).toHaveLength(3); // 查看次数=留痕行数（无漏记）
    expect(views.map((v) => `${v.viewedBy}@v${v.version}:${v.classification}`)).toEqual([
      'u-line-1@v1:public',
      'u-line-1@v2:public',
      'u-tech-1@v3:restricted', // 留痕行含查看时点等级快照
    ]);
    expect(views.every((v) => v.id.startsWith('dvt-'))).toBe(true);
    const events = await h.service.listEvents(TENANT);
    const viewedEvents = events.filter((event) => event.eventType === DRAWING_EVENT_TYPES.drawingViewed);
    expect(viewedEvents).toHaveLength(3);
    const payload = viewedEvents[2]!.payload as { drawingId: string; version: number; viewedBy: string; classification: string };
    expect(payload).toMatchObject({ drawingId: 'dwg-001', version: 3, viewedBy: 'u-tech-1', classification: 'restricted' });
  });

  it('fileRef 唯一取得路径=留痕后的 viewRevision（差异表 #6 不变量化）', async () => {
    const h = makeHarness();
    await publish(h, { drawingId: 'dwg-001', fileRef: 'storage://drawings/dwg-001/v1.pdf', changeNote: '首发' });
    // 修订链清单不含 fileRef（元数据索引；内容走留痕路径）
    const chain = await h.service.revisionChain(TENANT, lineViewer, DrawingId.create('dwg-001'));
    expect(chain).toHaveLength(1);
    expect('fileRef' in chain[0]!).toBe(false);
    // 查看路径返回内容指针且已留痕
    const viewed = await h.service.viewRevision(TENANT, lineViewer, DrawingId.create('dwg-001'), 'latest');
    expect(viewed.fileRef).toBe('storage://drawings/dwg-001/v1.pdf');
    expect(await h.allViews()).toHaveLength(1);
  });

  it('超保密等级不可见与不存在同形 404（不泄漏存在性）；restricted 许可可见', async () => {
    const h = makeHarness();
    await publish(h, { drawingId: 'dwg-001', fileRef: 'f://1', changeNote: '首发' });
    await publish(h, { drawingId: 'dwg-001', fileRef: 'f://2', changeNote: '升级受限版', classification: 'restricted' }, 1);
    await publish(h, { drawingId: 'dwg-002', fileRef: 'f://x', changeNote: '首发（止于公开 v1）' });
    // 同一请求形状 v2：dwg-001=存在但受限（不可见）；dwg-002=不存在——两例同类
    // 同消息模板，仅回显调用方已知入参（图纸号），不泄漏存在性
    const invisible = h.service.viewRevision(TENANT, lineViewer, DrawingId.create('dwg-001'), 2);
    const nonexistent = h.service.viewRevision(TENANT, lineViewer, DrawingId.create('dwg-002'), 2);
    await expect(invisible).rejects.toBeInstanceOf(DrawingNotFoundError);
    await expect(nonexistent).rejects.toBeInstanceOf(DrawingNotFoundError);
    const [invisibleError, nonexistentError] = await Promise.all([
      rejectionMessage(invisible),
      rejectionMessage(nonexistent),
    ]);
    expect(invisibleError.replace('dwg-001', 'X')).toBe(nonexistentError.replace('dwg-002', 'X')); // 同形
    // 'latest' 落在受限修订上 → public 许可同样不可见
    await expect(
      h.service.viewRevision(TENANT, lineViewer, DrawingId.create('dwg-001'), 'latest'),
    ).rejects.toBeInstanceOf(DrawingNotFoundError);
    // restricted 许可可见且留痕
    const ok = await h.service.viewRevision(TENANT, techViewer, DrawingId.create('dwg-001'), 2);
    expect(ok.classification).toBe('restricted');
    // 不可见查看不留痕（门禁先于留痕——失败查看不产生审计噪声）
    expect(await h.allViews()).toHaveLength(1);
  });

  it('修订链按许可过滤：public 许可不列受限修订', async () => {
    const h = makeHarness();
    await publishChain(h);
    const forLine = await h.service.revisionChain(TENANT, lineViewer, DrawingId.create('dwg-001'));
    expect(forLine.map((row) => row.version)).toEqual([1, 2]); // v3/v4 受限不可见
    const forTech = await h.service.revisionChain(TENANT, techViewer, DrawingId.create('dwg-001'));
    expect(forTech.map((row) => row.version)).toEqual([1, 2, 3, 4]);
    expect(forTech.map((row) => `${row.version}:${row.status}`)).toEqual(['1:superseded', '2:superseded', '3:superseded', '4:current']);
  });

  it('未知许可等级 fail-fast（DrawingInputError，不默认放行）', async () => {
    const h = makeHarness();
    await publish(h, { drawingId: 'dwg-001', fileRef: 'f://1', changeNote: '首发' });
    await expect(
      h.service.viewRevision(TENANT, { userId: LINE, clearance: 'top-secret' }, DrawingId.create('dwg-001'), 1),
    ).rejects.toBeInstanceOf(DrawingInputError);
    await expect(
      h.service.revisionChain(TENANT, { userId: LINE, clearance: 'top-secret' }, DrawingId.create('dwg-001')),
    ).rejects.toBeInstanceOf(DrawingInputError);
  });

  it('查看留痕审计（drawing:audit-read）：全量/按图纸/按人过滤', async () => {
    const h = makeHarness();
    await publish(h, { drawingId: 'dwg-001', fileRef: 'f://1', changeNote: '首发' });
    await publish(h, { drawingId: 'dwg-002', fileRef: 'f://2', changeNote: '首发' });
    await h.service.viewRevision(TENANT, lineViewer, DrawingId.create('dwg-001'), 1);
    await h.service.viewRevision(TENANT, lineViewer, DrawingId.create('dwg-002'), 1);
    await h.service.viewRevision(TENANT, techViewer, DrawingId.create('dwg-002'), 1);
    expect((await h.service.viewAudit(TENANT)).length).toBe(3);
    const byDrawing = await h.service.viewAudit(TENANT, { drawingId: DrawingId.create('dwg-002') });
    expect(byDrawing.map((row) => row.viewedBy).sort()).toEqual(['u-line-1', 'u-tech-1']);
    const byViewer = await h.service.viewAudit(TENANT, { viewedBy: LINE });
    expect(byViewer.map((row) => row.drawingId)).toEqual(['dwg-001', 'dwg-002']);
  });
});

// ---- 查询面：通知游标 + 按工作令图纸清单（§3 全集） ----

describe('变更通知读取与按工作令图纸清单', () => {
  it('notices sinceVersion 游标（消费方轮询："我引用的 v3 是否已有更新"）', async () => {
    const h = makeHarness();
    await publishChain(h);
    const drawingId = DrawingId.create('dwg-001');
    const all = await h.service.notices(TENANT, drawingId);
    expect(all.map((n) => n.toVersion)).toEqual([1, 2, 3, 4]); // toVersion 升序
    const since3 = await h.service.notices(TENANT, drawingId, 3);
    expect(since3.map((n) => `${n.fromVersion}->${n.toVersion}`)).toEqual(['3->4']);
    expect(await h.service.notices(TENANT, drawingId, 4)).toEqual([]);
  });

  it('drawingsForWorkOrder：ok+升级视图 / restricted / missing；升级只数许可内新版', async () => {
    const h = makeHarness();
    // dwg-001: v1 public, v2 restricted, v3 restricted
    await publish(h, { drawingId: 'dwg-001', fileRef: 'f://1', changeNote: '首发' });
    await publish(h, { drawingId: 'dwg-001', fileRef: 'f://2', changeNote: '受限改版', classification: 'restricted' }, 1);
    await publish(h, { drawingId: 'dwg-001', fileRef: 'f://3', changeNote: '继续收紧', classification: 'restricted' }, 2);
    const refs = [
      { drawingId: 'dwg-001', version: 1 }, // public 引用：ok；许可内最新=1（v2/v3 受限不数）
      { drawingId: 'dwg-001', version: 2 }, // restricted 引用：对 public 许可 restricted
      { drawingId: 'dwg-404', version: 1 }, // 不存在：missing
    ];
    const forLine = await h.service.drawingsForWorkOrder(TENANT, lineViewer, refs);
    expect(forLine.map((v) => v.status)).toEqual(['ok', 'restricted', 'missing']);
    const okView = forLine[0]!;
    if (okView.status === 'ok') {
      expect(okView.latestVersion).toBe(1);
      expect(okView.hasUpdate).toBe(false); // 存在新版本身按许可过滤，不越级泄漏
    }
    const forTech = await h.service.drawingsForWorkOrder(TENANT, techViewer, refs);
    expect(forTech.map((v) => v.status)).toEqual(['ok', 'ok', 'missing']);
    const techPinned = forTech[0]!;
    if (techPinned.status === 'ok') {
      expect(techPinned.latestVersion).toBe(3);
      expect(techPinned.hasUpdate).toBe(true); // 钉版不漂移，升级是显式动作
      expect(techPinned.changeNote).toBe('首发');
    }
    const techV2 = forTech[1]!;
    if (techV2.status === 'ok') expect(techV2.classification).toBe('restricted');
  });

  it('按工作令清单不产生留痕（清单=元数据；留痕只在查看路径）', async () => {
    const h = makeHarness();
    await publish(h, { drawingId: 'dwg-001', fileRef: 'f://1', changeNote: '首发' });
    await h.service.drawingsForWorkOrder(TENANT, lineViewer, [{ drawingId: 'dwg-001', version: 1 }]);
    expect(await h.allViews()).toHaveLength(0);
  });
});

// ---- 图号索引（P1-c / O3 裁定=最小索引端点） ----

describe('drawingsIndex：租户级图号索引（前缀检索+保密过滤+分页）', () => {
  /** 三图号装配：dwg-001 链尾受限 / dwg-002 全公开 / dwg-003 全链受限（本租户）。 */
  async function publishIndexFixture(h: Harness): Promise<void> {
    await publishChain(h, 'dwg-001'); // v1/v2 public → v3/v4 restricted
    await publish(h, { drawingId: 'dwg-002', fileRef: 'f://002-1', changeNote: '首发（止于公开）' });
    await publish(h, { drawingId: 'dwg-003', fileRef: 'f://003-1', changeNote: '首发即受限', classification: 'restricted' });
  }

  /** 他租户落一张图（租户收口反证用）。 */
  async function publishOtherTenant(h: Harness): Promise<void> {
    opCounter += 1;
    const other = makeCommandEnvelope({
      tenantId: TenantId.create('t-drawing-other'),
      issuedBy: TECH,
      operationId: OperationId.create(`op-drawing-other-${String(opCounter).padStart(4, '0')}`),
      expectedRevision: 'initial',
      issuedAt: '2026-11-01T08:00:00.000Z',
      command: { kind: 'drawing.publish.v1' as const, payload: { drawingId: 'dwg-001', fileRef: 'f://ot-1', changeNote: '他租户同名图' } },
    });
    const result = await h.service.execute(TenantId.create('t-drawing-other'), other);
    expect(result.status).toBe('committed');
  }

  it('restricted 许可：全库可见图纸（drawingId 升序），latestVersion=真链尾，status 全 current', async () => {
    const h = makeHarness();
    await publishIndexFixture(h);
    const index = await h.service.drawingsIndex(TENANT, techViewer, { page: 1, pageSize: 20 });
    expect(index.drawings.map((d) => `${d.drawingId}@v${d.latestVersion}:${d.status}`)).toEqual([
      'dwg-001@v4:current',
      'dwg-002@v1:current',
      'dwg-003@v1:current',
    ]);
    expect(index.total).toBe(3);
    // 元数据口径：索引条目不含 fileRef（内容一律走查看留痕路径）
    expect(Object.keys(index.drawings[0]!)).not.toContain('fileRef');
  });

  it('public 许可：全链超许可图纸不进索引；混合链呈现许可内链尾+status=restricted', async () => {
    const h = makeHarness();
    await publishIndexFixture(h);
    const index = await h.service.drawingsIndex(TENANT, lineViewer, { page: 1, pageSize: 20 });
    expect(index.drawings).toEqual([
      { drawingId: 'dwg-001', latestVersion: 2, classification: 'public', status: 'restricted' },
      { drawingId: 'dwg-002', latestVersion: 1, classification: 'public', status: 'current' },
    ]);
    expect(index.total).toBe(2); // dwg-003 全链受限——不计数（不泄漏存在性）
  });

  it('前缀检索 + 分页：prefix 过滤、page/pageSize 切页、越界页空行不空 total', async () => {
    const h = makeHarness();
    await publishIndexFixture(h);
    const prefix = await h.service.drawingsIndex(TENANT, techViewer, { search: 'dwg-00', page: 1, pageSize: 2 });
    expect(prefix.drawings.map((d) => d.drawingId)).toEqual(['dwg-001', 'dwg-002']);
    expect(prefix.total).toBe(3); // dwg-003 匹配前缀但被 pageSize 截页
    const page2 = await h.service.drawingsIndex(TENANT, techViewer, { search: 'dwg-00', page: 2, pageSize: 2 });
    expect(page2.drawings.map((d) => d.drawingId)).toEqual(['dwg-003']);
    const beyond = await h.service.drawingsIndex(TENANT, techViewer, { search: 'dwg-00', page: 3, pageSize: 2 });
    expect(beyond.drawings).toEqual([]);
    expect(beyond.total).toBe(3);
    const exact = await h.service.drawingsIndex(TENANT, lineViewer, { search: 'dwg-003', page: 1, pageSize: 20 });
    expect(exact.drawings).toEqual([]); // 精确检索全受限图号=同形空（不区分不存在/不可见）
  });

  it('租户收口：他租户图纸（同名图号）不进本租户索引；索引查询不产生查看留痕', async () => {
    const h = makeHarness();
    await publishIndexFixture(h);
    await publishOtherTenant(h); // 他租户 dwg-001 v1
    const index = await h.service.drawingsIndex(TENANT, techViewer, { page: 1, pageSize: 20 });
    // 本租户三图在册；他租户同名 dwg-001 不叠加（租户谓词收口）
    expect(index.drawings.map((d) => `${d.drawingId}@v${d.latestVersion}`)).toEqual([
      'dwg-001@v4',
      'dwg-002@v1',
      'dwg-003@v1',
    ]);
    expect(await h.allViews()).toHaveLength(0); // 索引=元数据面，不落查看留痕
  });

  it('入参守界：page/pageSize/search/clearance 非法 fail-fast（不默认放行）', async () => {
    const h = makeHarness();
    await publishIndexFixture(h);
    await expect(h.service.drawingsIndex(TENANT, techViewer, { page: 0, pageSize: 20 })).rejects.toBeInstanceOf(
      DrawingInputError,
    );
    await expect(h.service.drawingsIndex(TENANT, techViewer, { page: 1, pageSize: 101 })).rejects.toBeInstanceOf(
      DrawingInputError,
    );
    await expect(
      h.service.drawingsIndex(TENANT, techViewer, { search: 'x'.repeat(129), page: 1, pageSize: 20 }),
    ).rejects.toBeInstanceOf(DrawingInputError);
    await expect(
      h.service.drawingsIndex(TENANT, { userId: LINE, clearance: 'top-secret' }, { page: 1, pageSize: 20 }),
    ).rejects.toBeInstanceOf(DrawingInputError);
  });
});

// ---- 边缘参数解析（组合根 HTTP 面复用的门禁） ----

describe('边缘参数解析（drawing-input）', () => {
  it('sinceVersion 游标 / version 路径参数：合法整数过、非法拒绝', async () => {
    const { parseSinceVersionParam, parseVersionParam, parseClearance } = await import('../src/index.js');
    expect(parseSinceVersionParam(undefined)).toBeUndefined();
    expect(parseSinceVersionParam('')).toBeUndefined();
    expect(parseSinceVersionParam('3')).toBe(3);
    expect(parseSinceVersionParam('0')).toBe(0);
    expect(() => parseSinceVersionParam('x')).toThrowError(/>= 0 的整数/);
    expect(parseVersionParam('3', 'version')).toBe(3);
    expect(() => parseVersionParam('0', 'version')).toThrowError(/>= 1 的整数/);
    expect(() => parseVersionParam('abc', 'version')).toThrowError(/>= 1 的整数/);
    expect(parseClearance('restricted', 'clearance')).toBe('restricted');
    expect(() => parseClearance('top-secret', 'clearance')).toThrowError(/public\/restricted/);
  });
});
