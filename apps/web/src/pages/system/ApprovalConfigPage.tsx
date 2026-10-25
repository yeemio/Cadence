/**
 * 审批流配置页（T1 能力子集：0920 #102 审批流引擎配置）。覆盖：
 *  - 读当前配置：流列表 + 选中流的状态/迁移摘要（多级审核节点与驳回回退 =
 *    transitions 的 from→to 规则集，engine-flow 配置形状）；
 *  - 版本历史：整文档替换自动入档（封顶 20），"启用该版本" = PUT config=快照
 *    （当前配置再入历史，走同一校验路径）；
 *  - 启用指定流：activate（租户内单启用收口——运行时新案按 active 配置驱动，
 *    无 active 行回落内置默认流）；
 *  - 写操作 = 配置版本管理端点：创建/期望态更新/试写预检（validate）。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  activateApprovalFlow,
  createApprovalFlow,
  fetchApprovalFlows,
  updateApprovalFlow,
  validateFlowConfig,
} from '../../data/approvalConfigApi';
import type { ApprovalFlowRowView } from '../../data/approvalConfigApi';
import { ApiErrorHint } from '../../components/ApiErrorHint';
import { QueryState } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

function formatStamp(iso: string): string {
  return iso.slice(0, 19).replace('T', ' ');
}

/** 状态/迁移摘要文本（from --event[decision]--> to）。 */
function transitionLabel(rule: { from: string; event: string; to: string; decision?: string }): string {
  return `${rule.from} --${rule.event}${rule.decision === undefined ? '' : `(${rule.decision})`}--> ${rule.to}`;
}

