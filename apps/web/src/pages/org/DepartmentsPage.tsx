/**
 * 机构管理页（S3-a：0920 #3）：平铺表 + 创建 + 软停用/启用。
 *
 * 呈现取舍（写明）：后端 GET /org/departments 是平铺全量（无树参数），层级
 * 仅 parentId 自引用——页面按"平铺表 + 父机构列（code/name 解引用显示）"
 * 呈现，**不做前端组树**（层级守卫/环校验在服务端用例层，前端组树对演示
 * 无增量证据价值；树形呈现留后续波）。
 */
import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createDepartment, listDepartments, updateDepartment } from '../../data/orgApi';
import { ApiErrorHint } from './OrgUsersPage';
import { ModuleTable, QueryState } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

export function DepartmentsPage() {
  const queryClient = useQueryClient();
  const departmentsQuery = useQuery({ queryKey: ['org', 'departments'], queryFn: listDepartments });
  const invalidate = (): void => {
    queryClient.invalidateQueries({ queryKey: ['org', 'departments'] });
  };

  const createMutation = useMutation({ mutationFn: createDepartment, onSuccess: invalidate });
  const statusMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      updateDepartment(id, { active }),
    onSuccess: invalidate,
  });

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rows = useMemo(() => {
    const list = departmentsQuery.data ?? [];
    const byId = new Map(list.map((row) => [String(row['id']), row]));
    return list.map((row): Record<string, unknown> => {
      const parent = row['parentId'] === null || row['parentId'] === undefined ? null : byId.get(String(row['parentId']));
      return {
        ...row,
        parentLabel:
          parent === null || parent === undefined
            ? '—'
            : `${String(parent['code'])}（${String(parent['name'])}）`,
      };
    });
  }, [departmentsQuery.data]);
  const selectedRow = rows.find((row) => String(row['id']) === selectedId) ?? null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.mutate(
      { code, name, ...(parentId === '' ? {} : { parentId }) },
      {
        onSuccess: () => {
          setCode('');
          setName('');
          setParentId('');
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>机构列表</CardTitle>
          <CardDescription>
            平铺全量（层级以父机构列呈现，前端不组树）；点击行后在下方停用/启用（软停用 = 期望态 active）。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <QueryState
            isPending={departmentsQuery.isPending}
            error={departmentsQuery.isError ? departmentsQuery.error : null}
            isEmpty={departmentsQuery.data !== undefined && departmentsQuery.data.length === 0}
            empty="暂无机构（下方创建第一条）"
          >
            <ModuleTable
              columns={[
                { key: 'code', label: 'code', mono: true },
                { key: 'name', label: '名称' },
                { key: 'parentLabel', label: '父机构' },
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
          <CardTitle>创建机构</CardTitle>
          <CardDescription>
            code 租户内唯一（字母/数字开头，可含点/下划线/连字符，冲突 409）；父机构可留空 = 顶层，换挂环校验在服务端。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="dept-code">code</Label>
              <Input id="dept-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ORG-01" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="dept-name">名称</Label>
              <Input id="dept-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="机加工车间" required />
            </div>
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="dept-parent">父机构（可选 = 顶层）</Label>
              <Select id="dept-parent" value={parentId} onChange={(e) => setParentId(e.target.value)}>
                <option value="">（顶层）</option>
                {(departmentsQuery.data ?? []).map((row) => (
                  <option key={String(row['id'])} value={String(row['id'])}>
                    {String(row['code'])}（{String(row['name'])}）
                  </option>
                ))}
              </Select>
            </div>
            {createMutation.isError && (
              <div className="sm:col-span-2">
                <ApiErrorHint error={createMutation.error} />
              </div>
            )}
            <div className="sm:col-span-2">
              <Button type="submit" disabled={createMutation.isPending || code.length === 0 || name.length === 0}>
                创建机构
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
