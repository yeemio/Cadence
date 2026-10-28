/**
 * 图纸页面呈现面装配与数据层接缝测试（D-WO-05，node 纯逻辑 + fetch/window
 * stub）：钉住 drawingApi → apiClient → drawing 端点（drawing-http.module.ts
 * 实态）的确切 HTTP 形状：
 * 1. 两新页（drawing-library/drawing-audit）挂进 PAGE_BY_CODE 且菜单路由 +
 *    权限码与后端控制器同码（drawing:read / drawing:audit-read）；
 * 2. 六端点形状：修订链（clearance 过滤）/查看（version+clearance）/通知
 *    （sinceVersion 游标）/按工作令清单（三态）/留痕审计（双过滤）/发布
 *    命令（smes.command.v1 信封 + expectedRevision 乐观锁口径）；
 * 3. 保密值集镜像钉形（web 不依赖 @smes/drawing——与 drawing-config.ts
 *    CLASSIFICATION_LEVELS 的漂移由本文件字面钉防）；
 * 4. 裸数组响应坏形状抛错（不静默）。真实留痕/门禁行为由后端域测试与容器
 *    e2e 实证（不在本文件）。
 * 5. 同形 404 呈现（P0 REWORK 补钉①）：超保密等级不可见与不存在同形 404
 *    ——transport 层钉 ApiError(404) 且 message=服务端 message 原文。
 * 6. 查看动作呈现纪律（P0 REWORK 补钉②，总控裁定形式 a 源码钉）：
 *    viewDrawingRevision 调用点必须经 useMutation 包裹（useQuery 包裹的
 *    缓存/refetch 会产生幻影留痕行）——正钉调用点上下文 + 反钉无 queryFn
 *    直接调用。
 * 7. P1 深化三件（drawing-module/CONTRACT.md P1 节）：图号索引端点钉形
 *    （P1-c）+ 工艺路线互链客户端拼装摘要（P1-b）+ 只读引用 TTL/开门面/
 *    复制入口（P1-e）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { permissionCode } from '@smes/product-ui';

// ---- window / localStorage stub（apiClient 模块加载即读 window.localStorage） ----
const storageBacking = new Map<string, string>();
const localStorageStub: Storage = {
  getItem: (key) => storageBacking.get(key) ?? null,
  setItem: (key, value) => void storageBacking.set(key, value),
  removeItem: (key) => void storageBacking.delete(key),
  clear: () => void storageBacking.clear(),
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

const { PAGE_BY_CODE } = await import('../src/pages/assembly.js');
const drawingApi = await import('../src/pages/drawing/drawingApi.js');
const { menuRoutes } = await import('../src/menu.js');

let calls: Array<{ url: string; init: RequestInit | undefined }> = [];
let responder: (() => Promise<unknown>) | null = null;

function respond(body: unknown, status = 200): void {
  responder = async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

beforeEach(() => {
  calls = [];
  responder = null;
  storageBacking.clear();
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (responder === null) throw new TypeError('fetch not stubbed');
    return responder();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('D-WO-05 装配：两新页挂接与权限码（控制器同码）', () => {
  it('drawing-library/drawing-audit 有真实页面 + 菜单路由 + drawing 域实态权限码', () => {
    const expected = new Map([
      ['drawing-library', 'drawing:read'],
      ['drawing-audit', 'drawing:audit-read'],
    ]);
    for (const [code, permission] of expected) {
      expect(typeof PAGE_BY_CODE[code], `装配表缺 '${code}'`).toBe('function');
      const route = menuRoutes.find((candidate) => candidate.code === code);
      expect(route, `菜单缺 '${code}' 路由`).toBeDefined();
      expect(route?.permission).toBe(permissionCode(permission));
    }
  });
});

describe('保密值集镜像（与 drawing-config.ts 同源，字面钉防漂移）', () => {
  it('值集两级 + 人读标签（后位=更受限）', () => {
    expect(drawingApi.CLEARANCE_LEVELS).toEqual(['public', 'restricted']);
    expect(drawingApi.CLEARANCE_LEVEL_LABELS).toEqual({ public: '公开', restricted: '受限' });
  });
});

describe('查询端点钉形（drawing-http.module.ts 实态，裸数组响应）', () => {
  it('修订链：GET /drawing/revisions/:drawingId?clearance=（clearance 过滤，元数据口径）', async () => {
    respond([
      {
        id: 'dr-1',
        drawingId: 'DWG-A01',
        version: 2,
        changeNote: '修改了什么',
        classification: 'restricted',
        changedBy: 'user-tech',
        changedAt: '2026-10-26T01:00:00.000Z',
        supersedesVersion: 1,
        status: 'current',
        createdAt: '2026-10-26T01:00:00.000Z',
      },
    ]);
    const chain = await drawingApi.listRevisionChain('DWG-A01', 'restricted');
    expect(calls[0]?.url).toBe('/drawing/revisions/DWG-A01?clearance=restricted');
    expect(chain).toHaveLength(1);
    expect(chain[0]?.version).toBe(2);
    // 元数据口径：链行不含 fileRef（内容一律走查看留痕路径）
    expect(Object.keys(chain[0] ?? {})).not.toContain('fileRef');
  });

  it('图号含特殊字符：路径段 URL 编码', async () => {
    respond([]);
    await drawingApi.listRevisionChain('DWG A/01', 'public');
    expect(calls[0]?.url).toBe('/drawing/revisions/DWG%20A%2F01?clearance=public');
  });

  it('查看钉版：GET /drawing/revisions/:id/view?version=&clearance=（fileRef 唯一取得路径）', async () => {
    respond({
      id: 'dr-1',
      drawingId: 'DWG-A01',
      version: 2,
      fileRef: 's3://drawings/DWG-A01/v2.pdf',
      changeNote: '修改了什么',
      classification: 'restricted',
      changedBy: 'user-tech',
      changedAt: '2026-10-26T01:00:00.000Z',
      supersedesVersion: 1,
      status: 'current',
      createdAt: '2026-10-26T01:00:00.000Z',
    });
    const view = await drawingApi.viewDrawingRevision('DWG-A01', 'restricted', 2);
    expect(calls[0]?.url).toBe('/drawing/revisions/DWG-A01/view?version=2&clearance=restricted');
    expect(view.fileRef).toBe('s3://drawings/DWG-A01/v2.pdf');
  });

  it('查看当前版：version 缺省不送参（服务端 latest）', async () => {
    respond({ id: 'dr-2', drawingId: 'DWG-A01', version: 3, fileRef: 's3://v3.pdf' });
    await drawingApi.viewDrawingRevision('DWG-A01', 'public');
    expect(calls[0]?.url).toBe('/drawing/revisions/DWG-A01/view?clearance=public');
  });

  it('变更通知：GET /drawing/notices/:id?sinceVersion=&clearance=（clearance 过滤；游标缺省全量）', async () => {
    respond([]);
    await drawingApi.listDrawingNotices('DWG-A01', 'restricted', 0);
    expect(calls[0]?.url).toBe('/drawing/notices/DWG-A01?sinceVersion=0&clearance=restricted');
    respond([]);
    await drawingApi.listDrawingNotices('DWG-A01', 'public');
    expect(calls[1]?.url).toBe('/drawing/notices/DWG-A01?clearance=public');
  });

  it('按工作令清单：GET /drawing/work-orders/:id/drawings?clearance=（三态条目）', async () => {
    respond([
      {
        drawingId: 'DWG-A01',
        version: 1,
        status: 'ok',
        changeNote: '首发',
        classification: 'public',
        changedBy: 'user-tech',
        changedAt: '2026-10-26T01:00:00.000Z',
        latestVersion: 2,
        hasUpdate: true,
      },
      { drawingId: 'DWG-B02', version: 1, status: 'restricted' },
      { drawingId: 'DWG-C03', version: 9, status: 'missing' },
    ]);
    const entries = await drawingApi.listWorkOrderDrawings('wo-0001', 'public');
    expect(calls[0]?.url).toBe('/drawing/work-orders/wo-0001/drawings?clearance=public');
    expect(entries.map((entry) => entry.status)).toEqual(['ok', 'restricted', 'missing']);
    expect(entries[0]?.status === 'ok' && entries[0].hasUpdate).toBe(true);
  });

  it('留痕审计：GET /drawing/view-audit?drawingId=&viewedBy=（过滤可省）', async () => {
    respond([
      {
        id: 'dvt-1',
        seq: 1,
        drawingId: 'DWG-A01',
        version: 2,
        viewedBy: 'user-shop',
        viewedAt: '2026-10-26T02:00:00.000Z',
        classification: 'restricted',
        objectVersion: 1,
        auditStatus: 'viewed',
      },
    ]);
    const trails = await drawingApi.listDrawingViewAudit({ drawingId: 'DWG-A01', viewedBy: 'user-shop' });
    expect(calls[0]?.url).toBe('/drawing/view-audit?drawingId=DWG-A01&viewedBy=user-shop');
    expect(trails[0]?.viewedBy).toBe('user-shop');

    respond([]);
    await drawingApi.listDrawingViewAudit();
    expect(calls[1]?.url).toBe('/drawing/view-audit');
  });

  it('裸数组端点坏形状（对象响应）→ 抛错不静默', async () => {
    respond({ revisions: [] });
    const error: unknown = await drawingApi.listRevisionChain('DWG-A01', 'public').then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
  });
});

describe('同形 404 呈现（超保密等级不可见与不存在同形——transport 层钉形）', () => {
  it('查看超保密等级：404 → ApiError 且 message=服务端 message 原文（页面如实呈现，不猜测区分不存在/不可见）', async () => {
    respond(
      { statusCode: 404, message: "租户 'tenant-ops' 内不存在图纸 'DWG-A01' 的可查看修订 v2" },
      404,
    );
    const error: unknown = await drawingApi.viewDrawingRevision('DWG-A01', 'public', 2).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({
      name: 'ApiError',
      status: 404,
      message: "租户 'tenant-ops' 内不存在图纸 'DWG-A01' 的可查看修订 v2",
    });
  });

  it('修订链端点 404 → ApiError 透传服务端 message 原文（呈现层纪律：404 不静默、不改写文案）', async () => {
    respond(
      { statusCode: 404, message: "租户 'tenant-ops' 内不存在图纸 'DWG-X99' 的可查看修订 当前版" },
      404,
    );
    const error: unknown = await drawingApi.listRevisionChain('DWG-X99', 'public').then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({
      name: 'ApiError',
      status: 404,
      message: "租户 'tenant-ops' 内不存在图纸 'DWG-X99' 的可查看修订 当前版",
    });
  });
});

// ---- 查看动作呈现纪律：源码钉（总控裁定形式 a——轻量源码钉，非豁免登记） ----
// 查看是读路径动作但必落留痕（两不变量）：若用 useQuery 包裹 viewDrawingRevision，
// 缓存命中/自动 refetch 会产生幻影留痕行。此处钉源码调用点上下文：
//   1. 调用点必须经 useMutation 的 mutationFn 包裹（正钉）；
//   2. 任何 queryFn 不得直接调用 viewDrawingRevision（反钉）。
const librarySource = readFileSync(
  new URL('../src/pages/drawing/DrawingLibraryPage.tsx', import.meta.url),
  'utf8',
);

describe('查看动作呈现纪律（mutation 呈现不留幻影留痕——源码钉）', () => {
  it('viewDrawingRevision 调用点经 useMutation.mutationFn 包裹（P1-e 起声明只读引用 TTL）', () => {
    expect(librarySource).toContain(
      'const viewMutation = useMutation({\n    mutationFn: (version: number | undefined) =>\n      viewDrawingRevision(drawingId, clearance, version, DRAWING_READ_REFERENCE_TTL_SECONDS),',
    );
  });

  it('无任何 queryFn 直接调用 viewDrawingRevision（useQuery 包裹即幻影留痕）', () => {
    expect(librarySource).not.toMatch(/queryFn:[^\n]*viewDrawingRevision/);
    expect(librarySource).toContain('useMutation'); // 防源码钉串整体失配后空过
  });
});

// ---- P1-c 图号索引（索引列表+检索消费，撤销"无索引"登记） ----

describe('P1-c 图号索引端点钉形（GET /drawing/drawings，对象信封分页）', () => {
  it('前缀+分页+保密过滤全参', async () => {
    respond({ drawings: [{ drawingId: 'DWG-A01', latestVersion: 2, classification: 'public', status: 'current' }], page: 1, pageSize: 20, total: 1 });
    const index = await drawingApi.listDrawingIndex('restricted', { search: 'DWG-A', page: 1, pageSize: 20 });
    expect(calls[0]?.url).toBe('/drawing/drawings?search=DWG-A&page=1&pageSize=20&clearance=restricted');
    expect(index.total).toBe(1);
    expect(index.drawings[0]).toMatchObject({ drawingId: 'DWG-A01', latestVersion: 2, status: 'current' });
    expect(Object.keys(index.drawings[0]!)).not.toContain('fileRef'); // 元数据口径
  });

  it('缺省参数不送串（全量第一页）；restricted 状态行如实呈现', async () => {
    respond({
      drawings: [{ drawingId: 'DWG-B02', latestVersion: 1, classification: 'public', status: 'restricted' }],
      page: 1,
      pageSize: 20,
      total: 1,
    });
    const index = await drawingApi.listDrawingIndex('public');
    expect(calls[0]?.url).toBe('/drawing/drawings?clearance=public');
    expect(index.drawings[0]?.status).toBe('restricted'); // 有超许可新修订——呈现许可内链尾
  });
});

// ---- P1-b 工艺路线互链（客户端拼装：摘要 + 链接工艺路线页） ----

const { routingSummaryOf } = await import('../src/pages/drawing/DrawingLibraryPage.js');

describe('P1-b 工艺路线互链（最小互链：客户端拼装，不做双向绑定）', () => {
  it('getRouting 同图号回执拼装摘要："工序 N 道 · 末道 X"', () => {
    const routing = {
      current: {
        code: 'DWG-A01',
        steps: [
          { seq: 1, processCode: 'OP-10', remark: null },
          { seq: 2, processCode: 'OP-20', remark: null },
          { seq: 3, processCode: 'OP-30', remark: '末道检验' },
        ],
      },
      versions: [],
    };
    expect(routingSummaryOf(routing)).toBe('工序 3 道 · 末道 OP-30');
  });

  it('无路线/空步序列=占位符（互链失败不构成图纸页错误）', () => {
    expect(routingSummaryOf({ current: { steps: [] } })).toBe('—（无工序）');
    expect(routingSummaryOf({})).toBe('—（无工序）');
  });

  it('页面源码钉：消费 baseline getRouting + 链接工艺路线页（无路线变更联动图纸）', () => {
    expect(librarySource).toContain("import { getRouting } from '../../data/baselineApi'");
    expect(librarySource).toContain("to=\"/baseline/routings\"");
    expect(librarySource).not.toMatch(/defineRouting|routingRevise/); // 只读互链——不做路线写联动
  });
});

// ---- P1-e 签名引用 URL（查看回执可选携带 + 开门面 + 复制入口） ----

describe('P1-e 只读引用钉形（view 回执 referenceTtlSeconds + 开门面）', () => {
  it('查看声明 TTL：GET /drawing/revisions/:id/view?…&referenceTtlSeconds=300（前端缺省 300）', async () => {
    respond({
      id: 'dr-1',
      drawingId: 'DWG-A01',
      version: 2,
      fileRef: 's3://drawings/DWG-A01/v2.pdf',
      readReference: {
        url: '/drawing/read-references/v1.eyJ0ZW5hbnRJZCI6InQxIn0.sig',
        token: 'v1.eyJ0ZW5hbnRJZCI6InQxIn0.sig',
        expiresAt: '2026-10-26T02:05:00.000Z',
        expiresInSeconds: 300,
      },
    });
    const view = await drawingApi.viewDrawingRevision('DWG-A01', 'restricted', 2, drawingApi.DRAWING_READ_REFERENCE_TTL_SECONDS);
    expect(calls[0]?.url).toBe(
      '/drawing/revisions/DWG-A01/view?version=2&clearance=restricted&referenceTtlSeconds=300',
    );
    expect(view.readReference?.expiresInSeconds).toBe(300);
    expect(view.readReference?.url.startsWith('/drawing/read-references/v1.')).toBe(true);
  });

  it('未声明 TTL 不送参（缺省行为零变化——回执无 readReference）', async () => {
    respond({ id: 'dr-2', drawingId: 'DWG-A01', version: 3, fileRef: 's3://v3.pdf' });
    const view = await drawingApi.viewDrawingRevision('DWG-A01', 'public');
    expect(calls[0]?.url).toBe('/drawing/revisions/DWG-A01/view?clearance=public');
    expect(view.readReference).toBeUndefined();
  });

  it('开门面：GET /drawing/read-references/:token（token 路径段 URL 编码）', async () => {
    respond({ id: 'dr-1', drawingId: 'DWG-A01', version: 2, fileRef: 's3://v2.pdf' });
    await drawingApi.openDrawingReadReference('v1.abc.def');
    expect(calls[0]?.url).toBe('/drawing/read-references/v1.abc.def');
  });

  it('页面源码钉：查看回执面板含「复制引用链接」入口（相对 URL 补全同源绝对链接）', () => {
    expect(librarySource).toContain('复制引用链接');
    expect(librarySource).toContain('new URL(url, window.location.origin).toString()');
  });
});

describe('发布命令钉形（POST /drawing/revisions/commands，smes.command.v1 信封）', () => {
  it('首发：expectedRevision=initial，载荷四键（version 由链尾+1 不传）', async () => {
    respond({ status: 'committed', newRevision: 1 });
    const outcome = await drawingApi.publishDrawingRevision({
      drawingId: 'DWG-A01',
      fileRef: 's3://drawings/DWG-A01/v1.pdf',
      changeNote: '首发',
      classification: 'public',
      expectedRevision: 'initial',
    });
    expect(calls[0]?.url).toBe('/drawing/revisions/commands');
    expect(calls[0]?.init?.method).toBe('POST');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(typeof body['operationId']).toBe('string');
    expect(body['expectedRevision']).toBe('initial');
    const command = body['command'] as { kind: string; payload: Record<string, unknown> };
    expect(command.kind).toBe('drawing.publish.v1');
    expect(command.payload).toEqual({
      drawingId: 'DWG-A01',
      fileRef: 's3://drawings/DWG-A01/v1.pdf',
      changeNote: '首发',
      classification: 'public',
    });
    expect(outcome.committed).toBe(true);
  });

  it('追加：expectedRevision=链尾版本整数（乐观锁口径）', async () => {
    respond({ status: 'committed', newRevision: 1 });
    await drawingApi.publishDrawingRevision({
      drawingId: 'DWG-A01',
      fileRef: 's3://drawings/DWG-A01/v4.pdf',
      changeNote: '第四版',
      classification: 'restricted',
      expectedRevision: 3,
    });
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body['expectedRevision']).toBe(3);
    const command = body['command'] as { kind: string; payload: Record<string, unknown> };
    expect(command.payload['classification']).toBe('restricted');
  });

  it('乐观锁冲突（rejected 是业务结果不是传输错误）：committed=false + reason 透传', async () => {
    respond({
      status: 'rejected',
      reason: "乐观锁冲突：图纸 'DWG-A01' 声明 expectedRevision=2，当前链尾 version=3（不重试同信封）",
    });
    const outcome = await drawingApi.publishDrawingRevision({
      drawingId: 'DWG-A01',
      fileRef: 's3://drawings/DWG-A01/v4.pdf',
      changeNote: '第四版',
      classification: 'public',
      expectedRevision: 2,
    });
    expect(outcome.committed).toBe(false);
    expect(outcome.reason).toContain('乐观锁冲突');
  });
});
