/**
 * 图纸库页（D-WO-05 + P1 深化三件消费面）：
 *  - P1-c 图号索引列表：GET /drawing/drawings?search=&page=（前缀检索+保密过滤
 *    +分页）——列表态呈现租户内可见图纸（全链超许可的图纸不进索引）；行点击
 *    打开该图修订链（原 drawingId 精确检索升级为索引+检索消费，"无索引"登记
 *    撤销）；?drawingId= 直达链仍保留（工作令清单卡等入口）。
 *  - P1-b 工艺路线互链（O1 裁定=最小互链）：索引行客户端拼装同图号工艺路线
 *    摘要（GET /baseline/routings/:drawingNo →"工序 N 道·末道 X"）+ 链接到
 *    工艺路线页；两域各持键不做双向强绑定、路线变更不联动图纸（登记）。
 *  - P1-e 只读引用：查看回执（唯一 fileRef 视图）可选携带短时效签名 URL
 *    （referenceTtlSeconds=300）——"复制引用链接"入口；兑现走开门面仍必落
 *    查看留痕（两不变量红线，页面侧不绕过）。
 *
 * 保密两级呈现（合同 §2 两不变量的页面语义）：
 *  - clearance 为 v1 显式请求参数（无租户许可配置面）——页面自声明选择；
 *  - public 许可只见公开修订；restricted 许可两级都见；
 *  - 超保密等级不可见与图纸不存在同形 404——页面如实呈现服务端消息，
 *    不猜测区分"不存在/不可见"；
 *  - 每次查看（含公开级）都产生查看留痕——查看按钮文案明示。
 *  - 文件上传通道不存在——fileRef 按字符串载荷（存储键/URL）收文本。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { getRouting } from '../../data/baselineApi';
import {
  asTableRows,
  CLEARANCE_LEVELS,
  CLEARANCE_LEVEL_LABELS,
  DRAWING_READ_REFERENCE_TTL_SECONDS,
  listDrawingIndex,
  listDrawingNotices,
  listRevisionChain,
  publishDrawingRevision,
  viewDrawingRevision,
  type ClearanceLevel,
  type DrawingIndexEntry,
  type DrawingIndexPageView,
  type DrawingRevisionSummary,
  type DrawingRevisionView,
} from './drawingApi';
import { CommandOutcomeHint, ModuleTable, QueryState } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

/** 保密等级人读标签（未知码原样呈现——值集扩级不改本页）。 */
function classificationLabel(value: string): string {
  return value in CLEARANCE_LEVEL_LABELS
    ? `${CLEARANCE_LEVEL_LABELS[value as ClearanceLevel]}（${value}）`
    : value;
}

/**
 * 工艺路线摘要（P1-b 客户端拼装，行为锚定测试钉形）：
 * "工序 N 道 · 末道 X"；无路线/空步序列=占位符（无工艺路线不构成本页错误）。
 */
export function routingSummaryOf(routing: Record<string, unknown>): string {
  const current = routing['current'] as { readonly steps?: readonly { readonly processCode: string }[] } | undefined;
  const steps = Array.isArray(current?.steps) ? current.steps : [];
  if (steps.length === 0) return '—（无工序）';
  return `工序 ${String(steps.length)} 道 · 末道 ${steps[steps.length - 1]!.processCode}`;
}

