/**
 * drawing 薄数据层（D-WO-05 图纸页面呈现面）：fetch 直连 server drawing 端点，
 * 经共享 apiClient 注入 Bearer。端点/权限码/形状按 apps/server/src/
 * drawing-http.module.ts 实态映射（只读消费，不扩后端）：
 *   GET  /drawing/drawings?search=&page=&pageSize=&clearance=  图号索引（P1-c：
 *        前缀检索+保密过滤+分页；对象信封 { drawings, page, pageSize, total }）
 *   GET  /drawing/revisions/:drawingId?clearance=        修订链（裸数组，不含 fileRef）
 *   GET  /drawing/revisions/:drawingId/view?version=&clearance=&referenceTtlSeconds=
 *        查看（唯一 fileRef 取得路径，必留痕；P1-e：TTL 声明即回执附短时效
 *        只读引用 readReference）
 *   GET  /drawing/read-references/:token                  只读引用开门面（P1-e；
 *        token 即凭证，兑现仍必落查看留痕）
 *   GET  /drawing/notices/:drawingId?sinceVersion=&clearance=  变更通知（游标+保密过滤）
 *   GET  /drawing/work-orders/:workOrderId/drawings?clearance=  按工作令图纸清单（三态）
 *   GET  /drawing/view-audit?drawingId=&viewedBy=        查看留痕审计（drawing:audit-read）
 *   POST /drawing/revisions/commands                     drawing.publish.v1（信封）
 *
 * 取舍（钉在测试里）：
 *  - 保密值集镜像自 packages/drawing/src/drawing-config.ts CLASSIFICATION_LEVELS
 *    （web 不依赖 @smes/drawing 包——两处漂移由 drawing-pages.test.ts 钉形防）；
 *  - clearance 是 v1 显式请求参数（无租户许可配置面）——由页面自声明传入，
 *    未知词后端 fail-fast 400；
 *  - 查看是"读路径动作"但必落留痕（合同两不变量），前端按 mutation 呈现
 *    （不用 useQuery——避免缓存/refetch 产生幻影留痕行）；
 *  - fileRef 为字符串载荷（存储键/URL），无文件二进制上传端点——发布表单
 *    收文本（上传通道=登记不做，见回传）；
 *  - 只读引用 TTL 前端取 300 秒（后端上界 600）——复制-粘贴转递可用窗口；
 *    引用 URL 为相对路径（同源开门面），复制时前端补全 origin。
 */
import { fetchRawObject, postCommand, queryString } from '../../data/commandClient';
import type { CommandOutcomeView } from '../../data/commandClient';
import { request } from '../../data/apiClient';

/** 保密等级/许可值集（镜像 drawing-config.ts CLASSIFICATION_LEVELS；后位=更受限）。 */
export const CLEARANCE_LEVELS = ['public', 'restricted'] as const;

/** 人读标签（镜像 drawing-config.ts CLASSIFICATION_LEVEL_LABELS）。 */
export const CLEARANCE_LEVEL_LABELS: Readonly<Record<(typeof CLEARANCE_LEVELS)[number], string>> = {
  public: '公开',
  restricted: '受限',
};

export type ClearanceLevel = (typeof CLEARANCE_LEVELS)[number];

/** 修订链元数据行（drawing.service.ts DrawingRevisionSummaryView 实态；无 fileRef）。 */
export interface DrawingRevisionSummary {
  readonly id: string;
  readonly drawingId: string;
  readonly version: number;
  readonly changeNote: string;
  readonly classification: string;
  readonly changedBy: string;
  readonly changedAt: string;
  readonly supersedesVersion: number | null;
  readonly status: 'current' | 'superseded';
  readonly createdAt: string;
}

/** 短时效只读引用（P1-e；形状镜像 @smes/drawing DrawingReadReference）。 */
export interface DrawingReadReferenceView {
  readonly url: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly expiresInSeconds: number;
}

