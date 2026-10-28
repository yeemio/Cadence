/**
 * 四类清单页（S2 批次）：按工作令查询零件/标准件/电气件/设备采购清单 + 骨架
 * 导入 + 选中清单详情（含行）+ 行修订。覆盖矩阵 #31-34。
 * fix-wave-6 6b-3（A14）：列表列显隐记忆接入（useColumnVisibility，
 * pageKey=/listings/sheets，隐藏集跨会话/跨设备恢复；6b-3 接入页由
 * dispatch 改选本页——dispatch 页被 6a-1 在途批操作/页眉统计占用，登记）。
 * UX-PLAN-02：新增「新增清单行」表单（复用后端行导入通道：物料编码自动比对
 * 物料库；无该类目清单时自动创建）+ 空态引导到骨架导入/手工录入两个入口。
 * UX-PLAN-05：类目列中文展示，可见文案不出现接口路径/命令名/内部字段名。
 * UX-PLAN-12：骨架导入成功提示补「清单行仍需在此维护」引导。
 * UX-PLAN-15：删除「状态」「版本」两列——清单头投影（ListingSheet 实体）
 * 无 status/objectVersion 字段（W5 验收确认，登记），两列恒 '—' 无信息量；
 * 详情行表的行级 objectVersion 是真实乐观锁版本，保留不动。
 * M2-R1 岗位入口补齐：工作令输入升级为「可搜索选择 + 手填兜底」（datalist
 * 候选池，无候选权限/无数据静默回退手填——照 DispatchOrdersPage UX-PRD-09
 * 模式）；支持 ?wo= 直达（工作令页入口带所选单进入）并回写 URL；已选工作令
 * 人话确认（项目名 + 短码，悬停看全号），换单仍走原表单清态路径。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import {
  addListingLine,
  getSheetDetail,
  importSkeleton,
  listSheets,
  updateListingLine,
  type ListingKindId,
} from '../../data/listingApi';
// M2-R1：工作令候选池数据源（只读复用工作令列表 API，不改其导出）。
import { listWorkOrders } from '../../data/workorderApi';
import { rowsOf, type CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState } from '../../components/ModuleTable';
import type { TableColumn } from '../../components/ModuleTable';
import { ColumnVisibilityMenu } from '../../components/ColumnVisibilityMenu';
import { useColumnVisibility } from '../../hooks/useColumnVisibility';
// P2 横切批：时刻本地化/长 id 截断显示（UX-PLAN-07/08；行数据不动，title 悬停全文）。
import { formatLocalDateTime, shortId } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

/** 四类清单 kind → 中文名（词源 listing-config LISTING_KIND_LABELS，不造新词）。 */
const LISTING_KIND_LABELS: Readonly<Record<string, string>> = {
  part: '零件清单',
  standard: '标准件清单',
  electrical: '电气件清单',
  equipment: '设备采购清单',
};

const KIND_OPTIONS: readonly ListingKindId[] = ['part', 'standard', 'electrical', 'equipment'];

function listingKindLabel(kind: unknown): string {
  const id = kind === null || kind === undefined ? '' : String(kind);
  return LISTING_KIND_LABELS[id] ?? id;
}

/**
 * M2-R1：候选池中找工作令的展示名（项目名）。候选池缺失（无工作令读权限）或
 * 查无此单时回落 null——确认行只显短码，不阻断手填路径。
 */
function workOrderProjectName(
  rows: readonly Record<string, unknown>[],
  workOrderId: string,
): string | null {
  const row = rows.find((item) => String(item['id']) === workOrderId);
  const name = row === undefined ? undefined : row['projectName'];
  return typeof name === 'string' && name.length > 0 ? name : null;
}

/** UX-PLAN-15：清单头投影无 status/objectVersion（登记见文件头），不设恒 '—' 列。 */
const SHEET_COLUMNS = [
  { key: 'id', label: '编号', mono: true, format: 'shortId' },
  { key: 'kind', label: '类目' },
  { key: 'workOrderId', label: '工作令', mono: true, format: 'shortId' },
] as const satisfies readonly TableColumn[];

