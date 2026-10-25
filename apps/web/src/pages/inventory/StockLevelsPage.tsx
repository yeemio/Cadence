/**
 * 实时库存页（S2 批次）：库存水平（可用量口径：availableQty=qtyOnHand−qtyReserved，
 * 仓库/物料过滤）+ 库位分布 + 出入库流水。覆盖矩阵 #81 实时库存。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchLocationBalances, fetchMovements, fetchStockLevels } from '../../data/inventoryApi';
import { ModuleTable, QueryState } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function StockLevelsPage() {
  const [warehouseId, setWarehouseId] = useState('');
  const [itemId, setItemId] = useState('');
  const [applied, setApplied] = useState<{ warehouseId: string; itemId: string }>({ warehouseId: '', itemId: '' });

  const filters = {
    ...(applied.warehouseId.trim().length > 0 ? { warehouseId: applied.warehouseId.trim() } : {}),
    ...(applied.itemId.trim().length > 0 ? { itemId: applied.itemId.trim() } : {}),
  };

  const levelsQuery = useQuery({
    queryKey: ['inventory', 'stock', filters],
    queryFn: () => fetchStockLevels(filters.itemId),
  });
  const balancesQuery = useQuery({
    queryKey: ['inventory', 'locations', filters],
    queryFn: () => fetchLocationBalances(filters),
  });
  const movementsQuery = useQuery({
    queryKey: ['inventory', 'movements', filters],
    queryFn: () => fetchMovements(filters),
  });

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>实时库存</CardTitle>
          <CardDescription>
            可用量口径（availableQty = 在手 − 预占，机器计算非存储列）；移动端库存查询逻辑面同径。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="stock-wh-filter">仓库过滤（可选）</Label>
              <Input id="stock-wh-filter" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} />
            </div>
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="stock-item-filter">物料过滤（可选）</Label>
              <Input id="stock-item-filter" value={itemId} onChange={(e) => setItemId(e.target.value)} />
            </div>
            <Button variant="outline" onClick={() => setApplied({ warehouseId, itemId })}>应用过滤</Button>
          </div>
          <QueryState
            isPending={levelsQuery.isPending}
            error={levelsQuery.error}
            isEmpty={levelsQuery.data !== undefined && levelsQuery.data.length === 0}
            empty="当前过滤条件下无库存行"
          >
            <ModuleTable
              columns={[
                { key: 'itemId', label: '物料', mono: true },
                { key: 'warehouseId', label: '仓库', mono: true },
                { key: 'qtyOnHand', label: '在手' },
                { key: 'qtyReserved', label: '预占' },
                { key: 'availableQty', label: '可用' },
              ]}
              rows={(levelsQuery.data ?? []).map((level) => ({ ...level }))}
            />
          </QueryState>
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>库位分布</CardTitle>
          </CardHeader>
          <CardContent>
            <QueryState
              isPending={balancesQuery.isPending}
              error={balancesQuery.error}
              isEmpty={balancesQuery.data !== undefined && balancesQuery.data.length === 0}
              empty="无库位余额行"
            >
              <ModuleTable
                columns={[
                  { key: 'itemId', label: '物料', mono: true },
                  { key: 'warehouseId', label: '仓库', mono: true },
                  { key: 'locationId', label: '库位', mono: true },
                  { key: 'quantity', label: '数量' },
                ]}
                rows={balancesQuery.data ?? []}
              />
            </QueryState>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>出入库流水</CardTitle>
          </CardHeader>
          <CardContent>
            <QueryState
              isPending={movementsQuery.isPending}
              error={movementsQuery.error}
              isEmpty={movementsQuery.data !== undefined && movementsQuery.data.length === 0}
              empty="无流水记录"
            >
              <ModuleTable
                columns={[
                  { key: 'id', label: 'id', mono: true },
                  { key: 'kind', label: '类型', mono: true },
                  { key: 'itemId', label: '物料', mono: true },
                  { key: 'quantity', label: '数量' },
                  { key: 'createdAt', label: '时刻' },
                ]}
                rows={movementsQuery.data ?? []}
              />
            </QueryState>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
