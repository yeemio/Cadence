/**
 * 供应商管理页（S3-a：0920 #9）：列表 + 创建 + 软停用/启用。
 * 供应商供外协派工与采购引用（外协厂家/供货商合一主数据，无 contact 字段）。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createSupplier, listSuppliers, updateSupplier } from '../../data/masterdataApi';
import { ApiErrorHint } from '../../components/ApiErrorHint';
import { ModuleTable, QueryState } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function SuppliersPage() {
  const queryClient = useQueryClient();
  const suppliersQuery = useQuery({ queryKey: ['masterdata', 'suppliers'], queryFn: listSuppliers });
  const invalidate = (): void => {
    queryClient.invalidateQueries({ queryKey: ['masterdata', 'suppliers'] });
  };

  const createMutation = useMutation({ mutationFn: createSupplier, onSuccess: invalidate });
  const statusMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => updateSupplier(id, { active }),
    onSuccess: invalidate,
  });

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rows = suppliersQuery.data ?? [];
  const selectedRow = rows.find((row) => String(row['id']) === selectedId) ?? null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.mutate(
      { code, name },
      {
        onSuccess: () => {
          setCode('');
          setName('');
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>供应商列表</CardTitle>
          <CardDescription>当前租户内的供应商主数据（外协厂家/供货商）；点击行后在下方停用/启用。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <QueryState
            isPending={suppliersQuery.isPending}
            error={suppliersQuery.isError ? suppliersQuery.error : null}
            isEmpty={suppliersQuery.data !== undefined && suppliersQuery.data.length === 0}
            empty="暂无供应商（下方创建第一条）"
          >
            <ModuleTable
              columns={[
                { key: 'code', label: 'code', mono: true },
                { key: 'name', label: '名称' },
                { key: 'active', label: '启用' },
              ]}
              rows={rows}
              rowIdKey="id"
              selectedId={selectedId}
              onSelect={(row) => setSelectedId(String(row['id']))}
            />
          </QueryState>
          {selectedRow !== null && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border p-4">
              <span className="font-mono text-sm">{String(selectedRow['code'])}</span>
              <span className="text-sm">{String(selectedRow['name'])}</span>
              <span className="text-xs text-muted-foreground">
                当前状态：{selectedRow['active'] === true ? '启用' : '停用'}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={statusMutation.isPending}
                onClick={() =>
                  statusMutation.mutate({
                    id: String(selectedRow['id']),
                    active: selectedRow['active'] !== true,
                  })
                }
              >
                {selectedRow['active'] === true ? '停用' : '启用'}
              </Button>
              {statusMutation.isError && <ApiErrorHint error={statusMutation.error} />}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>创建供应商</CardTitle>
          <CardDescription>code 租户内唯一（同物品 code 形状，冲突 409）。</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="supplier-code">code</Label>
              <Input id="supplier-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="SUP-01" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="supplier-name">名称</Label>
              <Input id="supplier-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="某某热处理厂" required />
            </div>
            {createMutation.isError && (
              <div className="sm:col-span-2">
                <ApiErrorHint error={createMutation.error} />
              </div>
            )}
            <div className="sm:col-span-2">
              <Button type="submit" disabled={createMutation.isPending || code.length === 0 || name.length === 0}>
                创建供应商
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