export function DrawingLibraryPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // 工作令图纸清单等入口经 ?drawingId= 直达（syncWithLocation）。
  const initialDrawingId = searchParams.get('drawingId') ?? '';
  const [activeDrawingId, setActiveDrawingId] = useState(
    initialDrawingId.trim().length > 0 ? initialDrawingId.trim() : null,
  );
  const [clearance, setClearance] = useState<ClearanceLevel>('public');

  const chainQuery = useQuery({
    queryKey: ['drawing', 'chain', activeDrawingId, clearance],
    queryFn: () => listRevisionChain(activeDrawingId as string, clearance),
    enabled: activeDrawingId !== null,
  });

  function handleOpenFromIndex(drawingId: string) {
    setActiveDrawingId(drawingId);
    setSearchParams({ drawingId }, { replace: true });
  }

  const chain = chainQuery.data;
  // 链尾取服务端字段：status='current' = 真链尾标记（drawing.service.ts 按未过滤
  // 链计算；许可过滤后真链尾不可见则链内无 current 行 → 不显示 latest=vN——
  // 许可内链尾 ≠ 服务端链尾，不以过滤链尾误导）。
  const currentVersion = chain?.find((row) => row.status === 'current')?.version ?? null;

  return (
    <div className="flex flex-col gap-6">
      <IndexCard
        clearance={clearance}
        onClearanceChange={setClearance}
        onOpen={handleOpenFromIndex}
        initialSearch={initialDrawingId}
        activeDrawingId={activeDrawingId}
      />

      {activeDrawingId !== null && (
        <>
          <ChainCard
            drawingId={activeDrawingId}
            clearance={clearance}
            chain={chain ?? []}
            chainError={chainQuery.error}
            chainPending={chainQuery.isPending}
            currentVersion={currentVersion}
            onViewed={() => queryClient.invalidateQueries({ queryKey: ['drawing'] })}
          />
          <NoticesCard drawingId={activeDrawingId} />
          <PublishCard
            defaultDrawingId={activeDrawingId}
            currentVersion={currentVersion}
            onPublished={() => queryClient.invalidateQueries({ queryKey: ['drawing'] })}
          />
        </>
      )}
    </div>
  );
}

/**
 * 图号索引卡片（P1-c）：前缀检索 + 分页列表；行=许可内链尾（latestVersion/
 * classification/status）+ 工艺路线互链（P1-b）+ 打开修订链动作。
 * 列表是元数据面不产生查看留痕；点击行只切换激活图号（查看仍必经链卡的
 * 留痕路径）。
 */
