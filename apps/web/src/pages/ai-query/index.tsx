/**
 * AI 问数页（WP-C，CONTRACT v1 §Web · 2026-10-28）。
 *
 * 规则引擎模式首版：三域自然语言问数（工作令进度/物料缺口/质量检验），
 * 回答 = 结构化事实卡（数字＋口径注记＋来源＋完整性＋详情跳转）——不是
 * 聊天机器人，页面明示「规则引擎模式 · 未接入 AI 模型」（顶部固定横幅）。
 *
 * AskResponse 五态渲染（POST /ai-query/ask 恒 200，kind 判别）：
 *  - answer：AnswerCard.tsx（FactCard 组：指标/行表/口径注记/完整性徽标/来源/门禁跳转）；
 *  - clarify：prompt + 选项 chips，点击以 selectedOptionId + 原 question + 原 sessionId 重发；
 *  - denied：明示 missingPermissions 码清单（回答通道内 200，不是 403）；
 *  - unsupported：能力提示 capabilityHints（规则未命中）；
 *  - unavailable：数据源未就绪如实说明（如目标工作令无齐套核对记录）。
 *
 * 详情跳转由前端路由表拼装（服务端只回 subject）：workorder→/workorders?wo=、
 * material→/listings/gap-checks?wo=、inspection→/inspections；链接按当前会话
 * 权限码条件渲染（先例 WorkOrdersPage M2-R1 入口门禁，权限未就绪按无码兜底）。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePermissions } from '@refinedev/core';
import { permissionCode, sessionHasPermission, toPermissionCodes } from '@smes/product-ui';
import {
  ask,
  listCapabilities,
  listSessions,
  getSession,
  type AiQueryAskResponse,
  type AiQueryFactCardSubject,
} from '../../data/aiQueryApi';
import { ApiErrorHint } from '../../components/ApiErrorHint';
import { QueryState } from '../../components/ModuleTable';
import { cn } from '@/lib/utils';
import { formatLocalDateTime, shortId } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AnswerView } from './AnswerCard';

/** 输入 500 字上限（合同 §Wire：question 1..500，服务端同限）。 */
const QUESTION_MAX_LENGTH = 500;

/** 详情跳转门禁码（与目标页菜单码同码：workorder / listing-gap-checks / inspections）。 */
const WORKORDER_READ = permissionCode('workorder:read');
const GAP_READ = permissionCode('gap:read');
const AI_QUERY_READ = permissionCode('ai-query:read');
const INSPECTION_READ = permissionCode('inspection:read');

/** 线程一问一答轮次（chosenOptionId 为 clarify 回放后的本地已选标记）。 */
interface ThreadTurn {
  readonly question: string;
  readonly response: AiQueryAskResponse;
  chosenOptionId?: string | undefined;
}

