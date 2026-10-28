/**
 * 缺口核查页（S2 批次）：按工作令执行 gap.check（清单×库存可用量，不可变快照）
 * + 读回最新快照。覆盖矩阵 #73-76（加工非标件/外购非标件/标准件/电气件核查）。
 * UX-PLAN-03（Round-2 裁决）：核查结果人话展示——空清单（无行可核）不判齐套
 * 并给出警示引导，类目汇总对 0 行类目显示「无清单行（未参与核查）」而非「齐套」
 * （vacuous truth 修正在服务端 complete 口径，读面据实呈现）。
 * UX-PLAN-05：可见文案不出现接口路径/命令名/内部字段名。
 * M2-R1 岗位入口补齐：工作令输入升级为「可搜索选择 + 手填兜底」（datalist
 * 候选池，静默降级口径同四类清单页）；支持 ?wo= 直达并直接读该单最新快照
 * （只读，不自动执行核查）；换单即清上一单快照与提示，不以旧单结果冒充新单
 * 最新核查；已选工作令人话确认（项目名 + 短码，悬停看全号）。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { getLatestGapCheck, runGapCheck } from '../../data/listingApi';
// M2-R1：工作令候选池数据源（只读复用工作令列表 API，不改其导出）。
import { listWorkOrders } from '../../data/workorderApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState } from '../../components/ModuleTable';
// P2 横切批：时刻本地化/长 id 截断显示（UX-PLAN-07/08；行数据不动，title 悬停全文）。
import { formatLocalDateTime, shortId } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** 四类清单 kind → 中文名（词源 listing-config LISTING_KIND_LABELS，不造新词）。 */
const LISTING_KIND_LABELS: Readonly<Record<string, string>> = {
  part: '零件清单',
  standard: '标准件清单',
  electrical: '电气件清单',
  equipment: '设备采购清单',
};

function listingKindLabel(kind: unknown): string {
  const id = kind === null || kind === undefined ? '' : String(kind);
  return LISTING_KIND_LABELS[id] ?? id;
}

