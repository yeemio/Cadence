/**
 * 移动配件审批页（S3 移动呈现，parts:approve；覆盖矩阵 §3.2 #118 配件审批）：
 * GET /workorder/parts-requests?state=submitted 待审队列（parts:read，过滤值
 * 命中整个「审批中」族——submitted/level2_review/level3_review 同返回）→
 * POST /workorder/parts-requests/:id/approval（workorder.parts.approve.v1：
 * decision approve/reject + 决策理由 remark 必填 1~2000；expectedRevision 取行
 * objectVersion）。权限码与后端 workorder.controllers.ts:208-240 同码。
 *
 * fix-wave-2 D-12/D-6 移动收尾：待审队列查询按 session 权限投影门禁——门禁码
 * 取端点实码 parts:read（GET /workorder/parts-requests 的 @RequirePermission），
 * 非导航注册码 parts:approve（动作码不折算读码）。
 *
 * UX-AP-01 审批链可见性收口：
 * - 每行加查 GET /workorder/parts-requests/:id（同一 parts:read）取服务端
 *   pendingApproval 待审级实时解析（level + 本级或签名单 + note），行内展示
 *   「正等待第几级、本级审批人是谁」——点击前即可预警；
 * - 仅当行状态证实处于多级链中间态（level2/level3_review）时按名单禁用批准/
 *   拒绝并给中文原因——单级链（levels=1 缺省）服务端不做人校验，前端不臆测
 *   禁用，交由行内预警 + 拒因文案兜底；
 * - 决策结果文案主语化：按服务端已知拒因映射为人话（谁没被审批、为什么、
 *   下一步找谁），不裸贴服务端串。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useGetIdentity } from '@refinedev/core';
import { CheckCircle2, LoaderCircle, XCircle } from 'lucide-react';
import { PARTS_READ } from '@smes/product-ui';
import { useMobileDataAccess, MobileNoAccessHint } from './pageAccess';
import { ApiErrorHint } from '@/components/ApiErrorHint';
import { request } from '@/data/apiClient';
import type { CommandOutcomeView } from '@/data/commandClient';
import { fetchPartsRequests } from '@/data/mobile-ops';
import { decidePartsRequest } from '@/data/workorderApi';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { PARTS_STATE_LABELS, labelOf } from './labels';
import type { PartsRequestRowView } from '@smes/product-ui';

type Decision = 'approve' | 'reject';

/**
 * 待审级实时解析视图（GET /workorder/parts-requests/:id 的 pendingApproval 字段
 * ——服务端 workorder.service.ts PartsPendingApprovalView 的前端只读投影）。
 */
interface PendingApprovalGate {
  readonly level: number;
  /** 本级或签审批人（用户 id；空 = 该级未配置或无审批人）。 */
  readonly approvers: readonly string[];
  /** 名单为空时的服务端原因说明（正常 null）。 */
  readonly note: string | null;
}

function parsePendingApproval(input: unknown): PendingApprovalGate | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  const level = record['level'];
  if (typeof level !== 'number' || !Number.isInteger(level)) return null;
  const rawApprovers = record['approvers'];
  const approvers = Array.isArray(rawApprovers)
    ? rawApprovers.filter((item): item is string => typeof item === 'string')
    : [];
  const note = typeof record['note'] === 'string' && record['note'].length > 0 ? record['note'] : null;
  return { level, approvers, note };
}

/** GET /workorder/parts-requests/:id（parts:read，与队列同一读权限）→ 待审级解析。 */
async function fetchPendingApprovalGate(id: string): Promise<PendingApprovalGate | null> {
  const body = await request(`/workorder/parts-requests/${encodeURIComponent(id)}`);
  if (typeof body !== 'object' || body === null) return null;
  return parsePendingApproval((body as Record<string, unknown>)['pendingApproval']);
}