export function ApprovalConfigPage() {
  const queryClient = useQueryClient();
  const flowsQuery = useQuery({ queryKey: ['approval-config', 'flows'], queryFn: fetchApprovalFlows });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['approval-config'] });
  };
  const updateMutation = useMutation({
    mutationFn: (vars: { id: string; input: Parameters<typeof updateApprovalFlow>[1] }) =>
      updateApprovalFlow(vars.id, vars.input),
    onSuccess: invalidate,
  });
  const activateMutation = useMutation({ mutationFn: activateApprovalFlow, onSuccess: invalidate });
  const createMutation = useMutation({ mutationFn: createApprovalFlow, onSuccess: invalidate });
  const validateMutation = useMutation({ mutationFn: validateFlowConfig });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const flows = flowsQuery.data ?? [];
  const selected: ApprovalFlowRowView | null = flows.find((flow) => flow.id === selectedId) ?? null;

  const [configDraft, setConfigDraft] = useState('');
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  function selectFlow(flow: ApprovalFlowRowView | null) {
    setSelectedId(flow?.id ?? null);
    setDraftError(null);
    if (flow === null) {
      setConfigDraft('');
      setDraftFor(null);
      return;
    }
    setConfigDraft(JSON.stringify(flow.config, null, 2));
    setDraftFor(null); // 草稿初始 = 当前配置原文（未改动）
  }

  function parseDraft(): { ok: true; value: unknown } | { ok: false } {
    try {
      return { ok: true, value: JSON.parse(configDraft) };
    } catch (error) {
      setDraftError(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
      return { ok: false };
    }
  }

  function handleValidate() {
    const parsed = parseDraft();
    if (!parsed.ok) return;
    setDraftError(null);
    validateMutation.mutate(parsed.value);
  }

  function handleSave() {
    if (selected === null) return;
    const parsed = parseDraft();
    if (!parsed.ok) return;
    setDraftError(null);
    updateMutation.mutate(
      { id: selected.id, input: { config: parsed.value } },
      { onSuccess: () => setDraftFor(null) },
    );
  }

  const [createName, setCreateName] = useState('');
  const [createDraft, setCreateDraft] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  function handleCreate() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(createDraft);
    } catch (error) {
      setCreateError(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    setCreateError(null);
    createMutation.mutate(
      {
        ...(createName.trim().length === 0 ? {} : { name: createName.trim() }),
        config: parsed,
      },
      {
        onSuccess: () => {
          setCreateName('');
          setCreateDraft('');
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>审批流配置</CardTitle>
          <CardDescription>
            一行 = 一份 engine-flow 状态机配置全文；租户内单启用——启用流驱动新审批案
            （无启用行回落内置默认流）。在途案件由引擎重放守卫兜底（配置换代重放不一致即状态冲突）。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <QueryState
            isPending={flowsQuery.isPending}
            error={flowsQuery.isError ? flowsQuery.error : null}
            isEmpty={flows.length === 0}
            empty="暂无流配置（下方创建第一份，或使用内置默认流）"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">flowId</th>
                    <th className="py-2 pr-4 font-medium">名称</th>
                    <th className="py-2 pr-4 font-medium">状态/迁移</th>
                    <th className="py-2 pr-4 font-medium">历史版本</th>
                    <th className="py-2 pr-4 font-medium">启用</th>
                    <th className="py-2 pr-4 font-medium">更新于</th>
                    <th className="py-2 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {flows.map((flow) => (
                    <tr
                      key={flow.id}
                      className={cn('border-b last:border-b-0', flow.id === selectedId && 'bg-muted/60')}
                    >
                      <td className="py-2 pr-4 font-mono text-xs">{flow.flowId}</td>
                      <td className="py-2 pr-4">{flow.name}</td>
                      <td className="py-2 pr-4 tabular-nums">
                        {flow.config.states.length} 态 / {flow.config.transitions.length} 迁移
                      </td>
                      <td className="py-2 pr-4 tabular-nums">{flow.history.length}</td>
                      <td className="py-2 pr-4">
                        {flow.active ? (
                          <span className="font-medium text-primary">启用中</span>
                        ) : (
                          <span className="text-muted-foreground">停用</span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-xs tabular-nums">{formatStamp(flow.updatedAt)}</td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-1.5">
                          <Button variant="outline" size="sm" onClick={() => selectFlow(flow)}>
                            查看/编辑
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={flow.active || activateMutation.isPending}
                            onClick={() => activateMutation.mutate(flow.id)}
                          >
                            启用
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </QueryState>
          {(activateMutation.isError || updateMutation.isError) && (
            <ApiErrorHint error={activateMutation.error ?? updateMutation.error} />
          )}
        </CardContent>
      </Card>

      {selected !== null && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>配置摘要：{selected.flowId}</CardTitle>
              <CardDescription>
                {'多级审核节点与驳回回退规则（from --事件(决策)--> to）；当前生效配置全文在下方编辑区。'}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-1.5">
                {selected.config.states.map((state) => (
                  <span
                    key={state.id}
                    className={cn(
                      'rounded px-1.5 py-0.5 font-mono text-xs',
                      state.final === true ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary',
                      state.id === selected.config.initial && 'ring-1 ring-primary/40',
                    )}
                    title={state.id === selected.config.initial ? '初始状态' : state.final === true ? '终态' : undefined}
                  >
                    {state.id}
                  </span>
                ))}
              </div>
              <ul className="flex flex-col gap-1 font-mono text-xs text-muted-foreground">
                {selected.config.transitions.map((rule, index) => (
                  <li key={`${rule.from}-${rule.event}-${index}`}>{transitionLabel(rule)}</li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>编辑配置文档</CardTitle>
              <CardDescription>
                engine-flow 配置全文（JSON）；结构权威在后端校验——保存前可先"试写预检"。
                整文档替换后先前配置自动入版本历史。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <textarea
                className="min-h-56 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs"
                spellCheck={false}
                value={configDraft}
                onChange={(event) => {
                  setConfigDraft(event.target.value);
                  setDraftFor(selected.id);
                }}
              />
              {draftError && <p className="text-sm text-destructive">{draftError}</p>}
              {validateMutation.data !== undefined && draftFor === null && (
                <p className="text-sm text-muted-foreground">
                  试写通过（flowId={validateMutation.data.flowId}）——可保存。
                </p>
              )}
              {validateMutation.isError && <ApiErrorHint error={validateMutation.error} />}
              {updateMutation.isError && <ApiErrorHint error={updateMutation.error} />}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={handleValidate} disabled={validateMutation.isPending}>
                  试写预检
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={updateMutation.isPending || draftFor !== selected.id}
                >
                  保存（整文档替换）
                </Button>
                <Button variant="ghost" size="sm" onClick={() => selectFlow(selected)}>
                  放弃改动
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>版本历史（{selected.history.length}）</CardTitle>
              <CardDescription>
                新的在后；"启用该版本" = 以该快照整文档替换当前配置（当前配置入历史，同一校验路径）。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {selected.history.length === 0 && (
                <p className="text-sm text-muted-foreground">暂无历史版本（整文档替换后自动累积，封顶 20）。</p>
              )}
              {[...selected.history].reverse().map((version, index) => (
                <div
                  key={`${version.savedAt}-${index}`}
                  className="flex flex-wrap items-center justify-between gap-2 border-b py-2 last:border-b-0"
                >
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-muted-foreground">
                      v{selected.history.length - index} · {formatStamp(version.savedAt)} ·{' '}
                      {version.config.states.length} 态 / {version.config.transitions.length} 迁移
                    </p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      {version.config.transitions.map(transitionLabel).join('；')}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={updateMutation.isPending}
                    onClick={() =>
                      updateMutation.mutate(
                        { id: selected.id, input: { config: version.config } },
                        { onSuccess: () => setDraftFor(null) },
                      )
                    }
                  >
                    启用该版本
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>创建流配置</CardTitle>
          <CardDescription>
            config.flowId 为业务键（kebab-case，创建后不可改；缺省创建即启用——租户内单启用收口）。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex max-w-sm flex-col gap-2">
            <Label htmlFor="flow-name">名称（可选，缺省 = flowId）</Label>
            <Input id="flow-name" value={createName} onChange={(event) => setCreateName(event.target.value)} />
          </div>
          <textarea
            className="min-h-40 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs"
            spellCheck={false}
            placeholder='{"schemaVersion":1,"flowId":"two-step","initial":"draft","states":[...],"transitions":[...]}'
            value={createDraft}
            onChange={(event) => setCreateDraft(event.target.value)}
          />
          {createError && <p className="text-sm text-destructive">{createError}</p>}
          {createMutation.isError && <ApiErrorHint error={createMutation.error} />}
          <div>
            <Button onClick={handleCreate} disabled={createMutation.isPending || createDraft.trim().length === 0}>
              创建流配置
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
