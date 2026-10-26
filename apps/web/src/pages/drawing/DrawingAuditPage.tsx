/**
 * 查看留痕审计页（D-WO-05）：消费 GET /drawing/view-audit（drawing:audit-read，
 * 保密管理员独立权限码）——全量查看留痕按图纸/按查看人过滤（seq 升序），
 * 呈现 drawing 域"查看必留痕"不变量的审计面：谁、何时、看过哪版、当时保密等级。
 */
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { asTableRows, listDrawingViewAudit } from './drawingApi';
import { ModuleTable, QueryState } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function DrawingAuditPage() {
  const [drawingIdInput, setDrawingIdInput] = useState('');
  const [viewedByInput, setViewedByInput] = useState('');
  const [filter, setFilter] = useState<{ readonly drawingId?: string; readonly viewedBy?: string }>({});

  const auditQuery = useQuery({
    queryKey: ['drawing', 'audit', filter.drawingId ?? '', filter.viewedBy ?? ''],
    queryFn: () => listDrawingViewAudit(filter),
  });

  function handleApply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilter({
      ...(drawingIdInput.trim().length > 0 ? { drawingId: drawingIdInput.trim() } : {}),
      ...(viewedByInput.trim().length > 0 ? { viewedBy: viewedByInput.trim() } : {}),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>查看留痕审计</CardTitle>
        <CardDescription>
          每次图纸查看（内容指针取得的唯一路径）必落留痕行：查看人/时点/修订版本/当时保密
          等级快照（事后等级调整不追溯改写）。按图纸/按查看人过滤（seq 升序）；需
          drawing:audit-read 权限（独立于读权限）。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form className="flex flex-wrap items-end gap-3" onSubmit={handleApply}>
          <div className="flex w-72 flex-col gap-2">
            <Label htmlFor="audit-drawing-id">图号过滤（drawingId，可选）</Label>
            <Input
              id="audit-drawing-id"
              value={drawingIdInput}
              onChange={(event) => setDrawingIdInput(event.target.value)}
              placeholder="DWG-A01"
            />
          </div>
          <div className="flex w-72 flex-col gap-2">
            <Label htmlFor="audit-viewed-by">查看人过滤（viewedBy，可选）</Label>
            <Input
              id="audit-viewed-by"
              value={viewedByInput}
              onChange={(event) => setViewedByInput(event.target.value)}
              placeholder="user-id"
            />
          </div>
          <Button type="submit" variant="outline">应用过滤</Button>
        </form>
        <QueryState
          isPending={auditQuery.isPending}
          error={auditQuery.error}
          isEmpty={auditQuery.data !== undefined && auditQuery.data.length === 0}
          empty="当前过滤条件下无查看留痕"
        >
          <ModuleTable
            rowIdKey="id"
            columns={[
              { key: 'seq', label: 'seq', mono: true },
              { key: 'drawingId', label: '图号', mono: true },
              { key: 'version', label: '版本', mono: true },
              { key: 'viewedBy', label: '查看人', mono: true },
              { key: 'viewedAt', label: '查看时刻' },
              { key: 'classification', label: '当时保密等级' },
              { key: 'auditStatus', label: '审核状态', mono: true },
            ]}
            rows={asTableRows(auditQuery.data)}
          />
        </QueryState>
      </CardContent>
    </Card>
  );
}