/** 批量取队列各行待审级解析；单行失败回落 null（该行不禁用，拒因文案兜底）。 */
async function fetchPendingApprovalGates(
  ids: readonly string[],
): Promise<Record<string, PendingApprovalGate | null>> {
  const entries = await Promise.all(
    ids.map(async (id) => {
      try {
        return [id, await fetchPendingApprovalGate(id)] as const;
      } catch {
        return [id, null] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

/** 多级链已证实的行级禁用判定（UX-AP-01①）：返回 null = 可点，非 null = 禁用原因。 */
function rowApprovalBlock(
  row: PartsRequestRowView,
  gate: PendingApprovalGate | null,
  myUserId: string | null,
): string | null {
  if (gate === null) return null;
  // 仅 level2/level3_review 证实多级链生效（这两个中间态只存在于派生多级流配置）
  // ——服务端决策此时必做名单校验；submitted 行可能是单级链（服务端不校验人），
  // 前端不据此禁用，由行内预警 + 拒因文案兜底。
  const multiLevel = row.state === 'level2_review' || row.state === 'level3_review';
  if (!multiLevel) return null;
  if (gate.approvers.length === 0) {
    return `第 ${gate.level} 级审批人未配置${gate.note !== null ? `（${gate.note}）` : ''}，暂时无人可审批这条申请。`;
  }
  if (myUserId !== null && !gate.approvers.includes(myUserId)) {
    return `这条申请正等待第 ${gate.level} 级审批，本级审批人另有其人（当前账号不在本级审批人名单内）。`;
  }
  return null;
}

/**
 * 决策结果主语化文案（UX-AP-01②）：rejected 是业务结果——按服务端已知拒因
 * 映射为人话（谁没被审批/为什么/下一步找谁），不裸贴服务端串；未知拒因仍给
 * 主语句式兜底。
 */
function approvalOutcomeCopy(
  outcome: CommandOutcomeView,
): { readonly tone: 'ok' | 'bad' | 'warn'; readonly text: string } {
  if (outcome.committed) {
    return { tone: 'ok', text: '审批已提交成功。' };
  }
  if (outcome.status === 'rejected') {
    const reason = outcome.reason ?? '';
    const emptyLevel = /第\s*(\d+)\s*级审批未配置审批人（([^（）]*)），无法决策/.exec(reason);
    if (emptyLevel !== null) {
      const level = emptyLevel[1] ?? '';
      const note = emptyLevel[2] ?? '';
      return {
        tone: 'bad',
        text: `这条申请未能完成审批：第 ${level} 级还没有可审批的人${note.length > 0 ? `（${note}）` : ''}。这次点击没有产生审批结果，请联系管理员补齐该级审批人后再试。`,
      };
    }
    if (reason.includes('不在本级审批人名单')) {
      return {
        tone: 'bad',
        text: '这次审批没有生效：当前账号不在这条申请的本级审批人名单内，应由名单内的审批人处理。',
      };
    }
    if (reason.includes('乐观锁冲突')) {
      return {
        tone: 'bad',
        text: '这条申请刚被其他人处理过，页面状态已过期。请刷新列表后按最新状态操作。',
      };
    }
    if (reason.includes('不支持决策') || reason.includes('未迁移')) {
      return {
        tone: 'bad',
        text: '这条申请的状态已发生变化，本次审批没有执行。请刷新列表查看最新状态。',
      };
    }
    if (reason.includes('不存在配件申请')) {
      return { tone: 'bad', text: '这条申请已不存在（可能已被删除）。请刷新列表。' };
    }
    if (reason.includes('配置') && reason.includes('不符')) {
      return {
        tone: 'bad',
        text: '这条申请的审批流程配置已变更，无法按原流程审批。请联系管理员处理。',
      };
    }
    return {
      tone: 'bad',
      text: `这次审批没有提交成功：${reason.length > 0 ? reason : '原因未返回'}。`,
    };
  }
  return { tone: 'warn', text: '提交结果暂不确定，请稍后刷新列表核对这条申请的状态。' };
}

export function MobilePartsApprovalPage() {
  const queryClient = useQueryClient();
  // UX-AP-01：当前登录用户 id——用于「本级审批人是否包含我」的行级判定。
  const { data: identityData } = useGetIdentity();
  const myUserId = typeof identityData?.userId === 'string' ? identityData.userId : null;
  // D-12：待审队列查询按 session 权限投影（parts:read，端点实码；见文件头注释）。
  const accessible = useMobileDataAccess(PARTS_READ);
  const queueQuery = useQuery({
    queryKey: ['workorder', 'parts-requests', 'submitted'],
    queryFn: () => fetchPartsRequests(),
    enabled: accessible,
  });

  const [remarkInputs, setRemarkInputs] = useState<Record<string, string>>({});
  const decideMutation = useMutation({
    mutationFn: (input: { row: PartsRequestRowView; decision: Decision; remark: string }) =>
      decidePartsRequest(input.row.id, { objectVersion: input.row.objectVersion }, {
        decision: input.decision,
        remark: input.remark,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workorder', 'parts-requests'] });
    },
  });

  const rows = queueQuery.data ?? [];
  // UX-AP-01：各行待审级实时解析（同 parts:read 读权限；行集合变化即重取——
  // 决策成功/失败后队列失效重拉，本查询随行集合键一并刷新）。
  const gatesQuery = useQuery({
    queryKey: ['workorder', 'parts-requests', 'pending-gates', rows.map((row) => row.id)],
    queryFn: () => fetchPendingApprovalGates(rows.map((row) => row.id)),
    enabled: accessible && rows.length > 0,
  });
  const gates = gatesQuery.data;

  function decide(row: PartsRequestRowView, decision: Decision): void {
    if (decideMutation.isPending) return;
    const remark = (remarkInputs[row.id] ?? '').trim();
    if (remark.length === 0) {
      // 后端 requireBoundedString(1,2000)：理由必填——前后端同口径前置提示。
      decideMutation.reset();
      setRemarkInputs((prev) => ({ ...prev, [`${row.id}::error`]: '决策理由必填（1~2000 字）' }));
      return;
    }
    setRemarkInputs((prev) => ({ ...prev, [`${row.id}::error`]: '' }));
    decideMutation.mutate({ row, decision, remark });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>配件审批</CardTitle>
          {/* UX-VW-06：拒权终态只呈现无权限提示，不渲染操作说明（下方的批准/
              拒绝说明对无权限读者是无效操作指引）。UX-AP-07：说明与 P1 审批链
              预警口径一致——批准后按链逐级流转，各级审批人配齐才能通过进入
              发货（单级链缺人时同样卡在审批，不承诺「批准即进发货链」）。 */}
          {accessible && (
            <CardDescription>
              待审批申请（提交即待审）；批准后按审批链逐级流转，各级审批人配齐才能通过并进入发货，拒绝即终结。
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {!accessible ? (
            // UX-AP-02：指名数据域（缺的是配件审批列表的查看权限），不裸权限码。
            <MobileNoAccessHint code={PARTS_READ} subject="配件审批列表" />
          ) : (
            <>
              {queueQuery.isPending && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" /> 正在加载…
                </p>
              )}
              {queueQuery.isError && <ApiErrorHint error={queueQuery.error} />}
            </>
          )}
          {decideMutation.isError && <ApiErrorHint error={decideMutation.error} />}
          {queueQuery.data !== undefined && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">暂无待审批的配件申请。</p>
          )}
          {rows.map((row) => {
            const busy = decideMutation.isPending && decideMutation.variables?.row.id === row.id;
            const remarkError = remarkInputs[`${row.id}::error`] ?? '';
            const gate = gates?.[row.id] ?? null;
            const blockReason = rowApprovalBlock(row, gate, myUserId);
            const outcome =
              decideMutation.variables?.row.id === row.id && decideMutation.data !== undefined
                ? approvalOutcomeCopy(decideMutation.data)
                : null;
            return (
              <div
                key={row.id}
                className="flex flex-col gap-2 rounded-lg border bg-background px-3 py-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    {labelOf(PARTS_STATE_LABELS, row.state)}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">{row.id}</span>
                </div>
                <div className="flex flex-col gap-0.5 text-sm">
                  <span className="truncate">
                    工作令 <span className="font-mono">{row.workOrderId}</span>
                  </span>
                  <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    <span>
                      物料 <span className="font-mono">{row.itemId}</span>
                    </span>
                    <span>× {row.quantity}</span>
                    <span>{row.requester}</span>
                    <span>{row.createdAt.slice(0, 10)}</span>
                  </span>
                  {row.remark !== null && (
                    <span className="text-xs text-muted-foreground">申请备注：{row.remark}</span>
                  )}
                </div>
                {/* UX-AP-01① 点击前预警：本行正等待哪一级、本级审批人是谁（服务端实时解析）。 */}
                {gate !== null && (
                  gate.approvers.length === 0 ? (
                    <p className="text-xs text-amber-700">
                      这条申请正等待第 {gate.level} 级审批；本级审批人未配置
                      {gate.note !== null ? `：${gate.note}` : ''}，此级审批暂时无人可办。
                    </p>
                  ) : myUserId !== null && gate.approvers.includes(myUserId) ? (
                    <p className="text-xs text-muted-foreground">
                      这条申请正等待第 {gate.level} 级审批；你是本级审批人，可以审批。
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      这条申请正等待第 {gate.level} 级审批；本级审批人：
                      <span className="font-mono">{gate.approvers.join('、')}</span>。
                    </p>
                  )
                )}
                <input
                  className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
                  placeholder="决策理由（必填）"
                  value={remarkInputs[row.id] ?? ''}
                  onChange={(event) =>
                    setRemarkInputs((prev) => ({ ...prev, [row.id]: event.target.value }))
                  }
                />
                {remarkError.length > 0 && <p className="text-xs text-destructive">{remarkError}</p>}
                <div className="flex gap-2">
                  <Button
                    className="h-11 flex-1"
                    disabled={decideMutation.isPending || blockReason !== null}
                    onClick={() => decide(row, 'approve')}
                  >
                    {busy && decideMutation.variables?.decision === 'approve' ? '提交中…' : (
                      <>
                        <CheckCircle2 />
                        批准
                      </>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11 flex-1"
                    disabled={decideMutation.isPending || blockReason !== null}
                    onClick={() => decide(row, 'reject')}
                  >
                    {busy && decideMutation.variables?.decision === 'reject' ? '提交中…' : (
                      <>
                        <XCircle />
                        拒绝
                      </>
                    )}
                  </Button>
                </div>
                {blockReason !== null && <p className="text-xs text-destructive">{blockReason}</p>}
                {outcome !== null && (
                  <p
                    className={
                      outcome.tone === 'ok'
                        ? 'text-xs text-emerald-700'
                        : outcome.tone === 'bad'
                          ? 'text-xs text-destructive'
                          : 'text-xs text-amber-700'
                    }
                  >
                    {outcome.text}
                  </p>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
