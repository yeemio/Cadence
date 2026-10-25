/**
 * 资源管理页（M1 增量 4-I）：列表 + 创建，数据走真实 masterdata API。
 * 与物品页同构；类型（type）自由文本——行业词只进数据不进代码（ADR-0010）。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { createResource, listResources } from '../../data/masterdataApi';
import { ApiErrorHint } from '../../components/ApiErrorHint';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function ResourcesPage() {
  const queryClient = useQueryClient();
  const resourcesQuery = useQuery({ queryKey: ['masterdata', 'resources'], queryFn: listResources });
  const createMutation = useMutation({
    mutationFn: createResource,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['masterdata', 'resources'] }),
  });

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState('');

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.mutate(
      { code, name, type },
      {
        onSuccess: () => {
          setCode('');
          setName('');
          setType('');
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>资源列表</CardTitle>
          <CardDescription>当前租户内的资源主数据（设备/工位/人员组……类型自由描述）。</CardDescription>
        </CardHeader>
        <CardContent>
          {resourcesQuery.isPending && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" /> 正在加载…
            </p>
          )}
          {resourcesQuery.isError && <ApiErrorHint error={resourcesQuery.error} />}
          {resourcesQuery.data !== undefined && (
            /* 窄屏横滚（M5 响应式取舍：列完整性优先，卡片化留后续重设计） */
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">code</th>
                  <th className="py-2 pr-4 font-medium">名称</th>
                  <th className="py-2 pr-4 font-medium">类型</th>
                  <th className="py-2 font-medium">启用</th>
                </tr>
              </thead>
              <tbody>
                {resourcesQuery.data.map((resource) => (
                  <tr key={resource.id} className="border-b last:border-b-0">
                    <td className="py-2 pr-4 font-mono text-xs">{resource.code}</td>
                    <td className="py-2 pr-4">{resource.name}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{resource.type ?? '—'}</td>
                    <td className="py-2">{resource.active ? '是' : '否'}</td>
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>创建资源</CardTitle>
          <CardDescription>code 租户内唯一（冲突 409）；类型可留空。</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="resource-code">code</Label>
              <Input id="resource-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="M-01" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="resource-name">名称</Label>
              <Input id="resource-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="一号产线" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="resource-type">类型（可选）</Label>
              <Input id="resource-type" value={type} onChange={(e) => setType(e.target.value)} placeholder="machine" />
            </div>
            {createMutation.isError && <ApiErrorHint error={createMutation.error} />}
            <Button type="submit" disabled={createMutation.isPending || code.length === 0 || name.length === 0}>
              创建资源
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
