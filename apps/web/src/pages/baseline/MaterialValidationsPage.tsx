/**
 * 物料校验运行页（S2 批次）：校验运行只读台账（列表 + 行选中详情含逐行判定）。
 * 执行无 HTTP 写端点（material.validate 走模块端口——listing 导入内联消费）；
 * HTTP 只开放读两径（GET /baseline/material-validations、/:id）。覆盖矩阵 #12 物料校验。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getValidationRun, listValidationRuns } from '../../data/baselineApi';
import { ModuleTable, QueryState, RowDetail } from '../../components/ModuleTable';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const LIST_COLUMNS = [
  { key: 'id', label: '运行 id', mono: true },
  { key: 'auditStatus', label: '审计状态', mono: true },
  { key: 'businessTime', label: '业务时间' },
  { key: 'issuedBy', label: '发起人', mono: true },
  { key: 'createdAt', label: '落账时刻' },
  { key: 'objectVersion', label: '版本', mono: true },
];

export function MaterialValidationsPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ['baseline', 'material-validations'],
    queryFn: listValidationRuns,
  });
  const selectedRow = listQuery.data?.find((row) => String(row['id']) === selectedId) ?? null;

  const detailQuery = useQuery({
    queryKey: ['baseline', 'material-validation', selectedId],
    queryFn: () => getValidationRun(selectedId as string),
    enabled: selectedId !== null,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>物料校验运行</CardTitle>
        <CardDescription>
          三分判定（match/candidate/missing）+ 相似度运行台账；执行由清单导入内联触发
          （listing 消费模块端口），本页为只读两径读回。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <QueryState
          isPending={listQuery.isPending}
          error={listQuery.error}
          isEmpty={listQuery.data !== undefined && listQuery.data.length === 0}
          empty="暂无校验运行（在清单页执行骨架导入后生成）"
        >
          <ModuleTable
            columns={LIST_COLUMNS}
            rows={listQuery.data ?? []}
            selectedId={selectedId}
            onSelect={(row) => setSelectedId(String(row['id']))}
          />
        </QueryState>
        {selectedId !== null && (
          <QueryState
            isPending={detailQuery.isPending}
            error={detailQuery.error}
            isEmpty={false}
          >
            <RowDetail
              row={detailQuery.data ?? {}}
              title="运行详情（summary + 逐行判定 lines）"
            />
          </QueryState>
        )}
      </CardContent>
    </Card>
  );
}
