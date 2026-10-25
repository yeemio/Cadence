/**
 * 菜单管理页（T1 能力子集：0920 #98 web 端菜单管理 + #99 移动端菜单管理）。
 *
 * 一个页面管两类配置集：code=default（web 侧栏）与 code=mobile（移动标签+
 * 子页）——两端读取面在 ShellLayout/MobileLayout 启动合并（mergeMenuConfig：
 * 配置叠呈现——可见性/顺序/title；路由与权限以装配态为准，页面头注见
 * product-ui menu-merge.ts）。编辑面 = JSON 节点树文本域（结构权威在后端
 * 输入解析层：code 树内唯一/深度/总量校验，保存前本地 JSON.parse 门禁）+
 * "从装配态预填"（当前静态树序列化为 JSON 起点，改可见性/顺序/标题后保存）。
 * 另附读实态权限码聚合（GET /menu-config/permission-codes）。
 */
import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createMenuConfig,
  fetchMenuConfigs,
  fetchMenuPermissionCodes,
  updateMenuConfig,
} from '../../data/menuConfigApi';
import { ApiErrorHint } from '../../components/ApiErrorHint';
import { QueryState } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { menuTree } from '../../menu';
import { MOBILE_MENU, MOBILE_SUBPAGES } from '../../mobile';

/** 静态装配树 → 配置节点 JSON（预填起点：code/title/routePath/permission 保形）。 */
function staticTreeAsConfigJson(code: string): string {
  const strip = (nodes: readonly unknown[]): unknown[] =>
    nodes.map((node) => {
      const record = node as Record<string, unknown>;
      const out: Record<string, unknown> = { code: record['code'], title: record['title'] };
      if (typeof record['routePath'] === 'string') out['routePath'] = record['routePath'];
      if (typeof record['permission'] === 'string') out['permission'] = record['permission'];
      if (Array.isArray(record['children'])) out['children'] = strip(record['children']);
      return out;
    });
  const nodes = code === 'mobile' ? [...MOBILE_MENU, ...MOBILE_SUBPAGES] : menuTree;
  return JSON.stringify(strip(nodes as readonly unknown[]), null, 2);
}

