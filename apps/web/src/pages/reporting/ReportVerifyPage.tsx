/**
 * 报工核查页（S2 批次）：待核查队列（pending-verification 端点）+ 行选中核查/
 * 撤销操作。覆盖矩阵 #49-53（五类报工核查）。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { listPendingVerification, revokeReport, verifyReport } from '../../data/reportingApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { errorOutcomeOf } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function queueColumns(t: ReturnType<typeof useTranslation>['t']): readonly {
  key: string;
  label: string;
  mono?: boolean;
}[] {
  return [
    { key: 'id', label: 'id', mono: true },
    { key: 'kind', label: t('column.kind'), mono: true },
    { key: 'dispatchId', label: t('column.dispatch-order'), mono: true },
    { key: 'doneQty', label: t('column.done-qty') },
    { key: 'laborMinutes', label: t('column.labor-minutes') },
    { key: 'reporter', label: t('column.reporter'), mono: true },
    { key: 'businessTime', label: t('column.business-time') },
    { key: 'objectVersion', label: t('column.version'), mono: true },
  ];
}

export function ReportVerifyPage() {
  const { t } = useTranslation('reporting');
  const queryClient = useQueryClient();
  const queueQuery = useQuery({ queryKey: ['reports', 'pending-verification'], queryFn: listPendingVerification });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [remark, setRemark] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const selectedRow = queueQuery.data?.find((row) => String(row['id']) === selectedId) ?? null;

  const mutation = useMutation({
    mutationFn: (fn: () => Promise<CommandOutcomeView>) => fn(),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) {
        setSelectedId(null);
        queryClient.invalidateQueries({ queryKey: ['reports'] });
      }
    },
    onError: (error) => setOutcome(errorOutcomeOf(error)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('verify.title')}</CardTitle>
        <CardDescription>{t('verify.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <QueryState
          isPending={queueQuery.isPending}
          error={queueQuery.error}
          isEmpty={queueQuery.data !== undefined && queueQuery.data.length === 0}
          empty={t('verify.empty')}
        >
          <ModuleTable
            columns={queueColumns(t)}
            rows={queueQuery.data ?? []}
            selectedId={selectedId}
            onSelect={(row) => setSelectedId(String(row['id']))}
          />
        </QueryState>
        <div className="grid gap-4 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <div className="flex flex-col gap-2">
            <Label htmlFor="verify-remark">{t('verify.remark-label')}</Label>
            <Input id="verify-remark" value={remark} onChange={(e) => setRemark(e.target.value)} />
          </div>
          <Button
            disabled={mutation.isPending || selectedRow === null}
            onClick={() =>
              selectedRow !== null &&
              mutation.mutate(() =>
                verifyReport(String(selectedRow['id']), selectedRow, remark.trim().length > 0 ? remark.trim() : undefined),
              )
            }
          >
            {t('verify.verify-button')}
          </Button>
          <Button
            variant="outline"
            disabled={mutation.isPending || selectedRow === null}
            onClick={() =>
              selectedRow !== null &&
              mutation.mutate(() =>
                revokeReport(String(selectedRow['id']), selectedRow, remark.trim().length > 0 ? remark.trim() : undefined),
              )
            }
          >
            {t('verify.revoke-button')}
          </Button>
        </div>
        {outcome !== null && <CommandOutcomeHint outcome={outcome} />}
      </CardContent>
    </Card>
  );
}
