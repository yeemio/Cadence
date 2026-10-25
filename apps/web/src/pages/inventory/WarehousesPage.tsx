/**
 * 仓库与库位页（S2 批次）：仓库列表 + 建仓库（库位集，第一个为默认库位）+
 * 行选中仓库详情（含库位）。覆盖矩阵 #14 仓库与库位。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { defineWarehouse, getWarehouseDetail, listWarehouses } from '../../data/inventoryApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState, RowDetail } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const LIST_COLUMNS = [
  { key: 'id', label: 'id', mono: true },
  { key: 'code', label: '编码', mono: true },
  { key: 'name', label: '名称' },
  { key: 'active', label: '启用' },
];

export function WarehousesPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const listQuery = useQuery({ queryKey: ['inventory', 'warehouses'], queryFn: listWarehouses });
  const detailQuery = useQuery({
    queryKey: ['inventory', 'warehouse', selectedId],
    queryFn: () => getWarehouseDetail(selectedId as string),
    enabled: selectedId !== null,
  });

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [locationCode, setLocationCode] = useState('');
  const [locationName, setLocationName] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      defineWarehouse({
        code: code.trim(),
        name: name.trim(),
        locations: [{ code: locationCode.trim(), ...(locationName.trim().length > 0 ? { name: locationName.trim() } : {}) }],
      }),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) {
        queryClient.invalidateQueries({ queryKey: ['inventory', 'warehouses'] });
        setCode('');
        setName('');
        setLocationCode('');
        setLocationName('');
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
    mutation.mutate();
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>仓库列表</CardTitle>
          <CardDescription>点行选中查看仓库详情（含库位，库位 code 升序）。</CardDescription>
        </CardHeader>
        <CardContent>
          <QueryState
            isPending={listQuery.isPending}
            error={listQuery.error}
            isEmpty={listQuery.data !== undefined && listQuery.data.length === 0}
            empty="暂无仓库（先在下方建仓）"
          >
            <ModuleTable
              columns={LIST_COLUMNS}
              rows={listQuery.data ?? []}
              selectedId={selectedId}
              onSelect={(row) => setSelectedId(String(row['id']))}
            />
          </QueryState>
        </CardContent>
      </Card>

      {selectedId !== null && (
        <Card>
          <CardHeader>
            <CardTitle>仓库详情（含库位）</CardTitle>
          </CardHeader>
          <CardContent>
            <QueryState isPending={detailQuery.isPending} error={detailQuery.error} isEmpty={false}>
              <RowDetail row={detailQuery.data ?? {}} />
            </QueryState>
          </CardContent>
        </Card>
      )}

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>建仓库</CardTitle>
          <CardDescription>库位集至少 1 个，第一个为默认库位（单库位起步，多库位扩展留后续）。</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="wh-code">仓库编码</Label>
              <Input id="wh-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="WH-01" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="wh-name">仓库名称</Label>
              <Input id="wh-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="主料仓" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="wh-loc-code">库位编码（默认库位）</Label>
              <Input id="wh-loc-code" value={locationCode} onChange={(e) => setLocationCode(e.target.value)} placeholder="LOC-01" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="wh-loc-name">库位名称（可选）</Label>
              <Input id="wh-loc-name" value={locationName} onChange={(e) => setLocationName(e.target.value)} />
            </div>
            {outcome !== null && <div className="sm:col-span-2"><CommandOutcomeHint outcome={outcome} /></div>}
            <div className="sm:col-span-2">
              <Button
                type="submit"
                disabled={
                  mutation.isPending ||
                  code.trim().length === 0 ||
                  name.trim().length === 0 ||
                  locationCode.trim().length === 0
                }
              >
                建仓库
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
