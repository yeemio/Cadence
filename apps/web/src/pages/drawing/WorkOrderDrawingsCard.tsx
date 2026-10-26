/**
 * 按工作令图纸清单卡片（D-WO-05 工作令集成入口）：消费
 * GET /drawing/work-orders/:workOrderId/drawings（refs 由组合根从工作令附件
 * 钉版编码 'drawingId@vN' 装配——工作令未挂图纸附件=空清单）。
 *
 * 三态呈现（RREQ-WO-027 实态）：
 *  - ok：钉版元数据 + 许可内最新版 latestVersion + hasUpdate（"存在新版"只数
 *    许可内新版，升级是显式动作）；
 *  - restricted：超保密许可——内容与元数据均不返，只呈现引用本身（调用方已知）；
 *  - missing：钉版修订不存在。
 * 每行提供「在图纸库中打开」链接（/drawings?drawingId=…——清单面不产生留痕，
 * 查看必经图纸库的 view 路径）。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  CLEARANCE_LEVELS,
  CLEARANCE_LEVEL_LABELS,
  listWorkOrderDrawings,
  type ClearanceLevel,
  type WorkOrderDrawingEntry,
} from './drawingApi';
import { QueryState } from '../../components/ModuleTable';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

export function WorkOrderDrawingsCard({ workOrderId }: { readonly workOrderId: string }) {
  const [clearance, setClearance] = useState<ClearanceLevel>('public');

  const drawingsQuery = useQuery({
    queryKey: ['drawing', 'work-order-drawings', workOrderId, clearance],
    queryFn: () => listWorkOrderDrawings(workOrderId, clearance),
  });
  const rows = drawingsQuery.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>图纸清单（钉版引用）</CardTitle>
        <CardDescription>
          工作令附件 kind='drawing' 按「drawingId@vN」钉版编码装配为本清单（非钉版编码的
          ref 不进清单）。清单是元数据面、不产生查看留痕——内容查看经图纸库的查看路径
          （必留痕）。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex w-64 flex-col gap-2">
          <Label htmlFor={`wo-drawings-clearance-${workOrderId}`}>保密许可（自声明）</Label>
          <Select
            id={`wo-drawings-clearance-${workOrderId}`}
            value={clearance}
            onChange={(event) => setClearance(event.target.value as ClearanceLevel)}
          >
            {CLEARANCE_LEVELS.map((level) => (
              <option key={level} value={level}>
                {CLEARANCE_LEVEL_LABELS[level]}（{level}）
              </option>
            ))}
          </Select>
        </div>
        <QueryState
          isPending={drawingsQuery.isPending}
          error={drawingsQuery.error}
          isEmpty={rows.length === 0}
          empty="本工作令未挂钉版图纸附件（附件 ref 按 drawingId@vN 编码才进清单）"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium whitespace-nowrap">钉版引用</th>
                  <th className="py-2 pr-4 font-medium whitespace-nowrap">状态</th>
                  <th className="py-2 pr-4 font-medium whitespace-nowrap">保密等级</th>
                  <th className="py-2 pr-4 font-medium whitespace-nowrap">许可内最新版</th>
                  <th className="py-2 pr-4 font-medium whitespace-nowrap">变更说明</th>
                  <th className="py-2 pr-4 font-medium whitespace-nowrap">发布人/时刻</th>
                  <th className="py-2 pr-4 font-medium whitespace-nowrap">图纸库</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((entry) => (
                  <WorkOrderDrawingRow key={`${entry.drawingId}@v${entry.version}`} entry={entry} />
                ))}
              </tbody>
            </table>
          </div>
        </QueryState>
      </CardContent>
    </Card>
  );
}

function WorkOrderDrawingRow({ entry }: { readonly entry: WorkOrderDrawingEntry }) {
  return (
    <tr className="border-b last:border-b-0">
      <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap">
        {entry.drawingId}@v{entry.version}
      </td>
      {entry.status === 'ok' ? (
        <>
          <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap">
            ok{entry.hasUpdate ? `（有新版 v${entry.latestVersion}——钉版不漂移，升级是显式动作）` : ''}
          </td>
          <td className="py-2 pr-4 whitespace-nowrap">
            {CLEARANCE_LEVEL_LABELS[entry.classification as ClearanceLevel] ?? entry.classification}
          </td>
          <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap">v{entry.latestVersion}</td>
          <td className="py-2 pr-4 whitespace-nowrap">{entry.changeNote}</td>
          <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap">
            {entry.changedBy} / {entry.changedAt}
          </td>
        </>
      ) : entry.status === 'restricted' ? (
        <td className="py-2 pr-4 text-xs whitespace-nowrap text-muted-foreground" colSpan={5}>
          restricted——超保密许可，内容与元数据均不可见（提升许可等级后重查）
        </td>
      ) : (
        <td className="py-2 pr-4 text-xs whitespace-nowrap text-muted-foreground" colSpan={5}>
          missing——钉版修订不存在（引用的 v{entry.version} 已不在修订链）
        </td>
      )}
      <td className="py-2 pr-4 whitespace-nowrap">
        <Link
          className="text-primary text-xs underline-offset-4 hover:underline"
          to={`/drawings?drawingId=${encodeURIComponent(entry.drawingId)}`}
        >
          在图纸库中打开
        </Link>
      </td>
    </tr>
  );
}
