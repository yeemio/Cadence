/**
 * 物品管理页（M1 增量 4-I）：列表 + 创建，数据走真实 masterdata API。
 * 本增量最小集：不做编辑/停用 UI（服务端 PUT 已备）、不做分页/搜索（非目标）。
 * fix-wave-6 6b-3（A14）：列显隐记忆接入——列定义收口为 ITEMS_COLUMNS，
 * 隐藏集跨会话/跨设备恢复（useColumnVisibility）。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { createItem, listItems } from '../../data/masterdataApi';
import type { ItemView } from '@smes/product-ui';
import { ApiErrorHint } from '../../components/ApiErrorHint';
import { ColumnVisibilityMenu } from '@/components/ColumnVisibilityMenu';
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
import { useColumnVisibility } from '@/hooks/useColumnVisibility';
import { cn } from '@/lib/utils';

interface ItemColumn {
  readonly key: 'code' | 'name' | 'spec' | 'unit' | 'category' | 'active';
  readonly label: string;
  /** 单元格渲染 class（mono 小字列与长文本列的呈现差异）。 */
  readonly cellClass: 'mono' | 'plain';
}

const ITEMS_COLUMNS = [
  { key: 'code', label: 'code', cellClass: 'mono' },
  { key: 'name', label: '名称', cellClass: 'plain' },
  { key: 'spec', label: '规格', cellClass: 'plain' },
  { key: 'unit', label: '单位', cellClass: 'plain' },
  { key: 'category', label: '分类', cellClass: 'mono' },
  { key: 'active', label: '启用', cellClass: 'plain' },
] as const satisfies readonly ItemColumn[];

/** 列显隐记忆键（A14 / RREQ-INT-032：pageKey=路由 path，tableKey=本页主表）。 */
const COLUMN_PREFS_PAGE = '/masterdata/items';
const COLUMN_PREFS_TABLE = 'main';

function itemCellText(item: ItemView, key: ItemColumn['key']): string {
  switch (key) {
    case 'active':
      return item.active ? '是' : '否';
    case 'code':
      return item.code;
    case 'name':
      return item.name;
    default:
      return item[key] ?? '—';
  }
}

export function ItemsPage() {
  const queryClient = useQueryClient();
  const itemsQuery = useQuery({ queryKey: ['masterdata', 'items'], queryFn: listItems });
  const createMutation = useMutation({
    mutationFn: createItem,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['masterdata', 'items'] }),
  });
  const { visibleColumns, isColumnHidden, toggleColumn } = useColumnVisibility({
    pageKey: COLUMN_PREFS_PAGE,
    tableKey: COLUMN_PREFS_TABLE,
    columns: ITEMS_COLUMNS,
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
                    {visibleColumns.map((column) => (
                      <th key={column.key} className="py-2 pr-4 font-medium">
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {itemsQuery.data.map((item) => (
                    <tr key={item.id} className="border-b last:border-b-0">
                      {visibleColumns.map((column) => (
                        <td
                          key={column.key}
                          className={cn(
                            'py-2 pr-4 whitespace-nowrap',
                            column.cellClass === 'mono' && 'font-mono text-xs',
                          )}
                        >
                          {itemCellText(item, column.key)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ColumnVisibilityMenu
            columns={ITEMS_COLUMNS}
            isColumnHidden={isColumnHidden}
            toggleColumn={toggleColumn}
          />
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