export function MenuConfigsPage() {
  const queryClient = useQueryClient();
  const configsQuery = useQuery({ queryKey: ['menu-config', 'configs'], queryFn: fetchMenuConfigs });
  const codesQuery = useQuery({ queryKey: ['menu-config', 'permission-codes'], queryFn: fetchMenuPermissionCodes });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['menu-config'] });
  };
  const createMutation = useMutation({ mutationFn: createMenuConfig, onSuccess: invalidate });
  const updateMutation = useMutation({
    mutationFn: (vars: { id: string; input: Parameters<typeof updateMenuConfig>[1] }) =>
      updateMenuConfig(vars.id, vars.input),
    onSuccess: invalidate,
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(
    () => configsQuery.data?.find((config) => config.id === selectedId) ?? null,
    [configsQuery.data, selectedId],
  );

  const [nodesDraft, setNodesDraft] = useState('');
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  // 选中行 → 载入编辑草稿（或从装配态预填）
  function loadDraft(configId: string | null, fromStaticCode?: string) {
    setSelectedId(configId);
    setDraftError(null);
    if (configId === null) {
      setNodesDraft('');
      setDraftFor(null);
      return;
    }
    const config = configsQuery.data?.find((row) => row.id === configId);
    if (config === undefined) return;
    setNodesDraft(fromStaticCode === undefined ? JSON.stringify(config.nodes, null, 2) : staticTreeAsConfigJson(fromStaticCode));
    setDraftFor(configId);
  }

  function handleSaveNodes() {
    if (selected === null || draftFor !== selected.id) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(nodesDraft);
    } catch (error) {
      setDraftError(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    setDraftError(null);
    updateMutation.mutate(
      { id: selected.id, input: { nodes: parsed as never } },
      {
        onSuccess: () => setDraftFor(null),
        onError: () => setDraftFor(draftFor),
      },
    );
  }

  const [createCode, setCreateCode] = useState('');
  const [createName, setCreateName] = useState('');

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.mutate(
      {
        code: createCode.trim(),
        name: createName.trim(),
        nodes: JSON.parse(staticTreeAsConfigJson(createCode.trim())) as never,
      },
      {
        onSuccess: () => {
          setCreateCode('');
          setCreateName('');
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>菜单配置集</CardTitle>
          <CardDescription>
            一行 = 一棵节点树文档：code=default 管 web 侧栏，code=mobile 管移动导航（0920 #98/#99）。
            保存后前端启动合并（叠呈现：可见性/顺序/标题；路由与权限以装配态为准，未知页面码被忽略）。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <QueryState
            isPending={configsQuery.isPending}
            error={configsQuery.isError ? configsQuery.error : null}
            isEmpty={configsQuery.data !== undefined && configsQuery.data.length === 0}
            empty="暂无配置集（下方创建 default / mobile 两面）"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">code</th>
                    <th className="py-2 pr-4 font-medium">名称</th>
                    <th className="py-2 pr-4 font-medium">顶层节点数</th>
                    <th className="py-2 pr-4 font-medium">启用</th>
                    <th className="py-2 pr-4 font-medium">更新于</th>
                    <th className="py-2 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(configsQuery.data ?? []).map((config) => (
                    <tr key={config.id} className="border-b last:border-b-0">
                      <td className="py-2 pr-4 font-mono text-xs">{config.code}</td>
                      <td className="py-2 pr-4">{config.name}</td>
                      <td className="py-2 pr-4 tabular-nums">{config.nodes.length}</td>
                      <td className="py-2 pr-4">{config.active ? '是' : '停用'}</td>
                      <td className="py-2 pr-4 text-xs tabular-nums">
                        {config.updatedAt.slice(0, 19).replace('T', ' ')}
                      </td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-1.5">
                          <Button variant="outline" size="sm" onClick={() => loadDraft(config.id)}>
                            编辑
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              updateMutation.mutate({ id: config.id, input: { active: !config.active } })
                            }
                          >
                            {config.active ? '停用' : '启用'}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </QueryState>
          {codesQuery.data !== undefined && (
            <p className="text-xs text-muted-foreground">
              读实态权限码（active 配置树声明码去重排序，共 {codesQuery.data.length} 个）：
              <span className="ml-1 font-mono">{codesQuery.data.join(' ')}</span>
            </p>
          )}
        </CardContent>
      </Card>

      {selected !== null && (
        <Card>
          <CardHeader>
            <CardTitle>编辑节点树：{selected.code}</CardTitle>
            <CardDescription>
              JSON 节点数组（code/title 必填；routePath/permission 存档展示，运行时以装配态为准；删除节点 = 侧栏隐藏该项）。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-1.5">
              <Button variant="outline" size="sm" onClick={() => loadDraft(selected.id, selected.code)}>
                从装配态预填
              </Button>
              <Button variant="outline" size="sm" onClick={() => loadDraft(selected.id)}>
                还原当前配置
              </Button>
            </div>
            <textarea
              className="min-h-64 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs"
              spellCheck={false}
              value={nodesDraft}
              onChange={(event) => {
                setNodesDraft(event.target.value);
                setDraftFor(selected.id);
              }}
            />
            {draftError && <p className="text-sm text-destructive">{draftError}</p>}
            {updateMutation.isError && <ApiErrorHint error={updateMutation.error} />}
            <div>
              <Button
                onClick={handleSaveNodes}
                disabled={updateMutation.isPending || nodesDraft.trim().length === 0 || draftFor !== selected.id}
              >
                保存节点树
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>创建配置集</CardTitle>
          <CardDescription>
            code 租户内唯一（建议 default / mobile）；节点树从当前装配态预填（保存后再编辑删改）。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleCreate}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="menu-config-code">code</Label>
              <Input
                id="menu-config-code"
                value={createCode}
                onChange={(event) => setCreateCode(event.target.value)}
                placeholder="default"
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="menu-config-name">名称</Label>
              <Input
                id="menu-config-name"
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                placeholder="Web 菜单"
                required
              />
            </div>
            {createMutation.isError && (
              <div className="sm:col-span-2">
                <ApiErrorHint error={createMutation.error} />
              </div>
            )}
            <div className="sm:col-span-2">
              <Button type="submit" disabled={createMutation.isPending || createCode.trim().length === 0}>
                创建配置集
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
