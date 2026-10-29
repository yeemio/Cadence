/**
 * 实时库存页（S2 批次）：库存水平（可用量口径：availableQty=qtyOnHand−qtyReserved，
 * 仓库/物料过滤）+ 库位分布 + 出入库流水。覆盖矩阵 #81 实时库存。
 *
 * W7 UX 缺陷批：键位对齐后端投影实态（UX-WH-03/04）——流水时刻键为 occurredAt
 * （StockMovement 无 createdAt；附 datetime 本地化），库位分布数量键为 qty
 * （StockLocationBalance 无 quantity）；流水类型枚举中文化（后端
 * movementKindLabel 同口径映射）。
 *
 * W10b Round-2 缺陷批（UX-WH-R2-01）：流水短码补复制全文途径——流水表 id 单元格
 * 增设复制按钮取原始完整单号（短码显示与 title 悬停保持不变；其余卡照旧走共享
 * 表格，短码 title 悬停全文已有）。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
// i18n 波 2：inventory namespace 绑定（zh-CN 权威源=原页面文案；业务数据与
// 服务端 message 不翻译；namespace 注册与 shell init 由总控统一接线）。
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { fetchLocationBalances, fetchMovements, fetchReservations, fetchStockLevels } from '../../data/inventoryApi';
import { ModuleTable, QueryState } from '../../components/ModuleTable';
// P2 横切批：长 id 截断显示（UX-WH-10；行数据不动，title 悬停全文）。
import { formatLocalDateTime, shortId } from '../../lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** 流水类型 label key 映射（与后端 inventory-config movementKindLabel 同口径；未知 id 原样）。 */
const MOVEMENT_KIND_LABEL_KEYS: Readonly<Record<string, string>> = {
  'purchase-in': 'movement-kind.purchase-in',
  'inspection-in': 'movement-kind.inspection-in',
  'production-in': 'movement-kind.production-in',
  'issue-out': 'movement-kind.issue-out',
  'shipping-out': 'movement-kind.shipping-out',
  'transfer-out': 'movement-kind.transfer-out',
  'transfer-in': 'movement-kind.transfer-in',
  'stocktake-gain': 'movement-kind.stocktake-gain',
  'stocktake-loss': 'movement-kind.stocktake-loss',
};

function movementKindLabel(kind: string, t: TFunction): string {
  const key = MOVEMENT_KIND_LABEL_KEYS[kind];
  return key === undefined ? kind : t(key);
}

