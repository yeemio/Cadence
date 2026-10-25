/**
 * 岗位管理页（S3-a：0920 #7）：列表 + 创建 + 软停用/启用。
 *
 * 归属机构呈现：departmentRef 是机构 id——页面并读 GET /org/departments 解引用
 * 显示 code/name；调用方无 department:read 时该子查询 403，表格回退显示原始 id、
 * 创建表单回退为手填机构 id（权限耦合如实降级，不静默隐藏字段）。
 */
import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createPosition,
  listDepartments,
  listPositions,
  updatePosition,
} from '../../data/orgApi';
import { ApiErrorHint } from './OrgUsersPage';
import { ModuleTable, QueryState } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

export function PositionsPage() {
  const queryClient = useQueryClient();
  const positionsQuery = useQuery({ queryKey: ['org', 'positions'], queryFn: listPositions });
  const departmentsQuery = useQuery({
    queryKey: ['org', 'departments'],
    queryFn: listDepartments,
    retry: false,
  });
  const departmentsUsable = departmentsQuery.data !== undefined;
  const invalidate = (): void => {
    queryClient.invalidateQueries({ queryKey: ['org', 'positions'] });
  };

  const createMutation = useMutation({ mutationFn: createPosition, onSuccess: invalidate });
  const statusMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => updatePosition(id, { active }),
    onSuccess: invalidate,
  });

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [departmentRef, setDepartmentRef] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rows = useMemo(() => {
    const list = positionsQuery.data ?? [];
    const byId = new Map(
      (departmentsQuery.data ?? []).map((row) => [String(row['id']), row]),
    );
    return list.map((row): Record<string, unknown> => {
      const department =
        row['departmentRef'] === null || row['departmentRef'] === undefined
          ? null
          : byId.get(String(row['departmentRef']));
      return {
        ...row,
        departmentLabel:
          department === undefined || department === null
            ? row['departmentRef'] === null || row['departmentRef'] === undefined
              ? '—'
              : String(row['departmentRef'])
            : `${String(department['code'])}（${String(department['name'])}）`,
      };
    });
  }, [positionsQuery.data, departmentsQuery.data]);
  const selectedRow = rows.find((row) => String(row['id']) === selectedId) ?? null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.mutate(
      { code, name, ...(departmentRef === '' ? {} : { departmentRef }) },
      {
        onSuccess: () => {
          setCode('');
          setName('');
          setDepartmentRef('');
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>岗位列表</CardTitle>
          <CardDescription>
            岗位供人员分类与工时统计引用；归属机构可空（不挂机构）。点击行后在下方停用/启用。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <QueryState
            isPending={positionsQuery.isPending}
            error={positionsQuery.isError ? positionsQuery.error : null}
            isEmpty={positionsQuery.data !== undefined && positionsQuery.data.length === 0}
            empty="暂无岗位（下方创建第一条）"
          >
            <ModuleTable
              columns={[
                { key: 'code', label: 'code', mono: true },
                { key: 'name', label: '名称' },
                { key: 'departmentLabel', label: '归属机构' },
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
          <CardTitle>创建岗位</CardTitle>
          <CardDescription>
            code 租户内唯一（同机构 code 形状，冲突 409）；归属机构可留空 = 不挂机构。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="pos-code">code</Label>
              <Input id="pos-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="POS-01" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="pos-name">名称</Label>
              <Input id="pos-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="数控操作工" required />
            </div>
            <div className="flex flex-col gap-2 sm:col-span-2">
              {departmentsUsable ? (
                <>
                  <Label htmlFor="pos-dept">归属机构（可选 = 不挂机构）</Label>
                  <Select id="pos-dept" value={departmentRef} onChange={(e) => setDepartmentRef(e.target.value)}>
                    <option value="">（不挂机构）</option>
                    {(departmentsQuery.data ?? []).map((row) => (
                      <option key={String(row['id'])} value={String(row['id'])}>
                        {String(row['code'])}（{String(row['name'])}）
                      </option>
                    ))}
                  </Select>
                </>
              ) : (
                <>
                  <Label htmlFor="pos-dept-id">归属机构 id（可选；机构清单不可读，手填）</Label>
                  <Input
                    id="pos-dept-id"
                    value={departmentRef}
                    onChange={(e) => setDepartmentRef(e.target.value)}
                    placeholder="depa-…"
                    className="font-mono text-xs"
                  />
                </>
              )}
            </div>
            {createMutation.isError && (
              <div className="sm:col-span-2">
                <ApiErrorHint error={createMutation.error} />
              </div>
            )}
            <div className="sm:col-span-2">
              <Button type="submit" disabled={createMutation.isPending || code.length === 0 || name.length === 0}>
                创建岗位
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