function textOf(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
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

export function GapChecksPage() {
  const queryClient = useQueryClient();
  // M2-R1：?wo=<id> 直达（工作令页入口落点）——初始化即读该单最新快照
  // （只读；不自动执行核查）；换单后回写 URL，刷新/分享不丢所选对象。
  const [searchParams, setSearchParams] = useSearchParams();
  const initialWorkOrderId = (searchParams.get('wo') ?? '').trim();
  const [workOrderId, setWorkOrderId] = useState(initialWorkOrderId);
  const [loadedId, setLoadedId] = useState<string | null>(
    initialWorkOrderId.length > 0 ? initialWorkOrderId : null,
  );
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  // M2-R1：工作令候选池（与四类清单页同一查询键，共享缓存；无工作令读权限/
  // 无数据静默回退纯手填，不阻断核查。候选只做提示，不改变命令载荷语义）。
  const workOrderOptionsQuery = useQuery({
    queryKey: ['workorder', 'orders', 'options'],
    queryFn: () => listWorkOrders().catch(() => []),
    staleTime: 60_000,
  });
  const selectedWorkOrderName =
    loadedId === null ? null : workOrderProjectName(workOrderOptionsQuery.data ?? [], loadedId);

  const latestQuery = useQuery({
    queryKey: ['listing', 'gap-check', loadedId],
    queryFn: () => getLatestGapCheck(loadedId as string),
    enabled: loadedId !== null,
  });

  const runMutation = useMutation({
    mutationFn: () => runGapCheck(workOrderId.trim()),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) {
        const committedWorkOrderId = workOrderId.trim();
        setLoadedId(committedWorkOrderId);
        setSearchParams({ wo: committedWorkOrderId }, { replace: true });
        queryClient.invalidateQueries({ queryKey: ['listing', 'gap-check'] });
      }
    },
    onError: (error) =>
      setOutcome({
        committed: false,
        status: 'error',
        reason: error instanceof Error ? error.message : String(error),
      }),
  });

  // M2-R1 换单清态：输入换到另一工作令时立即清掉上一单的核查快照与提示，
  // 不得把旧单结果误当新单的最新核查展示（输入精确回到已加载单则保留）。
  function handleWorkOrderChange(value: string) {
    setWorkOrderId(value);
    if (value.trim() !== loadedId) {
      setLoadedId(null);
      setOutcome(null);
    }
  }

  function handleLoad(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = workOrderId.trim();
    if (trimmed.length === 0) return;
    setLoadedId(trimmed);
    setSearchParams({ wo: trimmed }, { replace: true });
  }

  return (
    <div className="flex flex-col gap-6">
      {/* M2-R1：页面级工作令候选池（datalist 由工作令输入以 list 属性引用） */}
      <datalist id="gap-wo-options">
        {(workOrderOptionsQuery.data ?? []).map((row) => (
          <option key={String(row['id'])} value={String(row['id'])}>
            {String(row['projectName'] ?? '')}
          </option>
        ))}
      </datalist>
      <Card>
        <CardHeader>
          <CardTitle>缺口核查</CardTitle>
          <CardDescription>
            将工作令四类清单需求与库存可用量比对，每次核查生成一份不可变快照；缺口行在下方结果中列出。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form className="flex flex-col gap-4 sm:flex-row sm:items-end" onSubmit={handleLoad}>
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="gap-wo">工作令</Label>
              <Input
                id="gap-wo"
                value={workOrderId}
                list="gap-wo-options"
                onChange={(e) => handleWorkOrderChange(e.target.value)}
                placeholder="从候选选择，或粘贴工作令编号"
                required
              />
            </div>
            <Button type="submit" variant="outline">读最新快照</Button>
            <Button
              type="button"
              disabled={runMutation.isPending || workOrderId.trim().length === 0}
              onClick={() => runMutation.mutate()}
            >
              执行缺口核查
            </Button>
          </form>
          {/* M2-R1：已选工作令人话确认（项目名 + 短码；候选池查无此单只显短码，悬停看全号）。 */}
          {loadedId !== null && (
            <p className="text-sm text-muted-foreground">
              当前工作令：{selectedWorkOrderName === null ? '' : `${selectedWorkOrderName} · `}
              <span className="font-mono" title={loadedId}>{shortId(loadedId)}</span>
            </p>
          )}
          {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
          {runMutation.isError && (
            <p role="alert" className="text-sm text-destructive">
              核查失败：{runMutation.error instanceof Error ? runMutation.error.message : String(runMutation.error)}
            </p>
          )}
        </CardContent>
      </Card>

      {loadedId !== null && (
        <Card>
          <CardHeader>
            <CardTitle>最新核查结果</CardTitle>
            <CardDescription>该工作令最近一次核查的快照；重新核查会生成新的结果。</CardDescription>
          </CardHeader>
          <CardContent>
            <QueryState
              isPending={latestQuery.isPending}
              error={latestQuery.error}
              isEmpty={latestQuery.data === null}
              empty="该工作令尚未执行过缺口核查——点击上方「执行缺口核查」生成第一份结果。"
            >
              <GapCheckSnapshot snapshot={latestQuery.data ?? {}} />
            </QueryState>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** 核查快照（人话）：结论横幅 + 类目汇总 + 缺口明细 + 核查人/时刻。 */
function GapCheckSnapshot({ snapshot }: { readonly snapshot: Record<string, unknown> }) {
  const kinds = Array.isArray(snapshot['kinds']) ? (snapshot['kinds'] as readonly Record<string, unknown>[]) : [];
  const gapLines = Array.isArray(snapshot['gapLines'])
    ? (snapshot['gapLines'] as readonly Record<string, unknown>[])
    : [];
  const complete = snapshot['complete'] === true;
  const totalLines = kinds.reduce((sum, kind) => sum + Number(kind['lineCount'] ?? 0), 0);

  // 空清单优先判（Round-2 裁决）：旧口径历史快照可能存 complete=true，也不得盖过空清单警示。
  const banner = totalLines === 0
    ? {
        className: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
        text: '未通过：该工作令尚未录入清单行，无从核查齐套（空清单不判齐套）。请先在「四类清单」页录入清单行。',
      }
    : complete
    ? {
        className: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
        text: '核查通过：四类清单需求全部有库存可用量支撑，无缺口。',
      }
    : gapLines.length > 0
        ? {
            className: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
            text: `未通过：存在缺口 ${gapLines.length} 行（清单需求超出库存可用量），明细见下表。`,
          }
        : {
            className: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
            text: '未通过：存在未能参与核查的清单行（物料未完成校验），请先在清单行上确认物料。',
          };

  return (
    <div className="flex flex-col gap-4">
      <p className={`rounded border px-3 py-2 text-sm ${banner.className}`}>{banner.text}</p>
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">类目汇总</p>
        {kinds.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无类目数据</p>
        ) : (
          <ModuleTable
            columns={[
              { key: 'kind', label: '类目' },
              { key: 'lineCount', label: '行数' },
              { key: 'gapLineCount', label: '缺口行数' },
              { key: 'result', label: '结果' },
            ]}
            rows={kinds.map((kind) => ({
              ...kind,
              kind: listingKindLabel(kind['kind']),
              result:
                Number(kind['lineCount'] ?? 0) === 0
                  ? '无清单行（未参与核查）'
                  : kind['complete'] === true
                    ? '齐套'
                    : `缺口 ${Number(kind['gapLineCount'] ?? 0)} 行`,
            }))}
          />
        )}
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">缺口明细</p>
        {gapLines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {totalLines === 0 ? '该工作令尚无清单行，未产生核查明细。' : '无缺口行'}
          </p>
        ) : (
          <ModuleTable
            columns={[
              { key: 'kind', label: '类目' },
              { key: 'drawingNo', label: '图号', mono: true },
              { key: 'itemId', label: '物料', mono: true, format: 'shortId' },
              { key: 'requiredQty', label: '需求数量' },
              { key: 'availableQty', label: '库存可用量' },
              { key: 'gapQty', label: '缺口数量' },
              { key: 'neededBy', label: '需求日期' },
            ]}
            rows={gapLines.map((line) => ({ ...line, kind: listingKindLabel(line['kind']) }))}
          />
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        核查人 {textOf(snapshot['checkedBy'])} · 核查时刻 {formatLocalDateTime(snapshot['checkedAt'])}
      </p>
    </div>
  );
}