export function StockLevelsPage() {
  const { t } = useTranslation('inventory');
  const [warehouseId, setWarehouseId] = useState('');
  const [itemId, setItemId] = useState('');
  const [applied, setApplied] = useState<{ warehouseId: string; itemId: string }>({ warehouseId: '', itemId: '' });

  const filters = {
    ...(applied.warehouseId.trim().length > 0 ? { warehouseId: applied.warehouseId.trim() } : {}),
    ...(applied.itemId.trim().length > 0 ? { itemId: applied.itemId.trim() } : {}),
  };
  const movementDisplayRows = (rows: readonly Record<string, unknown>[]) =>
    rows.map((row) => ({
      ...row,
      kind:
        typeof row['kind'] === 'string'
          ? movementKindLabel(row['kind'] as string, t)
          : row['kind'],
    }));

  const levelsQuery = useQuery({
    queryKey: ['inventory', 'stock', filters],
    queryFn: () => fetchStockLevels(filters.itemId, filters.warehouseId),
  });
  const balancesQuery = useQuery({
    queryKey: ['inventory', 'locations', filters],
    queryFn: () => fetchLocationBalances(filters),
  });
  const movementsQuery = useQuery({
    queryKey: ['inventory', 'movements', filters],
    queryFn: () => fetchMovements(filters),
  });

  const reservationsQuery = useQuery({ queryKey: ['inventory', 'reservations', filters], queryFn: () => fetchReservations(filters) });

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('levels.title')}</CardTitle>
          <CardDescription>物理总量分为待检、合格、隔离、未知；可用量 = 合格 − 有效合格占用。历史无证余额不默认合格。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="stock-wh-filter">{t('levels.filter.warehouse-label')}</Label>
              <Input id="stock-wh-filter" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} />
            </div>
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="stock-item-filter">{t('levels.filter.item-label')}</Label>
              <Input id="stock-item-filter" value={itemId} onChange={(e) => setItemId(e.target.value)} />
            </div>
            <Button variant="outline" onClick={() => setApplied({ warehouseId, itemId })}>{t('levels.filter.apply')}</Button>
          </div>
          <QueryState
            isPending={levelsQuery.isPending}
            error={levelsQuery.error}
            isEmpty={levelsQuery.data !== undefined && levelsQuery.data.length === 0}
            empty={t('levels.empty')}
          >
            <ModuleTable
              columns={[
                { key: 'itemId', label: t('levels.columns.item'), mono: true, format: 'shortId' },
                { key: 'warehouseId', label: t('levels.columns.warehouse'), mono: true, format: 'shortId' },
                { key: 'qtyOnHand', label: t('levels.columns.on-hand') },
                { key: 'pendingQty', label: '待检' },
                { key: 'qualifiedQty', label: '合格' },
                { key: 'quarantineQty', label: '隔离' },
                { key: 'unknownQty', label: '未知（无质量证据）' },
                { key: 'effectiveReservedQty', label: '有效合格占用' },
                { key: 'unbackedReservedQty', label: '缺合格批次依据的历史占用' },
                { key: 'qtyReserved', label: '原账预占（含历史）' },
                { key: 'availableQty', label: t('levels.columns.available') },
              ]}
              rows={(levelsQuery.data ?? []).map((level) => ({ ...level }))}
            />
          </QueryState>
        </CardContent>
      </Card>

      <Card><CardHeader><CardTitle>库存预占追溯</CardTitle><CardDescription>建立预占不改变现存量；核销时现存量与预占同减；释放未用预占不增加实物库存。此处只读，不是新增解除或退料单据。</CardDescription></CardHeader><CardContent>
        <QueryState isPending={reservationsQuery.isPending} error={reservationsQuery.error} isEmpty={reservationsQuery.data?.length === 0} empty="没有匹配的预占记录。">
          <ModuleTable columns={[{ key: 'reservationKey', label: '预占键', mono: true }, { key: 'itemId', label: '物料', format: 'shortId' }, { key: 'warehouseId', label: '仓库', format: 'shortId' }, { key: 'quantity', label: '原预占量' }, { key: 'remaining', label: '未核销量' }, { key: 'statusLabel', label: '状态' }, { key: 'refType', label: '来源类型' }, { key: 'refId', label: '来源单据', format: 'shortId' }]} rows={(reservationsQuery.data ?? []).map((r) => ({ ...r, statusLabel: ({ active: '占用中', consumed: '已核销', released: '已释放' } as Record<string, string>)[String(r['status'])] ?? r['status'] }))} />
        </QueryState>
      </CardContent></Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('balances.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <QueryState
              isPending={balancesQuery.isPending}
              error={balancesQuery.error}
              isEmpty={balancesQuery.data !== undefined && balancesQuery.data.length === 0}
              empty={t('balances.empty')}
            >
              <ModuleTable
                columns={[
                  { key: 'itemId', label: t('balances.columns.item'), mono: true, format: 'shortId' },
                  { key: 'warehouseId', label: t('balances.columns.warehouse'), mono: true, format: 'shortId' },
                  { key: 'locationId', label: t('balances.columns.location'), mono: true, format: 'shortId' },
                  { key: 'qty', label: t('balances.columns.quantity') },
                ]}
                rows={balancesQuery.data ?? []}
              />
            </QueryState>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('movements.title')}</CardTitle>
            <CardDescription>{t('movements.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <QueryState
              isPending={movementsQuery.isPending}
              error={movementsQuery.error}
              isEmpty={movementsQuery.data !== undefined && movementsQuery.data.length === 0}
              empty={t('movements.empty')}
            >
              <MovementsTable rows={movementDisplayRows(movementsQuery.data ?? [])} />
            </QueryState>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * 流水表（UX-WH-R2-01）：列与共享表格同构（短码显示 + title 悬停全文 +
 * 类型中文 + 时刻本地化），流水号单元格增设复制按钮——取行原始完整单号入
 * 剪贴板，复制后短暂回显「已复制」。页内本地表格，不影响其他卡与其他页。
 */
function MovementsTable({ rows }: { readonly rows: readonly Record<string, unknown>[] }) {
  const { t } = useTranslation('inventory');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyId = (id: string): void => {
    void navigator.clipboard
      ?.writeText(id)
      .then(() => {
        setCopiedId(id);
        window.setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1500);
      })
      .catch(() => {
        // 剪贴板不可用（非安全上下文等）：静默失败，title 悬停全文仍可读。
      });
  };

  if (rows.length === 0) return null;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-2 pr-4 font-medium whitespace-nowrap">{t('movements.columns.id')}</th>
            <th className="py-2 pr-4 font-medium whitespace-nowrap">{t('movements.columns.kind')}</th>
            <th className="py-2 pr-4 font-medium whitespace-nowrap">{t('movements.columns.item')}</th>
            <th className="py-2 pr-4 font-medium whitespace-nowrap">{t('movements.columns.quantity')}</th>
            <th className="py-2 pr-4 font-medium whitespace-nowrap">{t('movements.columns.occurred-at')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const id = typeof row['id'] === 'string' ? row['id'] : '';
            const itemId = row['itemId'];
            return (
              <tr key={id.length > 0 ? id : index} className="border-b last:border-b-0">
                <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap">
                  <span title={id.length > 0 ? id : undefined}>{shortId(id.length > 0 ? id : null)}</span>
                  {id.length > 0 && (
                    <button
                      type="button"
                      className="ml-1.5 inline-flex items-center gap-0.5 rounded px-1 py-0.5 font-sans text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-label={t('movements.copy-aria', { id: shortId(id) })}
                      onClick={() => copyId(id)}
                    >
                      {copiedId === id ? <Check className="size-3" /> : <Copy className="size-3" />}
                      {copiedId === id ? t('movements.copied') : t('movements.copy')}
                    </button>
                  )}
                </td>
                <td className="py-2 pr-4 whitespace-nowrap">{String(row['kind'] ?? '—')}</td>
                <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap" title={itemId === null || itemId === undefined ? undefined : String(itemId)}>
                  {shortId(itemId)}
                </td>
                <td className="py-2 pr-4 whitespace-nowrap">{String(row['quantity'] ?? '—')}</td>
                <td className="py-2 pr-4 whitespace-nowrap" title={row['occurredAt'] === null || row['occurredAt'] === undefined ? undefined : String(row['occurredAt'])}>
                  {formatLocalDateTime(row['occurredAt'])}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