/** 修订内容视图（查看路径回执——唯一携 fileRef 的视图）。 */
export interface DrawingRevisionView extends DrawingRevisionSummary {
  readonly fileRef: string;
  /** 只读引用（P1-e：查看时声明 referenceTtlSeconds 才出现）。 */
  readonly readReference?: DrawingReadReferenceView;
}

/** 图号索引条目（P1-c；元数据口径不含 fileRef）。 */
export interface DrawingIndexEntry {
  readonly drawingId: string;
  /** 许可内链尾版本。 */
  readonly latestVersion: number;
  readonly classification: string;
  /** current=真链尾可见；restricted=存在超许可新修订（呈现许可内链尾）。 */
  readonly status: 'current' | 'restricted';
}

/** 图号索引分页信封（P1-c）。 */
export interface DrawingIndexPageView {
  readonly drawings: readonly DrawingIndexEntry[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

/** 前端只读引用 TTL（秒）：复制-粘贴转递窗口（后端上界 600）。 */
export const DRAWING_READ_REFERENCE_TTL_SECONDS = 300;

/** 变更通知行（ports.ts DrawingChangeNotice 实态）。 */
export interface DrawingChangeNoticeView {
  readonly noticeId: string;
  readonly drawingId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly changeNote: string;
  readonly publishedAt: string;
  readonly objectVersion: number;
  readonly auditStatus: string;
  readonly createdAt: string;
}

/** 按工作令图纸清单条目（drawing.service.ts WorkOrderDrawingView 三态实态）。 */
export type WorkOrderDrawingEntry =
  | {
      readonly drawingId: string;
      readonly version: number;
      readonly status: 'ok';
      readonly changeNote: string;
      readonly classification: string;
      readonly changedBy: string;
      readonly changedAt: string;
      readonly latestVersion: number;
      readonly hasUpdate: boolean;
    }
  | { readonly drawingId: string; readonly version: number; readonly status: 'restricted' }
  | { readonly drawingId: string; readonly version: number; readonly status: 'missing' };

/** 查看留痕行（drawing-stores.ts DrawingViewTrailRow 实态）。 */
export interface DrawingViewTrailEntry {
  readonly id: string;
  readonly seq: number;
  readonly drawingId: string;
  readonly version: number;
  readonly viewedBy: string;
  readonly viewedAt: string;
  readonly classification: string;
  readonly objectVersion: number;
  readonly auditStatus: string;
}

/** GET 裸数组端点（drawing 查询端点直返数组、无 envelope 键；坏形状抛错不静默）。 */
async function fetchBareArray<T>(path: string): Promise<readonly T[]> {
  const body: unknown = await request(path);
  if (!Array.isArray(body)) {
    throw new Error(`图纸端点响应形状非法（期望数组）：${path}`);
  }
  return body as readonly T[];
}

/** 修订链（clearance 过滤；元数据口径不含 fileRef）。 */
export function listRevisionChain(
  drawingId: string,
  clearance: ClearanceLevel,
): Promise<readonly DrawingRevisionSummary[]> {
  return fetchBareArray(
    `/drawing/revisions/${encodeURIComponent(drawingId)}${queryString([['clearance', clearance]])}`,
  );
}

/**
 * 查看修订（内容指针唯一取得路径）：过保密门禁→必落查看留痕→返回内容视图。
 * version 缺省=当前版（'latest'）；钉版查看传具体修订号。
 * P1-e：referenceTtlSeconds 声明（页面取 DRAWING_READ_REFERENCE_TTL_SECONDS）
 * 时回执附短时效只读引用。
 */
export async function viewDrawingRevision(
  drawingId: string,
  clearance: ClearanceLevel,
  version?: number,
  referenceTtlSeconds?: number,
): Promise<DrawingRevisionView> {
  const raw = await fetchRawObject(
    `/drawing/revisions/${encodeURIComponent(drawingId)}/view${queryString([
      ['version', version === undefined ? undefined : String(version)],
      ['clearance', clearance],
      ['referenceTtlSeconds', referenceTtlSeconds === undefined ? undefined : String(referenceTtlSeconds)],
    ])}`,
  );
  return raw as unknown as DrawingRevisionView;
}

/** 图号索引（P1-c）：search 前缀检索 + 分页 + 保密过滤（对象信封非裸数组）。 */
export async function listDrawingIndex(
  clearance: ClearanceLevel,
  params: { readonly search?: string | undefined; readonly page?: number; readonly pageSize?: number } = {},
): Promise<DrawingIndexPageView> {
  const raw = await fetchRawObject(
    `/drawing/drawings${queryString([
      ['search', params.search],
      ['page', params.page === undefined ? undefined : String(params.page)],
      ['pageSize', params.pageSize === undefined ? undefined : String(params.pageSize)],
      ['clearance', clearance],
    ])}`,
  );
  return raw as unknown as DrawingIndexPageView;
}

/** 只读引用开门面（P1-e）：token 换内容视图（兑现也必落查看留痕——慎用缓存）。 */
export function openDrawingReadReference(token: string): Promise<DrawingRevisionView> {
  return fetchRawObject(`/drawing/read-references/${encodeURIComponent(token)}`).then(
    (raw) => raw as unknown as DrawingRevisionView,
  );
}

/** 类型化行数组 → ModuleTable 行（共享表格件按 Record 投影；键序=后端字段序）。 */
export function asTableRows<T>(rows: readonly T[] | undefined): readonly Record<string, unknown>[] {
  return (rows ?? []) as unknown as readonly Record<string, unknown>[];
}

/** 变更通知读取（clearance 过滤：服务端只回有权通知；sinceVersion 游标缺省全量）。 */
export function listDrawingNotices(
  drawingId: string,
  clearance: ClearanceLevel,
  sinceVersion?: number,
): Promise<readonly DrawingChangeNoticeView[]> {
  return fetchBareArray(
    `/drawing/notices/${encodeURIComponent(drawingId)}${queryString([
      ['sinceVersion', sinceVersion === undefined ? undefined : String(sinceVersion)],
      ['clearance', clearance],
    ])}`,
  );
}

/** 按工作令图纸清单（refs 从附件钉版编码装配；三态 ok/restricted/missing）。 */
export function listWorkOrderDrawings(
  workOrderId: string,
  clearance: ClearanceLevel,
): Promise<readonly WorkOrderDrawingEntry[]> {
  return fetchBareArray(
    `/drawing/work-orders/${encodeURIComponent(workOrderId)}/drawings${queryString([
      ['clearance', clearance],
    ])}`,
  );
}

/** 查看留痕审计（保密管理员；按图纸/按查看人过滤，seq 升序）。 */
export function listDrawingViewAudit(filter: {
  readonly drawingId?: string | undefined;
  readonly viewedBy?: string | undefined;
} = {}): Promise<readonly DrawingViewTrailEntry[]> {
  return fetchBareArray(
    `/drawing/view-audit${queryString([
      ['drawingId', filter.drawingId],
      ['viewedBy', filter.viewedBy],
    ])}`,
  );
}

/**
 * 发布新修订（drawing.publish.v1）：version 由链尾+1（客户端不传）；
 * expectedRevision 乐观锁（'initial'=首发，N=在当前 vN 上追加）；
 * classification 缺省 public（载荷不送空串——后端 undefined 落缺省）。
 */
export function publishDrawingRevision(input: {
  readonly drawingId: string;
  readonly fileRef: string;
  readonly changeNote: string;
  readonly classification: ClearanceLevel;
  readonly expectedRevision: number | 'initial';
}): Promise<CommandOutcomeView> {
  return postCommand(
    '/drawing/revisions/commands',
    'drawing.publish.v1',
    {
      drawingId: input.drawingId,
      fileRef: input.fileRef,
      changeNote: input.changeNote,
      classification: input.classification,
    },
    input.expectedRevision,
  );
}
