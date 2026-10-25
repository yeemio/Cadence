/**
 * 操作日志查询页（S3-a：0920 #103）：时间窗 + 用户过滤的只读日志查询
 * （GET /audit/logs，audit:read 门禁；页面自身只读不产日志——拦截器跳过 /audit/*）。
 *
 * 过滤语义（audit-input.ts 实态）：from/to 为含端点 ISO 时刻（页面 datetime-local
 * 本地时区换 ISO）；userId 精确匹配；limit 1~1000 缺省 100（新→旧）。
 * 查询按"应用过滤"按钮显式触发（草稿/已应用两态，避免逐键打点后端）。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryAuditLogs } from '../../data/auditApi';
import { ModuleTable, QueryState } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const LIST_COLUMNS = [
  { key: 'occurredAt', label: '发生时刻', mono: true },
  { key: 'userId', label: '操作者', mono: true },
  { key: 'method', label: '方法', mono: true },
  { key: 'path', label: '路径', mono: true },
  { key: 'summary', label: '摘要' },
];

/** datetime-local 值 → ISO 时刻（空串 = 不过滤）。 */
function toIsoOrNull(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const ms = new Date(trimmed).getTime();
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

export function AuditLogsPage() {
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const [draftUserId, setDraftUserId] = useState('');
  const [draftLimit, setDraftLimit] = useState('100');
  const [applied, setApplied] = useState<{
    readonly from?: string;
    readonly to?: string;
    readonly userId?: string;
    readonly limit?: number;
  }>({});

  const logsQuery = useQuery({
    queryKey: ['audit', 'logs', applied],
    queryFn: () => queryAuditLogs(applied),
  });

  function handleApply(): void {
    const limit = Number(draftLimit.trim());
    const next: { from?: string; to?: string; userId?: string; limit?: number } = {};
    const from = toIsoOrNull(draftFrom);
    const to = toIsoOrNull(draftTo);
    if (from !== undefined) next.from = from;
    if (to !== undefined) next.to = to;
    if (draftUserId.trim().length > 0) next.userId = draftUserId.trim();
    if (Number.isInteger(limit) && limit >= 1 && limit <= 1000) next.limit = limit;
    setApplied(next);
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>操作日志</CardTitle>
          <CardDescription>
            写请求成功收场后落账（append-only；只记 method/path/操作者/时间，不打载荷全文）；新→旧。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
            <div className="flex flex-col gap-2">
              <Label htmlFor="audit-from">起（含，本地时区）</Label>
              <Input id="audit-from" type="datetime-local" value={draftFrom} onChange={(e) => setDraftFrom(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="audit-to">止（含）</Label>
              <Input id="audit-to" type="datetime-local" value={draftTo} onChange={(e) => setDraftTo(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="audit-user">操作者 id（可选）</Label>
              <Input
                id="audit-user"
                value={draftUserId}
                onChange={(e) => setDraftUserId(e.target.value)}
                placeholder="user-…"
                className="font-mono text-xs"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="audit-limit">条数（1~1000）</Label>
              <Input id="audit-limit" type="number" min={1} max={1000} value={draftLimit} onChange={(e) => setDraftLimit(e.target.value)} />
            </div>
            <Button variant="outline" onClick={handleApply}>
              查询
            </Button>
          </div>
          <QueryState
            isPending={logsQuery.isPending}
            error={logsQuery.isError ? logsQuery.error : null}
            isEmpty={logsQuery.data !== undefined && logsQuery.data.length === 0}
            empty="当前过滤条件下无操作日志"
          >
            <ModuleTable columns={LIST_COLUMNS} rows={logsQuery.data ?? []} rowIdKey="id" empty="当前过滤条件下无操作日志" />
          </QueryState>
          {logsQuery.data !== undefined && logsQuery.data.length > 0 && (
            <p className="text-xs text-muted-foreground">
              返回 {logsQuery.data.length} 条（limit 生效值 {applied.limit ?? 100}；触顶即截断，收窄时间窗或加操作者过滤）。
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
