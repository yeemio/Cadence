/**
 * 客户管理页（S3-a：0920 #8）：列表 + 创建 + 软停用/启用（PUT 期望态 active）。
 * 客户供工作令创建时选用；contact 为自由文本（电话/邮箱/地址合一，实施口径）。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createCustomer, listCustomers, updateCustomer } from '../../data/masterdataApi';
import { ApiErrorHint } from '../../components/ApiErrorHint';
import { ModuleTable, QueryState } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function CustomersPage() {
  const queryClient = useQueryClient();
  const customersQuery = useQuery({ queryKey: ['masterdata', 'customers'], queryFn: listCustomers });
  const invalidate = (): void => {
    queryClient.invalidateQueries({ queryKey: ['masterdata', 'customers'] });
  };

  const createMutation = useMutation({ mutationFn: createCustomer, onSuccess: invalidate });
  const statusMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => updateCustomer(id, { active }),
    onSuccess: invalidate,
  });

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rows = customersQuery.data ?? [];
  const selectedRow = rows.find((row) => String(row['id']) === selectedId) ?? null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.mutate(
      { code, name, contact },
      {
        onSuccess: () => {
          setCode('');
          setName('');
          setContact('');
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>客户列表</CardTitle>
          <CardDescription>当前租户内的客户主数据（全量不分页）；点击行后在下方停用/启用。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <QueryState
            isPending={customersQuery.isPending}
            error={customersQuery.isError ? customersQuery.error : null}
            isEmpty={customersQuery.data !== undefined && customersQuery.data.length === 0}
            empty="暂无客户（下方创建第一条）"
          >
            <ModuleTable
              columns={[
                { key: 'code', label: 'code', mono: true },
                { key: 'name', label: '名称' },
                { key: 'contact', label: '联系方式' },
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

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>创建客户</CardTitle>
          <CardDescription>
            code 租户内唯一（字母/数字开头，可含点/下划线/连字符，冲突 409）；联系方式可留空（≤256 字）。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="customer-code">code</Label>
              <Input id="customer-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="CUS-01" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="customer-name">名称</Label>
              <Input id="customer-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="某某重工" required />
            </div>
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="customer-contact">联系方式（可选）</Label>
              <Input id="customer-contact" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="0571-8888888 / addr@example.com" />
            </div>
            {createMutation.isError && (
              <div className="sm:col-span-2">
                <ApiErrorHint error={createMutation.error} />
              </div>
            )}
            <div className="sm:col-span-2">
              <Button type="submit" disabled={createMutation.isPending || code.length === 0 || name.length === 0}>
                创建客户
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