function IndexCard({
  clearance,
  onClearanceChange,
  onOpen,
  initialSearch,
  activeDrawingId,
}: {
  readonly clearance: ClearanceLevel;
  readonly onClearanceChange: (level: ClearanceLevel) => void;
  readonly onOpen: (drawingId: string) => void;
  readonly initialSearch: string;
  readonly activeDrawingId: string | null;
}) {
  const [searchInput, setSearchInput] = useState(initialSearch);
  const [search, setSearch] = useState<string | undefined>(
    initialSearch.trim().length > 0 ? initialSearch.trim() : undefined,
  );
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const indexQuery = useQuery({
    queryKey: ['drawing', 'index', clearance, search, page],
    queryFn: () => listDrawingIndex(clearance, { search, page, pageSize }),
  });
  const index: DrawingIndexPageView | undefined = indexQuery.data;
  const totalPages = index === undefined || index.total === 0 ? 1 : Math.ceil(index.total / index.pageSize);

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    const trimmed = searchInput.trim();
    setSearch(trimmed.length > 0 ? trimmed : undefined);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>图纸索引（租户级列表）</CardTitle>
        <CardDescription>
          按图号前缀检索租户内可见图纸（drawingId 前缀匹配）；当前版本=许可内链尾，
          restricted=存在超保密许可的新修订（呈现许可内链尾，不回显隐藏版号）。
          全链超许可的图纸不进索引（与单图同形 404 同纪律）。列表是元数据面，
          不产生查看留痕。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form className="flex flex-wrap items-end gap-3" onSubmit={handleSearch}>
          <div className="flex w-72 flex-col gap-2">
            <Label htmlFor="drawing-index-search">图号前缀（留空=全部）</Label>
            <Input
              id="drawing-index-search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="DWG-A"
            />
          </div>
          <div className="flex w-64 flex-col gap-2">
            <Label htmlFor="drawing-clearance">保密许可（自声明，v1 无租户许可配置面）</Label>
            <Select
              id="drawing-clearance"
              value={clearance}
              onChange={(event) => {
                setPage(1);
                onClearanceChange(event.target.value as ClearanceLevel);
              }}
            >
              {CLEARANCE_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {CLEARANCE_LEVEL_LABELS[level]}（{level}）
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" variant="outline">
            检索
          </Button>
        </form>
        <QueryState
          isPending={indexQuery.isPending}
          error={indexQuery.error}
          isEmpty={index !== undefined && index.drawings.length === 0}
          empty="当前保密许可内无可见图纸（或前缀无匹配）"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium whitespace-nowrap">图号（drawingId）</th>
                  <th className="py-2 pr-4 font-medium whitespace-nowrap">当前版本（许可内链尾）</th>
                  <th className="py-2 pr-4 font-medium whitespace-nowrap">保密等级</th>
                  <th className="py-2 pr-4 font-medium whitespace-nowrap">状态</th>
                  <th className="py-2 pr-4 font-medium whitespace-nowrap">工艺路线（P1 互链）</th>
                  <th className="py-2 pr-4 font-medium whitespace-nowrap">修订链</th>
                </tr>
              </thead>
              <tbody>
                {(index?.drawings ?? []).map((entry) => (
                  <IndexRow
                    key={entry.drawingId}
                    entry={entry}
                    active={entry.drawingId === activeDrawingId}
                    onOpen={onOpen}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={page <= 1 || indexQuery.isPending}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              上一页
            </Button>
            <span data-testid="drawing-index-pagination">
              第 {String(page)} / {String(totalPages)} 页 · 共 {String(index?.total ?? 0)} 张可见图纸
            </span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={page >= totalPages || indexQuery.isPending}
              onClick={() => setPage((current) => current + 1)}
            >
              下一页
            </Button>
          </div>
        </QueryState>
        <p className="text-sm text-muted-foreground">
          两级保密：公开（public）修订对公开许可可见；受限（restricted）修订需受限许可。
          超保密等级不可见与图纸不存在同形 404（页面如实呈现服务端消息，不区分两者）。
        </p>
      </CardContent>
    </Card>
  );
}

/** 索引行：元数据 + 工艺路线互链摘要（P1-b）+ 打开动作。 */
function IndexRow({
  entry,
  active,
  onOpen,
}: {
  readonly entry: DrawingIndexEntry;
  readonly active: boolean;
  readonly onOpen: (drawingId: string) => void;
}) {
  return (
    <tr className={`border-b last:border-b-0 ${active ? 'bg-muted/50' : ''}`}>
      <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap">{entry.drawingId}</td>
      <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap">v{entry.latestVersion}</td>
      <td className="py-2 pr-4 whitespace-nowrap">{classificationLabel(entry.classification)}</td>
      <td className="py-2 pr-4 text-xs whitespace-nowrap">
        {entry.status === 'current'
          ? 'current（真链尾可见）'
          : 'restricted（有超许可新修订，呈现许可内链尾）'}
      </td>
      <td className="py-2 pr-4 whitespace-nowrap">
        <RoutingLinkCell drawingId={entry.drawingId} />
      </td>
      <td className="py-2 pr-4 whitespace-nowrap">
        <Button variant="outline" size="xs" onClick={() => onOpen(entry.drawingId)}>
          打开修订链
        </Button>
      </td>
    </tr>
  );
}

/**
 * 工艺路线互链单元格（P1-b 最小互链，O1 裁定）：读 baseline getRouting 同图号，
 * 客户端拼装"工序 N 道·末道 X"摘要 + 链接到工艺路线页（/baseline/routings）。
 * 不做双向强绑定/路线变更联动图纸（两域各持键）；无路线或无 routing:read
 * 权限（404/403）一律占位符呈现——互链失败不构成图纸页错误。
 */
function RoutingLinkCell({ drawingId }: { readonly drawingId: string }) {
  const routingQuery = useQuery({
    queryKey: ['baseline', 'routing', drawingId],
    queryFn: () => getRouting(drawingId),
    retry: false,
  });
  return (
    <span className="text-xs whitespace-nowrap">
      {routingQuery.isPending ? '…' : routingQuery.data !== undefined ? routingSummaryOf(routingQuery.data) : '—'}
      <Link
        className="ml-2 text-primary underline-offset-4 hover:underline"
        to="/baseline/routings"
        title="打开工艺路线页（同图号业务键）"
      >
        工艺路线页
      </Link>
    </span>
  );
}

/** 修订链 + 查看（留痕路径）卡片。行内"查看"动作故本页自建表格（ModuleTable 无行内件）。 */
function ChainCard({
  drawingId,
  clearance,
  chain,
  chainError,
  chainPending,
  currentVersion,
  onViewed,
}: {
  readonly drawingId: string;
  readonly clearance: ClearanceLevel;
  readonly chain: readonly DrawingRevisionSummary[];
  readonly chainError: unknown;
  readonly chainPending: boolean;
  readonly currentVersion: number | null;
  readonly onViewed: () => void;
}) {
  // 查看是读路径动作但必落留痕（两不变量）——按 mutation 呈现，不走 useQuery。
  // P1-e：查看即声明短时效只读引用 TTL（回执"复制引用链接"入口）。
  const viewMutation = useMutation({
    mutationFn: (version: number | undefined) =>
      viewDrawingRevision(drawingId, clearance, version, DRAWING_READ_REFERENCE_TTL_SECONDS),
  });

  function handleView(version: number | undefined) {
    viewMutation.mutate(version, { onSuccess: onViewed });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>修订链（append-only）</CardTitle>
        <CardDescription>
          钉版纪律：工作令附件按「drawingId@vN」钉版引用；发布新版不改既有引用（升级是显式
          动作）。链为元数据口径，不含内容指针 fileRef——内容一律经「查看」取得（每次查看
          必落留痕：谁/何时/哪版）。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <QueryState
          isPending={chainPending}
          error={chainError}
          isEmpty={chain.length === 0}
          empty="该图号在当前保密许可内无可见修订（不可见与不存在同形 404）"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium whitespace-nowrap">版本</th>
                  <th className="py-2 pr-4 font-medium whitespace-nowrap">保密等级</th>
                  <th className="py-2 pr-4 font-medium whitespace-nowrap">状态</th>
                  <th className="py-2 pr-4 font-medium whitespace-nowrap">发布人</th>
                  <th className="py-2 pr-4 font-medium whitespace-nowrap">发布时刻</th>
                  <th className="py-2 pr-4 font-medium whitespace-nowrap">取代版本</th>
                  <th className="py-2 pr-4 font-medium whitespace-nowrap">变更说明</th>
                  <th className="py-2 pr-4 font-medium whitespace-nowrap">查看（必留痕）</th>
                </tr>
              </thead>
              <tbody>
                {chain.map((row) => (
                  <tr key={row.version} className="border-b last:border-b-0">
                    <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap">v{row.version}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{classificationLabel(row.classification)}</td>
                    <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap">
                      {row.status === 'current' ? 'current（链尾）' : 'superseded（钉版常态）'}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap">{row.changedBy}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{row.changedAt}</td>
                    <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap">
                      {row.supersedesVersion === null ? '—（首发）' : `v${row.supersedesVersion}`}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{row.changeNote}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={viewMutation.isPending}
                        onClick={() => handleView(row.version)}
                      >
                        查看 v{row.version}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={viewMutation.isPending}
            onClick={() => handleView(undefined)}
          >
            查看当前版（latest{currentVersion !== null ? ` = v${currentVersion}` : ''}）
          </Button>
        </QueryState>

        {viewMutation.isError && (
          <p role="alert" className="text-sm text-destructive">
            查看失败：{viewMutation.error instanceof Error ? viewMutation.error.message : String(viewMutation.error)}
          </p>
        )}
        {viewMutation.data !== undefined && <RevisionViewPanel view={viewMutation.data} />}
      </CardContent>
    </Card>
  );
}

/** 查看回执面板（唯一携 fileRef 的视图；查看已留痕）。 */
function RevisionViewPanel({ view }: { readonly view: DrawingRevisionView }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  /** 相对引用 URL 补全为同源绝对链接（复制转递用；兑现在登录态下）。 */
  function absoluteReferenceUrl(url: string): string {
    return new URL(url, window.location.origin).toString();
  }

  async function handleCopyReference() {
    if (view.readReference === undefined) return;
    try {
      await navigator.clipboard.writeText(absoluteReferenceUrl(view.readReference.url));
      setCopyState('copied');
    } catch {
      setCopyState('failed'); // URL 已按文本呈现——可手动复制
    }
  }

  return (
    <div className="rounded-lg border p-4" data-testid="drawing-view-receipt">
      <p className="text-sm font-medium">
        已查看 v{view.version}（本次查看已落留痕）
      </p>
      <dl className="mt-2 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[minmax(9rem,auto)_1fr]">
        <dt className="font-mono text-xs text-muted-foreground">fileRef（内容指针）</dt>
        <dd className="break-all font-mono text-xs">{view.fileRef}</dd>
        {view.readReference !== undefined && (
          <>
            <dt className="font-mono text-xs text-muted-foreground">
              只读引用（{String(view.readReference.expiresInSeconds)} 秒，至 {view.readReference.expiresAt}）
            </dt>
            <dd className="flex flex-wrap items-center gap-2">
              <code className="break-all font-mono text-xs" data-testid="drawing-read-reference-url">
                {absoluteReferenceUrl(view.readReference.url)}
              </code>
              <Button variant="outline" size="xs" onClick={() => void handleCopyReference()}>
                复制引用链接
              </Button>
              {copyState === 'copied' && <span className="text-xs text-muted-foreground">已复制</span>}
              {copyState === 'failed' && <span className="text-xs text-destructive">复制失败（可手动选取上方链接）</span>}
            </dd>
          </>
        )}
        <dt className="font-mono text-xs text-muted-foreground">保密等级</dt>
        <dd className="font-mono text-xs">{classificationLabel(view.classification)}</dd>
        <dt className="font-mono text-xs text-muted-foreground">status</dt>
        <dd className="font-mono text-xs">{view.status}</dd>
        <dt className="font-mono text-xs text-muted-foreground">changedBy / changedAt</dt>
        <dd className="font-mono text-xs">
          {view.changedBy} / {view.changedAt}
        </dd>
        <dt className="font-mono text-xs text-muted-foreground">changeNote</dt>
        <dd className="font-mono text-xs">{view.changeNote}</dd>
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">
        短时效只读引用=本次查看的回执能力（过期失效、兑现仍必落查看留痕；无登录门，token 即唯一凭证——链接勿转交无关人员）；内容指针按后端回显原样呈现；水印/下载控制属实施层后续（22 册）。
      </p>
    </div>
  );
}

/** 变更通知卡片（sinceVersion 游标——"我引用的 vN 是否已有更新"对账入口）。 */
function NoticesCard({ drawingId }: { readonly drawingId: string }) {
  const [sinceInput, setSinceInput] = useState('');
  const [sinceVersion, setSinceVersion] = useState<number | undefined>(undefined);

  const noticesQuery = useQuery({
    queryKey: ['drawing', 'notices', drawingId, sinceVersion],
    queryFn: () => listDrawingNotices(drawingId, sinceVersion),
  });

  function handleApply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = sinceInput.trim();
    if (trimmed.length === 0) {
      setSinceVersion(undefined);
      return;
    }
    const parsed = Number(trimmed);
    setSinceVersion(Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>变更通知</CardTitle>
        <CardDescription>
          新修订发布即联动落通知（from→to，首发 from=0）；游标 sinceVersion 只取 toVersion
          大于游标的通知（升序）——钉版引用方对账"我引用的 vN 是否已有更新"。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form className="flex items-end gap-3" onSubmit={handleApply}>
          <div className="flex w-56 flex-col gap-2">
            <Label htmlFor="drawing-since">游标 sinceVersion（留空=全量）</Label>
            <Input
              id="drawing-since"
              value={sinceInput}
              onChange={(event) => setSinceInput(event.target.value)}
              placeholder="0"
              inputMode="numeric"
            />
          </div>
          <Button type="submit" variant="outline">应用游标</Button>
        </form>
        <QueryState
          isPending={noticesQuery.isPending}
          error={noticesQuery.error}
          isEmpty={noticesQuery.data !== undefined && noticesQuery.data.length === 0}
          empty="该图号暂无变更通知"
        >
          <ModuleTable
            rowIdKey="noticeId"
            columns={[
              { key: 'fromVersion', label: 'from', mono: true },
              { key: 'toVersion', label: 'to', mono: true },
              { key: 'changeNote', label: '变更说明' },
              { key: 'publishedAt', label: '发布时刻' },
              { key: 'auditStatus', label: '审核状态', mono: true },
            ]}
            rows={asTableRows(noticesQuery.data)}
          />
        </QueryState>
      </CardContent>
    </Card>
  );
}

/** 发布新修订卡片（drawing.publish.v1）。 */
function PublishCard({
  defaultDrawingId,
  currentVersion,
  onPublished,
}: {
  readonly defaultDrawingId: string;
  readonly currentVersion: number | null;
  readonly onPublished: () => void;
}) {
  const [drawingId, setDrawingId] = useState(defaultDrawingId);
  const [mode, setMode] = useState<'initial' | 'append'>('initial');
  const [expectedInput, setExpectedInput] = useState('');
  const [fileRef, setFileRef] = useState('');
  const [changeNote, setChangeNote] = useState('');
  const [classification, setClassification] = useState<ClearanceLevel>('public');

  const publishMutation = useMutation({
    mutationFn: publishDrawingRevision,
    onSuccess: (outcome) => {
      if (outcome.committed) {
        setFileRef('');
        setChangeNote('');
        onPublished();
      }
    },
  });

  function handlePublish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === 'initial') {
      publishMutation.mutate({
        drawingId: drawingId.trim(),
        fileRef: fileRef.trim(),
        changeNote: changeNote.trim(),
        classification,
        expectedRevision: 'initial',
      });
      return;
    }
    const tail = Number(expectedInput);
    if (!Number.isInteger(tail) || tail < 1) return;
    publishMutation.mutate({
      drawingId: drawingId.trim(),
      fileRef: fileRef.trim(),
      changeNote: changeNote.trim(),
      classification,
      expectedRevision: tail,
    });
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>发布新修订</CardTitle>
        <CardDescription>
          drawing.publish.v1：版本号由链尾+1（不传客户端值）；发布即联动落变更通知。
          需 drawing:publish 权限。文件上传通道后端暂无——fileRef 按存储键/URL 文本载荷
          （登记不做上传，见任务回传）。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={handlePublish}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="publish-drawing-id">图号（drawingId）</Label>
            <Input
              id="publish-drawing-id"
              value={drawingId}
              onChange={(event) => setDrawingId(event.target.value)}
              placeholder="DWG-A01"
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="publish-mode">乐观锁 expectedRevision</Label>
            <Select
              id="publish-mode"
              value={mode}
              onChange={(event) => setMode(event.target.value === 'append' ? 'append' : 'initial')}
            >
              <option value="initial">initial（首发）</option>
              <option value="append">追加（声明当前链尾版本）</option>
            </Select>
          </div>
          {mode === 'append' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="publish-expected">当前链尾 version</Label>
              <Input
                id="publish-expected"
                value={expectedInput}
                onChange={(event) => setExpectedInput(event.target.value)}
                placeholder={currentVersion !== null ? String(currentVersion) : '如 3'}
                inputMode="numeric"
                required
              />
              {currentVersion !== null && (
                <p className="text-xs text-muted-foreground">
                  修订链当前链尾：v{currentVersion}（预填建议，以提交时链尾为准）
                </p>
              )}
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="publish-classification">保密等级</Label>
            <Select
              id="publish-classification"
              value={classification}
              onChange={(event) => setClassification(event.target.value as ClearanceLevel)}
            >
              {CLEARANCE_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {CLEARANCE_LEVEL_LABELS[level]}（{level}）
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="publish-fileref">fileRef（存储键/URL）</Label>
            <Input
              id="publish-fileref"
              value={fileRef}
              onChange={(event) => setFileRef(event.target.value)}
              placeholder="s3://drawings/DWG-A01/v4.pdf"
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="publish-changenote">变更说明（必填）</Label>
            <Input
              id="publish-changenote"
              value={changeNote}
              onChange={(event) => setChangeNote(event.target.value)}
              placeholder="修改了什么（修订链追溯锚点）"
              required
            />
          </div>
          {publishMutation.isError && (
            <p role="alert" className="text-sm text-destructive sm:col-span-2">
              发布失败：{publishMutation.error instanceof Error ? publishMutation.error.message : String(publishMutation.error)}
            </p>
          )}
          {publishMutation.data !== undefined && (
            <div className="sm:col-span-2">
              <CommandOutcomeHint outcome={publishMutation.data} />
            </div>
          )}
          <div className="sm:col-span-2">
            <Button
              type="submit"
              disabled={
                publishMutation.isPending ||
                drawingId.trim().length === 0 ||
                fileRef.trim().length === 0 ||
                changeNote.trim().length === 0 ||
                (mode === 'append' && expectedInput.trim().length === 0)
              }
            >
              发布修订
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
