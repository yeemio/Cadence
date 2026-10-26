/**
 * 四类清单页（S2 批次）：按工作令查询零件/标准件/电气件/设备采购清单 + 骨架
 * 导入 + 选中清单详情（含行）+ 行修订。覆盖矩阵 #31-34。
 * fix-wave-6 6b-3（A14）：列表列显隐记忆接入（useColumnVisibility，
 * pageKey=/listings/sheets，隐藏集跨会话/跨设备恢复；6b-3 接入页由
 * dispatch 改选本页——dispatch 页被 6a-1 在途批操作/页眉统计占用，登记）。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getSheetDetail, importSkeleton, listSheets, updateListingLine } from '../../data/listingApi';
import { rowsOf, type CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState, RowDetail } from '../../components/ModuleTable';
import type { TableColumn } from '../../components/ModuleTable';
import { ColumnVisibilityMenu } from '../../components/ColumnVisibilityMenu';
import { useColumnVisibility } from '../../hooks/useColumnVisibility';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const SHEET_COLUMNS = [
  { key: 'id', label: 'id', mono: true },
  { key: 'kind', label: '类目', mono: true },
  { key: 'workOrderId', label: '工作令', mono: true },
  { key: 'status', label: '状态', mono: true },
  { key: 'objectVersion', label: '版本', mono: true },
] as const satisfies readonly TableColumn[];

/** 列显隐记忆键（A14 / RREQ-INT-032：pageKey=路由 path，tableKey=本页主表）。 */
const COLUMN_PREFS_PAGE = '/listings/sheets';
const COLUMN_PREFS_TABLE = 'main';

export function ListingSheetsPage() {
  const queryClient = useQueryClient();
  const { visibleColumns, isColumnHidden, toggleColumn } = useColumnVisibility({
    pageKey: COLUMN_PREFS_PAGE,
    tableKey: COLUMN_PREFS_TABLE,
    columns: SHEET_COLUMNS,
  });
  const [workOrderIdInput, setWorkOrderIdInput] = useState('');
  const [workOrderId, setWorkOrderId] = useState<string | null>(null);
  const [selectedSheetId, setSelectedSheetId] = useState<string | null>(null);
  const [selectedLine, setSelectedLine] = useState<Record<string, unknown> | null>(null);

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
        setWorkOrderId(workOrderIdInput.trim());
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
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>四类清单</CardTitle>
          <CardDescription>
            零件/标准件/电气件/设备采购清单按工作令查询（listing.sheets 端点 workOrderId 必填）。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form className="flex flex-col gap-4 sm:flex-row sm:items-end" onSubmit={handleLoad}>
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="sheets-wo">工作令 id</Label>
              <Input
                id="sheets-wo"
                value={workOrderIdInput}
                onChange={(e) => setWorkOrderIdInput(e.target.value)}
                placeholder="粘贴工作令 id"
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
          {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
          {workOrderId !== null && (
            <QueryState
              isPending={sheetsQuery.isPending}
              error={sheetsQuery.error}
              isEmpty={sheetsQuery.data !== undefined && sheetsQuery.data.length === 0}
              empty="该工作令尚无清单（可先执行骨架导入）"
            >
              <ModuleTable
                columns={visibleColumns}
                rows={sheetsQuery.data ?? []}
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

      {selectedSheetId !== null && (
        <Card>
          <CardHeader>
            <CardTitle>清单详情（含行）</CardTitle>
            <CardDescription>点行选中后用下方表单修订（行 objectVersion 乐观锁自动取自选中行）。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <QueryState isPending={sheetDetailQuery.isPending} error={sheetDetailQuery.error} isEmpty={false}>
              <RowDetail row={sheetDetailQuery.data ?? {}} />
            </QueryState>
            {sheetDetailQuery.data !== undefined && (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">清单行（点行选中）</p>
                <ModuleTable
                  columns={[
                    { key: 'id', label: '行 id', mono: true },
                    { key: 'drawingNo', label: '图号', mono: true },
                    { key: 'code', label: '物料编码', mono: true },
                    { key: 'name', label: '名称' },
                    { key: 'requiredQty', label: '需求数量' },
                    { key: 'itemId', label: '确认物料', mono: true },
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

function safeRows(view: Record<string, unknown>, key: string): readonly Record<string, unknown>[] {
  try {
    return rowsOf(view, key);
  } catch {
    return [];
  }
}

/** 清单行修订（listing.line.update.v1：行 objectVersion 乐观锁取自选中行）。 */
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