export function AiQueryPage() {
  const queryClient = useQueryClient();
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [turns, setTurns] = useState<readonly ThreadTurn[]>([]);
  const [question, setQuestion] = useState('');

  // ——会话权限未就绪按无权限兜底（跳转入口不渲染；admin 通配由 sessionHasPermission 内含）。
  const { data: permissionData } = usePermissions({});
  const codes = toPermissionCodes(permissionData);
  const canAsk = sessionHasPermission(codes, AI_QUERY_READ);
  const canOpenWorkorder = sessionHasPermission(codes, WORKORDER_READ);
  const canOpenGapChecks = sessionHasPermission(codes, GAP_READ);
  const canOpenInspections = sessionHasPermission(codes, INSPECTION_READ);

  const capabilitiesQuery = useQuery({
    queryKey: ['ai-query', 'capabilities'],
    queryFn: listCapabilities,
    enabled: canAsk,
  });
  const sessionsQuery = useQuery({
    queryKey: ['ai-query', 'sessions'],
    queryFn: () => listSessions(),
    enabled: canAsk,
  });

  /** 问数（新问/澄清回放共用；恒 200，五态经 kind 判别）。 */
  const askMutation = useMutation({
    mutationFn: ask,
    onSuccess: (response, variables) => {
      setSessionId(response.sessionId);
      setTurns((prev) => {
        const next = [...prev, { question: variables.question, response }];
        if (variables.selectedOptionId !== undefined) {
          // 澄清回放：就近标记上一个未选的 clarify 轮（已选 chips 置灰防重复提交）
          for (let i = next.length - 2; i >= 0; i -= 1) {
            const candidate = next[i] as ThreadTurn;
            if (candidate.response.kind === 'clarify' && candidate.chosenOptionId === undefined) {
              next[i] = { ...candidate, chosenOptionId: variables.selectedOptionId };
              break;
            }
          }
        }
        return next;
      });
      setQuestion('');
      void queryClient.invalidateQueries({ queryKey: ['ai-query', 'sessions'] });
    },
  });

  /** 载入历史会话线程（跨用户/已失效会话 → 404，走 ApiErrorHint）。 */
  const loadMutation = useMutation({
    mutationFn: getSession,
    onSuccess: (detail) => {
      setSessionId(detail.sessionId);
      setTurns(detail.turns.map((turn) => ({ question: turn.question, response: turn.response })));
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = question.trim();
    if (trimmed.length === 0 || askMutation.isPending) return;
    const input: { sessionId?: string; question: string; selectedOptionId?: string } = { question: trimmed };
    if (sessionId !== undefined) input.sessionId = sessionId;
    askMutation.mutate(input);
  }

  /** 澄清选项点击：selectedOptionId + 原 question + 原 sessionId 重发（e2e 同口径）。 */
  function handleChooseOption(turn: ThreadTurn, optionId: string): void {
    if (askMutation.isPending) return;
    const input: { sessionId?: string; question: string; selectedOptionId?: string } = {
      question: turn.question,
      selectedOptionId: optionId,
    };
    if (turn.response.kind === 'clarify') input.sessionId = turn.response.sessionId;
    askMutation.mutate(input);
  }

  function handleNewSession(): void {
    setSessionId(undefined);
    setTurns([]);
    setQuestion('');
  }

  /** 详情跳转 URL（按主体类别 + 会话权限门禁；无权限返回 null 不渲染）。 */
  function detailHref(subject: AiQueryFactCardSubject): string | null {
    if (subject.kind === 'workorder') {
      return canOpenWorkorder ? `/workorders?wo=${encodeURIComponent(subject.id)}` : null;
    }
    if (subject.kind === 'material') {
      return canOpenGapChecks ? `/listings/gap-checks?wo=${encodeURIComponent(subject.id)}` : null;
    }
    const window = /^window:(.+)\.\.(.+)$/.exec(subject.id);
    return canOpenInspections ? `/inspections?state=failed${window ? `&from=${encodeURIComponent(window[1]!)}&to=${encodeURIComponent(window[2]!)}` : ''}` : null;
  }

  if (!canAsk) return <p role="note">当前账号没有问数入口权限，请联系管理员。</p>;

  return (
    <div className="flex flex-col gap-6">
      {/* 如实降级标注（合同 §意图路由：v1 无模型；样式克制，固定页面顶部） */}
      <div
        role="note"
        className="rounded-md border border-dashed bg-background/95 px-3 py-2 text-xs text-muted-foreground backdrop-blur"
      >
        规则引擎模式 · 未接入 AI 模型 —— 意图路由与回答由确定性规则和结构化事实模板生成，不含推测性结论。
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>AI 问数</CardTitle>
              <CardDescription>
                用一句话问工作令进度、物料缺口、质量检验——回答附口径注记、数据来源与完整性标注。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <form onSubmit={handleSubmit} className="flex flex-col gap-2">
                <Label htmlFor="aiq-question">你的问题</Label>
                <Input
                  id="aiq-question"
                  value={question}
                  maxLength={QUESTION_MAX_LENGTH}
                  placeholder="例如：工作令进度做到哪了 / 工作令缺料吗 / 今天检验有哪些不合格"
                  onChange={(e) => setQuestion(e.target.value)}
                />
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {question.length}/{QUESTION_MAX_LENGTH}
                  </span>
                  <div className="flex items-center gap-2">
                    {sessionId !== undefined && (
                      <Button type="button" variant="outline" onClick={handleNewSession}>
                        新会话
                      </Button>
                    )}
                    <Button
                      type="submit"
                      disabled={question.trim().length === 0 || askMutation.isPending}
                    >
                      {askMutation.isPending ? '问数中…' : '提问'}
                    </Button>
                  </div>
                </div>
              </form>
              {askMutation.isError && <ApiErrorHint error={askMutation.error} />}
            </CardContent>
          </Card>

          {turns.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>会话线程</CardTitle>
                <CardDescription>
                  {sessionId !== undefined ? `当前会话 ${shortId(sessionId)}` : '未建会话'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ol className="flex flex-col gap-5">
                  {turns.map((turn, index) => (
                    <li key={index} className="flex flex-col gap-2">
                      <p className="self-end rounded-lg bg-muted px-3 py-1.5 text-sm">
                        {turn.question}
                      </p>
                      <TurnResponse turn={turn} pending={askMutation.isPending} onChooseOption={handleChooseOption} detailHref={detailHref} />
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">支持的能力</CardTitle>
            </CardHeader>
            <CardContent>
              <QueryState
                isPending={capabilitiesQuery.isPending}
                error={capabilitiesQuery.isError ? capabilitiesQuery.error : null}
                isEmpty={capabilitiesQuery.data !== undefined && capabilitiesQuery.data.length === 0}
                empty="能力目录为空"
              >
                <ul className="flex flex-col gap-3">
                  {(capabilitiesQuery.data ?? []).map((capability) => (
                    <li key={capability.capabilityId} className="flex flex-col gap-1">
                      <p className="text-sm font-medium">
                        {capability.title}
                        <span className="ml-2 font-mono text-xs text-muted-foreground">
                          {capability.requiredPermissions.join(' + ')}
                        </span>
                      </p>
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {capability.description}
                      </p>
                    </li>
                  ))}
                </ul>
              </QueryState>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">最近会话</CardTitle>
              <CardDescription>点击载入历史线程继续追问</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <QueryState
                isPending={sessionsQuery.isPending}
                error={sessionsQuery.isError ? sessionsQuery.error : null}
                isEmpty={sessionsQuery.data !== undefined && sessionsQuery.data.length === 0}
                empty="暂无历史会话"
              >
                <ul className="flex flex-col gap-1.5">
                  {(sessionsQuery.data ?? []).map((item) => (
                    <li key={item.sessionId}>
                      <button
                        type="button"
                        onClick={() => loadMutation.mutate(item.sessionId)}
                        className={cn(
                          'w-full rounded-md border px-2.5 py-1.5 text-left text-sm hover:bg-muted/60',
                          sessionId === item.sessionId && 'border-primary bg-muted',
                        )}
                      >
                        {shortId(item.sessionId)} · {item.turnCount} 轮
                        <span className="ml-2 text-xs text-muted-foreground">
                          {formatLocalDateTime(item.lastActivityAt)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </QueryState>
              {loadMutation.isError && <ApiErrorHint error={loadMutation.error} />}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

/** 单轮回答渲染：answer/clarify/denied/unsupported/unavailable 五态各自独立样式。 */
function TurnResponse({
  turn,
  pending,
  onChooseOption,
  detailHref,
}: {
  readonly turn: ThreadTurn;
  readonly pending: boolean;
  readonly onChooseOption: (turn: ThreadTurn, optionId: string) => void;
  readonly detailHref: (subject: AiQueryFactCardSubject) => string | null;
}) {
  const response = turn.response;
  if (response.kind === 'answer') {
    return <AnswerView answer={response} detailHref={detailHref} />;
  }
  if (response.kind === 'clarify') {
    const chosen = turn.chosenOptionId;
    return (
      <div className="flex flex-col gap-2 rounded-lg border px-3 py-2.5">
        <p className="text-sm font-medium">需要澄清：{response.prompt}</p>
        <div className="flex flex-wrap gap-2">
          {response.options.map((option) => (
            <button
              key={option.id}
              type="button"
              disabled={pending || chosen !== undefined}
              onClick={() => onChooseOption(turn, option.id)}
              className={cn(
                'rounded-full border px-3 py-1 text-sm transition-colors hover:bg-muted/60',
                chosen === option.id && 'border-blue-700 bg-blue-50 text-blue-950 dark:bg-blue-950 dark:text-blue-50',
              )}
            >
              {option.label}
              {option.description.length > 0 && (
                <span className="ml-1.5 text-xs opacity-70">{option.description}</span>
              )}
            </button>
          ))}
        </div>
        {chosen !== undefined && (
          <p className="text-xs text-muted-foreground">已选择，问数中或已完成——选项不可重复提交。</p>
        )}
      </div>
    );
  }
  if (response.kind === 'denied') {
    return (
      <div role="note" className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5">
        <p className="text-sm font-medium text-destructive">无权限回答此问题</p>
        <p className="mt-1 text-xs text-muted-foreground">
          当前会话缺少以下权限码（需管理员授予后重试；端点级 ai-query:read 已通过）：
        </p>
        <ul className="mt-1.5 flex flex-wrap gap-1.5">
          {response.missingPermissions.map((code) => (
            <li key={code} className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">
              {code}
            </li>
          ))}
        </ul>
        {response.hint.length > 0 && (
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{response.hint}</p>
        )}
      </div>
    );
  }
  if (response.kind === 'unsupported') {
    return (
      <div role="note" className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5">
        <p className="text-sm font-medium text-amber-700 dark:text-amber-400">暂不支持这个问题</p>
        {response.hint.length > 0 && (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{response.hint}</p>
        )}
        {response.capabilityHints.length > 0 && (
          <div className="mt-1.5">
            <p className="text-xs text-muted-foreground">当前支持的问法示例：</p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {response.capabilityHints.map((hint, index) => (
                <li key={index} className="text-xs leading-relaxed">
                  · {hint}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }
  return (
    <div role="note" className="rounded-lg border border-muted-foreground/30 bg-muted/30 px-3 py-2.5">
      <p className="text-sm font-medium">数据源未就绪</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{response.detail}</p>
    </div>
  );
}
