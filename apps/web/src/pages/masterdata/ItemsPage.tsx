/**
 * 物品管理页（M1 增量 4-I）：列表 + 创建，数据走真实 masterdata API。
 * 本增量最小集：不做编辑/停用 UI（服务端 PUT 已备）、不做分页/搜索（非目标）。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { createItem, listItems } from '../../data/masterdataApi';
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

export function ItemsPage() {
  const queryClient = useQueryClient();
  const itemsQuery = useQuery({ queryKey: ['masterdata', 'items'], queryFn: listItems });
  const createMutation = useMutation({
    mutationFn: createItem,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['masterdata', 'items'] }),
  });

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [spec, setSpec] = useState('');
  const [unit, setUnit] = useState('');
  const [category, setCategory] = useState('');

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.mutate(
      { code, name, spec, unit, category },
      {
        onSuccess: () => {
          setCode('');
          setName('');
          setSpec('');
          setUnit('');
          setCategory('');
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>物品列表</CardTitle>
          <CardDescription>当前租户内的物品主数据（真实 masterdata API 读回，全量不分页）。</CardDescription>
        </CardHeader>
        <CardContent>
          {itemsQuery.isPending && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" /> 正在加载…
            </p>
          )}
          {itemsQuery.isError && <ApiErrorHint error={itemsQuery.error} />}
          {itemsQuery.data !== undefined && (
            /* 窄屏横滚（M5 响应式取舍：列完整性优先，卡片化留后续重设计） */
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">code</th>
                  <th className="py-2 pr-4 font-medium">名称</th>
                  <th className="py-2 pr-4 font-medium">规格</th>
                  <th className="py-2 pr-4 font-medium">单位</th>
                  <th className="py-2 pr-4 font-medium">分类</th>
                  <th className="py-2 font-medium">启用</th>
                </tr>
              </thead>
              <tbody>
                {itemsQuery.data.map((item) => (
                  <tr key={item.id} className="border-b last:border-b-0">
                    <td className="py-2 pr-4 font-mono text-xs">{item.code}</td>
                    <td className="py-2 pr-4">{item.name}</td>
                    <td className="py-2 pr-4 text-xs">{item.spec ?? '—'}</td>
                    <td className="py-2 pr-4 text-xs">{item.unit ?? '—'}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{item.category ?? '—'}</td>
                    <td className="py-2">{item.active ? '是' : '否'}</td>
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>创建物品</CardTitle>
          <CardDescription>
            code 租户内唯一（字母/数字开头，可含点/下划线/连字符，冲突 409）；规格/单位/分类可留空。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="item-code">code</Label>
              <Input id="item-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="P-1001" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="item-name">名称</Label>
              <Input id="item-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="轴承" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="item-spec">规格（可选）</Label>
              <Input id="item-spec" value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="6204-2RS" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="item-unit">单位（可选）</Label>
              <Input id="item-unit" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="个" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="item-category">分类（可选）</Label>
              <Input id="item-category" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="part" />
            </div>
            {createMutation.isError && (
              <div className="sm:col-span-2">
                <ApiErrorHint error={createMutation.error} />
              </div>
            )}
            <div className="sm:col-span-2">
              <Button type="submit" disabled={createMutation.isPending || code.length === 0 || name.length === 0}>
                创建物品
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
