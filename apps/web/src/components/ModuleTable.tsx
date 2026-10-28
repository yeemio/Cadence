/**
 * 模块管理页共享视图件（S2 批次）：九循环模块 28 页共用的表格/行详情/命令结果
 * 展示。取舍——列渲染按"配置键直读行字段"（行形状来自后端投影实态，键不匹配
 * 渲染 '—' 不抛错）；详情面板按全字段键值对渲染（零猜测：后端返回什么展示什么，
 * 嵌套对象/数组以紧凑 JSON 呈现）。
 * P2 横切批（UX-PLAN-07/08、UX-PUR-04、UX-WH-10）：TableColumn 增加可选
 * format（datetime/shortId 列级显示转换，src/lib/format 出口）——行数据原样
 * 保留（行选中/复制/乐观锁取值不受影响），应用格式的单元格 title 悬停展示全文。
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatCell, type CellFormat } from '@/lib/format';
import type { CommandOutcomeView } from '../data/commandClient';

/** 表格列配置（key = 行字段名，与后端投影行键一致）。 */
export interface TableColumn {
  readonly key: string;
  readonly label: string;
  readonly mono?: boolean;
  /** 列级显示格式（时刻本地化/长 id 截断）；行数据不动，title 悬停全文。 */
  readonly format?: CellFormat;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 响应式表格（窄屏横滚，体例同 ItemsPage M5 取舍：列完整性优先）。 */
export function ModuleTable({
  columns,
  rows,
  rowIdKey = 'id',
  selectedId,
  onSelect,
  empty = '暂无数据',
}: {
  readonly columns: readonly TableColumn[];
  readonly rows: readonly Record<string, unknown>[];
  readonly rowIdKey?: string;
  readonly selectedId?: string | null;
  readonly onSelect?: (row: Record<string, unknown>) => void;
  readonly empty?: string;
}) {
  if (rows.length === 0) {
    return <p className="py-4 text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            {columns.map((column) => (
              <th key={column.key} className="py-2 pr-4 font-medium whitespace-nowrap">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const id = cellText(row[rowIdKey]);
            const selected = selectedId !== undefined && selectedId !== null && id === selectedId;
            return (
              <tr
                key={id === '—' ? index : id}
                className={cn(
                  'border-b last:border-b-0',
                  onSelect !== undefined && 'cursor-pointer hover:bg-muted/60',
                  selected && 'bg-muted',
                )}
                onClick={onSelect !== undefined ? () => onSelect(row) : undefined}
              >
                {columns.map((column) => {
                  const raw = row[column.key];
                  const display =
                    column.format !== undefined ? formatCell(raw, column.format) : cellText(raw);
                  return (
                    <td
                      key={column.key}
                      className={cn('py-2 pr-4 whitespace-nowrap', column.mono && 'font-mono text-xs')}
                      title={column.format !== undefined ? cellText(raw) : undefined}
                    >
                      {display}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 行详情面板：全字段键值对（嵌套值紧凑 JSON；键序 = 后端字段序）。 */
export function RowDetail({ row, title }: { readonly row: Record<string, unknown>; readonly title?: string }) {
  return (
    <div className="flex flex-col gap-2">
      {title !== undefined && <p className="text-sm font-medium">{title}</p>}
      <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[minmax(9rem,auto)_1fr]">
        {Object.entries(row).map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="font-mono text-xs text-muted-foreground">{key}</dt>
            <dd className="break-all font-mono text-xs">{cellText(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** 查询三态（加载中/失败/空）。 */
export function QueryState({
  isPending,
  error,
  isEmpty,
  empty,
  children,
}: {
  readonly isPending: boolean;
  readonly error: unknown;
  readonly isEmpty: boolean;
  readonly empty?: string;
  readonly children: ReactNode;
}) {
  // i18n 波 2：加载/空态默认/错误前缀走 common（zh 值与原字面量逐字符一致，
  // e2e/断言锚点不变；en 骨架出英文）。
  const { t } = useTranslation();
  const emptyText = empty ?? t('common:query.empty-default');
  if (isPending) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" /> {t('common:query.loading')}
      </p>
    );
  }
  if (error !== null && error !== undefined) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('common:query.request-failed', {
          message: error instanceof Error ? error.message : String(error),
        })}
      </p>
    );
  }
  if (isEmpty) {
    return <p className="py-2 text-sm text-muted-foreground">{emptyText}</p>;
  }
  return <>{children}</>;
}

/**
 * 命令结果提示（生效绿/未生效红；业务拒绝带服务端 reason 原文——UX-PLAN-05：可见文案不带 committed/status 实现词）。
 * successDetail（UX-WH-02）：committed 后追加的业务单号回显（如"流水号 mv-…"），
 * 以弱色跟在固定文案之后——基线文案「操作已生效。」保持原样（e2e 断言锚点）。
 */
export function CommandOutcomeHint({
  outcome,
  successDetail,
}: {
  readonly outcome: CommandOutcomeView;
  readonly successDetail?: string | undefined;
}) {
  // i18n 波 2：四态文案走 common:outcome（zh 值与原字面量逐字符一致——
  // 「操作已生效。」等 e2e 断言锚点不变；en 骨架出英文）。
  const { t } = useTranslation();
  if (outcome.committed) {
    return (
      <p className="text-sm text-emerald-600 dark:text-emerald-400">
        {t('common:outcome.committed')}
        {successDetail !== undefined && successDetail.length > 0 ? (
          <span className="text-muted-foreground">{successDetail}</span>
        ) : null}
      </p>
    );
  }
  const lead =
    outcome.status === 'indeterminate'
      ? t('common:outcome.indeterminate')
      : outcome.status === 'error'
        ? t('common:outcome.error')
        : t('common:outcome.rejected');
  return (
    <p role="alert" className="text-sm text-destructive">
      {lead}
      {outcome.reason !== null ? `：${outcome.reason}` : ''}
    </p>
  );
}