/** 列显隐记忆键（A14 / RREQ-INT-032：pageKey=路由 path，tableKey=本页主表）。 */
const COLUMN_PREFS_PAGE = '/listings/sheets';
const COLUMN_PREFS_TABLE = 'main';

export function ListingSheetsPage() {
  const queryClient = useQueryClient();
  // M2-R1：?wo=<id> 直达（工作令页清单/缺口核查入口落点）；换单后回写 URL，
  // 刷新/分享不丢所选对象（syncWithLocation 同图纸库 ?drawingId= 先例）。
  const [searchParams, setSearchParams] = useSearchParams();
  const initialWorkOrderId = (searchParams.get('wo') ?? '').trim();
  const { visibleColumns, isColumnHidden, toggleColumn } = useColumnVisibility({
    pageKey: COLUMN_PREFS_PAGE,
    tableKey: COLUMN_PREFS_TABLE,
    columns: SHEET_COLUMNS,
  });
  const [workOrderIdInput, setWorkOrderIdInput] = useState(initialWorkOrderId);
  const [workOrderId, setWorkOrderId] = useState<string | null>(
    initialWorkOrderId.length > 0 ? initialWorkOrderId : null,
  );
  const [selectedSheetId, setSelectedSheetId] = useState<string | null>(null);
  const [selectedLine, setSelectedLine] = useState<Record<string, unknown> | null>(null);

  // M2-R1：工作令候选池（datalist——手填兼容；无工作令读权限/无数据静默回退
  // 纯手填，不阻断查询。候选只做提示，不改变查询键控与提交载荷语义）。
  const workOrderOptionsQuery = useQuery({
    queryKey: ['workorder', 'orders', 'options'],
    queryFn: () => listWorkOrders().catch(() => []),
    staleTime: 60_000,
  });
  const selectedWorkOrderName =
    workOrderId === null ? null : workOrderProjectName(workOrderOptionsQuery.data ?? [], workOrderId);

  const sheetsQuery = useQuery({
    queryKey: ['listing', 'sheets', workOrderId],
    queryFn: () => listSheets(workOrderId as string),
    enabled: workOrderId !== null,
  });

  const sheetDetailQuery = useQuery({
    queryKey: ['listing', 'sheet', selectedSheetId],
    queryFn: () => getSheetDetail(selectedSheetId as string),
    enabled: selectedSheetId !== null,
  });

  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);
  const importMutation = useMutation({
    mutationFn: () => importSkeleton(workOrderIdInput.trim()),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) {
        const committedWorkOrderId = workOrderIdInput.trim();
        setWorkOrderId(committedWorkOrderId);
        setSearchParams({ wo: committedWorkOrderId }, { replace: true });
        queryClient.invalidateQueries({ queryKey: ['listing'] });
      }
    },
    onError: (error) =>
      setOutcome({
        committed: false,
        status: 'error',
        reason: error instanceof Error ? error.message : String(error),
      }),
  });

  function handleLoad(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = workOrderIdInput.trim();
    if (trimmed.length === 0) return;
    setWorkOrderId(trimmed);
    setSelectedSheetId(null);
    setSelectedLine(null);
    setSearchParams({ wo: trimmed }, { replace: true });
  }

  return (
    <div className="flex flex-col gap-6">
      {/* M2-R1：页面级工作令候选池（datalist 由工作令输入以 list 属性引用） */}
      <datalist id="sheets-wo-options">
        {(workOrderOptionsQuery.data ?? []).map((row) => (
          <option key={String(row['id'])} value={String(row['id'])}>
            {String(row['projectName'] ?? '')}
          </option>
        ))}
      </datalist>
      <Card>
        <CardHeader>
          <CardTitle>四类清单</CardTitle>
          <CardDescription>
            按工作令查看零件、标准件、电气件、设备采购四类清单；从候选选择或粘贴工作令编号后查询，可在下方直接新增清单行。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form className="flex flex-col gap-4 sm:flex-row sm:items-end" onSubmit={handleLoad}>
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="sheets-wo">工作令</Label>
              <Input
                id="sheets-wo"
                value={workOrderIdInput}
                list="sheets-wo-options"
                onChange={(e) => setWorkOrderIdInput(e.target.value)}
                placeholder="从候选选择，或粘贴工作令编号"
                required
              />
            </div>
            <Button type="submit">查询清单</Button>
            <Button
              type="button"
              variant="outline"
              disabled={importMutation.isPending || workOrderIdInput.trim().length === 0}
              onClick={() => importMutation.mutate()}
            >
              骨架导入（建四类空清单）
            </Button>
          </form>
          {/* M2-R1：已选工作令人话确认（项目名 + 短码；候选池查无此单只显短码，悬停看全号）。 */}
          {workOrderId !== null && (
            <p className="text-sm text-muted-foreground">
              当前工作令：{selectedWorkOrderName === null ? '' : `${selectedWorkOrderName} · `}
              <span className="font-mono" title={workOrderId}>{shortId(workOrderId)}</span>
            </p>
          )}
          {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
          {/* UX-PLAN-12：骨架导入成功后补维护引导——骨架只建空清单头，
              明细行仍需在本页「新增清单行」录入，不引导会停在空清单。 */}
          {importMutation.data !== undefined && importMutation.data.committed && (
            <p className="text-sm text-muted-foreground">
              骨架已生成四类空清单框架；各类清单的具体行（物料、数量）仍需在本页「新增清单行」中维护。
            </p>
          )}
          {workOrderId !== null && (
            <QueryState
              isPending={sheetsQuery.isPending}
              error={sheetsQuery.error}
              isEmpty={sheetsQuery.data !== undefined && sheetsQuery.data.length === 0}
              empty="该工作令尚无清单：可先「骨架导入」建立四类空清单，或直接在下方「新增清单行」录入（系统会自动创建对应类目的清单）。"
            >
              <ModuleTable
                columns={visibleColumns}
                rows={(sheetsQuery.data ?? []).map((row) => ({ ...row, kind: listingKindLabel(row['kind']) }))}
                selectedId={selectedSheetId}
                onSelect={(row) => setSelectedSheetId(String(row['id']))}
              />
              <ColumnVisibilityMenu
                columns={SHEET_COLUMNS}
                isColumnHidden={isColumnHidden}
                toggleColumn={toggleColumn}
              />
            </QueryState>
          )}
        </CardContent>
      </Card>

      {workOrderId !== null && (
        <AddLineCard
          workOrderId={workOrderId}
          defaultKind={kindOfSheet(sheetsQuery.data ?? [], selectedSheetId)}
          onAdded={() => queryClient.invalidateQueries({ queryKey: ['listing'] })}
        />
      )}

      {selectedSheetId !== null && (
        <Card>
          <CardHeader>
            <CardTitle>清单详情（含行）</CardTitle>
            <CardDescription>点行选中后用下方表单修订数量；新增行用上方「新增清单行」表单。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <QueryState isPending={sheetDetailQuery.isPending} error={sheetDetailQuery.error} isEmpty={false}>
              <SheetSummary view={sheetDetailQuery.data ?? {}} />
            </QueryState>
            {sheetDetailQuery.data !== undefined && (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">清单行（点行选中）</p>
                <ModuleTable
                  columns={[
                    { key: 'id', label: '行 id', mono: true, format: 'shortId' },
                    { key: 'drawingNo', label: '图号', mono: true },
                    { key: 'code', label: '物料编码', mono: true },
                    { key: 'name', label: '名称' },
                    { key: 'requiredQty', label: '需求数量' },
                    { key: 'itemId', label: '确认物料', mono: true, format: 'shortId' },
                    { key: 'objectVersion', label: '版本', mono: true },
                  ]}
                  rows={safeRows(sheetDetailQuery.data, 'lines')}
                  selectedId={selectedLine === null ? null : String(selectedLine['id'] ?? '')}
                  onSelect={(row) => setSelectedLine(row)}
                />
              </div>
            )}
            <LineUpdateCard
              line={selectedLine}
              onChanged={() => {
                setSelectedLine(null);
                queryClient.invalidateQueries({ queryKey: ['listing'] });
              }}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** 选中清单（或未选）时推导新增行的缺省类目。 */
function kindOfSheet(
  sheets: readonly Record<string, unknown>[],
  selectedSheetId: string | null,
): ListingKindId | '' {
  const sheet = sheets.find((row) => String(row['id']) === selectedSheetId);
  const kind = sheet === undefined ? undefined : String(sheet['kind'] ?? '');
  return KIND_OPTIONS.includes(kind as ListingKindId) ? (kind as ListingKindId) : '';
}

/** 清单头摘要（人话）：类目/名称/所属工作令/行数/创建时间。 */
function SheetSummary({ view }: { readonly view: Record<string, unknown> }) {
  const sheet = (view['sheet'] ?? null) as Record<string, unknown> | null;
  if (sheet === null) {
    return <p className="text-sm text-muted-foreground">暂无清单数据</p>;
  }
  const lines = Array.isArray(view['lines']) ? (view['lines'] as readonly unknown[]).length : 0;
  const entries: readonly (readonly [string, string])[] = [
    ['类目', listingKindLabel(sheet['kind'])],
    ['清单名称', sheet['name'] === null || sheet['name'] === undefined ? '—' : String(sheet['name'])],
    ['所属工作令', sheet['workOrderId'] === null || sheet['workOrderId'] === undefined ? '—' : String(sheet['workOrderId'])],
    ['行数', String(lines)],
    ['创建时刻', formatLocalDateTime(sheet['createdAt'])],
  ];
  return (
    <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[minmax(8rem,auto)_1fr]">
      {entries.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function safeRows(view: Record<string, unknown>, key: string): readonly Record<string, unknown>[] {
  try {
    return rowsOf(view, key);
  } catch {
    return [];
  }
}

/**
 * 新增清单行表单（UX-PLAN-02）：复用后端行导入通道——物料编码会自动比对
 * 物料库（比对结果在行上回显），无该类目清单时自动创建清单。
 */
function AddLineCard({
  workOrderId,
  defaultKind,
  onAdded,
}: {
  readonly workOrderId: string;
  readonly defaultKind: ListingKindId | '';
  readonly onAdded: () => void;
}) {
  const [kind, setKind] = useState<ListingKindId | ''>(defaultKind);
  // 未手工选择时跟随选中清单的类目（选中清单变化即联动；手工改过则尊重手工值）。
  const effectiveKind: ListingKindId | '' = kind === '' ? defaultKind : kind;
  const [drawingNo, setDrawingNo] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [spec, setSpec] = useState('');
  const [requiredQty, setRequiredQty] = useState('');
  const [neededBy, setNeededBy] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: (input: Parameters<typeof addListingLine>[0]) => addListingLine(input),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) {
        setDrawingNo('');
        setCode('');
        setName('');
        setSpec('');
        setRequiredQty('');
        setNeededBy('');
        onAdded();
      }
    },
    onError: (error) =>
      setOutcome({
        committed: false,
        status: 'error',
        reason: error instanceof Error ? error.message : String(error),
      }),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (effectiveKind === '') return;
    const qty = Number(requiredQty);
    if (!Number.isFinite(qty) || qty <= 0) return;
    mutation.mutate({
      workOrderId,
      kind: effectiveKind,
      ...(drawingNo.trim().length > 0 ? { drawingNo: drawingNo.trim() } : {}),
      ...(code.trim().length > 0 ? { code: code.trim() } : {}),
      ...(name.trim().length > 0 ? { name: name.trim() } : {}),
      ...(spec.trim().length > 0 ? { spec: spec.trim() } : {}),
      requiredQty: qty,
      ...(neededBy.trim().length > 0 ? { neededBy: neededBy.trim() } : {}),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>新增清单行</CardTitle>
        <CardDescription>
          录入一行清单需求（图号/编码/名称/规格至少填一项）；物料编码会自动比对物料库，无该类目清单时自动创建。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 sm:grid-cols-3 lg:grid-cols-4" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="add-line-kind">类目</Label>
            <Select
              id="add-line-kind"
              value={effectiveKind}
              onChange={(e) => setKind(e.target.value as ListingKindId | '')}
            >
              <option value="">选择类目…</option>
              {KIND_OPTIONS.map((option) => (
                <option key={option} value={option}>{listingKindLabel(option)}</option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="add-line-drawing">图号（可选）</Label>
            <Input id="add-line-drawing" value={drawingNo} onChange={(e) => setDrawingNo(e.target.value)} placeholder="DWG-01" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="add-line-code">物料编码（可选）</Label>
            <Input id="add-line-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="M-001" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="add-line-name">物料名称（可选）</Label>
            <Input id="add-line-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="名称" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="add-line-spec">规格型号（可选）</Label>
            <Input id="add-line-spec" value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="规格" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="add-line-qty">需求数量</Label>
            <Input
              id="add-line-qty"
              type="number"
              min="0.000001"
              step="any"
              value={requiredQty}
              onChange={(e) => setRequiredQty(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="add-line-needed-by">需求日期（可选）</Label>
            <Input id="add-line-needed-by" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} placeholder="2026-12-01" />
          </div>
          <div className="flex items-end">
            <Button
              type="submit"
              disabled={
                mutation.isPending ||
                effectiveKind === '' ||
                requiredQty.trim().length === 0 ||
                Number(requiredQty) <= 0 ||
                [drawingNo, code, name, spec].every((field) => field.trim().length === 0)
              }
            >
              新增清单行
            </Button>
          </div>
          {outcome !== null && <div className="sm:col-span-3 lg:col-span-4"><CommandOutcomeHint outcome={outcome} /></div>}
        </form>
      </CardContent>
    </Card>
  );
}

/** 清单行修订（数量；行版本乐观锁取自选中行）。 */
function LineUpdateCard({
  line,
  onChanged,
}: {
  readonly line: Record<string, unknown> | null;
  readonly onChanged: () => void;
}) {
  const [requiredQty, setRequiredQty] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: (input: { line: Record<string, unknown>; qty: number }) =>
      updateListingLine(String(input.line['id']), input.line, { requiredQty: input.qty }),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) {
        onChanged();
        setRequiredQty('');
      }
    },
    onError: (error) =>
      setOutcome({
        committed: false,
        status: 'error',
        reason: error instanceof Error ? error.message : String(error),
      }),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const qty = Number(requiredQty);
    if (line === null || !Number.isFinite(qty) || qty <= 0) return;
    mutation.mutate({ line, qty });
  }

  return (
    <form className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={handleSubmit}>
      <div className="flex flex-col gap-2">
        <Label htmlFor="line-update-id">选中行 id</Label>
        <Input
          id="line-update-id"
          value={line === null ? '' : String(line['id'] ?? '')}
          readOnly
          placeholder="先在上方点选清单行"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="line-update-qty">修订需求数量</Label>
        <Input
          id="line-update-qty"
          type="number"
          min="0.000001"
          step="any"
          value={requiredQty}
          onChange={(e) => setRequiredQty(e.target.value)}
          required
        />
      </div>
      <Button type="submit" disabled={mutation.isPending || line === null}>修订行</Button>
      {outcome !== null && <div className="sm:col-span-3"><CommandOutcomeHint outcome={outcome} /></div>}
    </form>
  );
}
