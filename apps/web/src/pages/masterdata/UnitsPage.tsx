/**
 * 计量单位管理页（S3-a：0920 #100）：列表 + 创建。
 *
 * 软停用取舍（写明）：UnitMaster 无 active 字段——后端口径"字典无停用语义，
 * 改错 = 直接改名"（PUT name/symbol），故本页**不做软停用 UI**（无端点可调）。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createUnit, listUnits } from '../../data/masterdataApi';
import { ApiErrorHint } from '../../components/ApiErrorHint';
import { ModuleTable, QueryState } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function UnitsPage() {
  const queryClient = useQueryClient();
  const unitsQuery = useQuery({ queryKey: ['masterdata', 'units'], queryFn: listUnits });
  const createMutation = useMutation({
    mutationFn: createUnit,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['masterdata', 'units'] }),
  });

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.mutate(
      { code, name, symbol },
      {
        onSuccess: () => {
          setCode('');
          setName('');
          setSymbol('');
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>计量单位列表</CardTitle>
          <CardDescription>
            计量单位字典（供物品 unit 字段引用）；字典无停用语义——改错 = 直接改名（服务端 PUT）。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <QueryState
            isPending={unitsQuery.isPending}
            error={unitsQuery.isError ? unitsQuery.error : null}
            isEmpty={unitsQuery.data !== undefined && unitsQuery.data.length === 0}
            empty="暂无计量单位（下方创建第一条）"
          >
            <ModuleTable
              columns={[
                { key: 'code', label: 'code', mono: true },
                { key: 'name', label: '名称' },
                { key: 'symbol', label: '符号', mono: true },
              ]}
              rows={unitsQuery.data ?? []}
              rowIdKey="id"
            />
          </QueryState>
        </CardContent>
      </Card>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>创建计量单位</CardTitle>
          <CardDescription>
            code 租户内唯一；符号可留空（部分单位以名称即符号，如 PCS/KG）。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="unit-code">code</Label>
              <Input id="unit-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="PCS" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="unit-name">名称</Label>
              <Input id="unit-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="件" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="unit-symbol">符号（可选）</Label>
              <Input id="unit-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="PCS" />
            </div>
            {createMutation.isError && (
              <div className="sm:col-span-2">
                <ApiErrorHint error={createMutation.error} />
              </div>
            )}
            <div className="sm:col-span-2">
              <Button type="submit" disabled={createMutation.isPending || code.length === 0 || name.length === 0}>
                创建计量单位
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
