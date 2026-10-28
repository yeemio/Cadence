/**
 * 仓库与库位页（S2 批次）：仓库列表 + 建仓库（库位集，第一个为默认库位）+
 * 行选中仓库详情（含库位）。覆盖矩阵 #14 仓库与库位。
 *
 * W10b Round-2 缺陷批：详情白名单中文读面（UX-WH-R2-02，照 W7
 * InspectionDetailView 模式——裸 API 倾倒的英键/locations JSON/ISO 时刻改
 * 结构化字段 + 库位表 + 时刻本地化；白名单省略 tenant 技术键）。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
// i18n 波 2：inventory namespace 绑定（zh-CN 权威源=原页面文案；业务数据与
// 服务端 message 不翻译；namespace 注册与 shell init 由总控统一接线）。
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { defineWarehouse, getWarehouseDetail, listWarehouses } from '../../data/inventoryApi';
import type { CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint, ModuleTable, QueryState } from '../../components/ModuleTable';
import { formatLocalDateTime } from '../../lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// UX-WH-05：移除「启用」列——后端 Warehouse 投影无启用/停用字段（启停语义
// 只存在于货架/货架库位主数据），键恒空渲染 — 造成死列。i18n 波 2 经 t() 取
// inventory namespace warehouses.columns.*。
function listColumns(t: TFunction) {
  return [
    { key: 'id', label: t('warehouses.columns.id'), mono: true },
    { key: 'code', label: t('warehouses.columns.code'), mono: true },
    { key: 'name', label: t('warehouses.columns.name') },
  ];
}

/** 库位表列（详情 locations 数组读面；行数据含 tenant/warehouseId 技术键，列白名单不取）。 */
function locationColumns(t: TFunction) {
  return [
    { key: 'code', label: t('warehouse-detail.location-columns.code'), mono: true },
    { key: 'name', label: t('warehouse-detail.location-columns.name') },
    { key: 'id', label: t('warehouse-detail.location-columns.id'), mono: true },
    { key: 'createdAt', label: t('warehouse-detail.location-columns.created-at'), format: 'datetime' as const },
  ];
}

export function WarehousesPage() {
  const queryClient = useQueryClient();
  const { t } = useTranslation('inventory');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const listQuery = useQuery({ queryKey: ['inventory', 'warehouses'], queryFn: listWarehouses });
  const detailQuery = useQuery({
    queryKey: ['inventory', 'warehouse', selectedId],
    queryFn: () => getWarehouseDetail(selectedId as string),
    enabled: selectedId !== null,
  });

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [locationCode, setLocationCode] = useState('');
  const [locationName, setLocationName] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      defineWarehouse({
        code: code.trim(),
        name: name.trim(),
        locations: [{ code: locationCode.trim(), ...(locationName.trim().length > 0 ? { name: locationName.trim() } : {}) }],
      }),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) {
        queryClient.invalidateQueries({ queryKey: ['inventory', 'warehouses'] });
        setCode('');
        setName('');
        setLocationCode('');
        setLocationName('');
      }
    },
    onError: (error) =>
      setOutcome({
        committed: false,
        status: 'error',
        reason: error instanceof Error ? error.message : String(error),
      }),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('warehouses.title')}</CardTitle>
          <CardDescription>{t('warehouses.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <QueryState
            isPending={listQuery.isPending}
            error={listQuery.error}
            isEmpty={listQuery.data !== undefined && listQuery.data.length === 0}
            empty={t('warehouses.empty')}
          >
            <ModuleTable
              columns={listColumns(t)}
              rows={listQuery.data ?? []}
              selectedId={selectedId}
              onSelect={(row) => setSelectedId(String(row['id']))}
            />
          </QueryState>
        </CardContent>
      </Card>

      {selectedId !== null && (
        <Card>
          <CardHeader>
            <CardTitle>{t('warehouse-detail.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <QueryState isPending={detailQuery.isPending} error={detailQuery.error} isEmpty={false}>
              <WarehouseDetailView detail={detailQuery.data ?? {}} />
            </QueryState>
          </CardContent>
        </Card>
      )}

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>{t('define.title')}</CardTitle>
          <CardDescription>{t('define.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="wh-code">{t('define.code-label')}</Label>
              <Input id="wh-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder={t('define.code-placeholder')} required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="wh-name">{t('define.name-label')}</Label>
              <Input id="wh-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('define.name-placeholder')} required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="wh-loc-code">{t('define.location-code-label')}</Label>
              <Input id="wh-loc-code" value={locationCode} onChange={(e) => setLocationCode(e.target.value)} placeholder={t('define.location-code-placeholder')} required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="wh-loc-name">{t('define.location-name-label')}</Label>
              <Input id="wh-loc-name" value={locationName} onChange={(e) => setLocationName(e.target.value)} />
            </div>
            {outcome !== null && <div className="sm:col-span-2"><CommandOutcomeHint outcome={outcome} /></div>}
            <div className="sm:col-span-2">
              <Button
                type="submit"
                disabled={
                  mutation.isPending ||
                  code.trim().length === 0 ||
                  name.trim().length === 0 ||
                  locationCode.trim().length === 0
                }
              >
                {t('define.submit')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * 仓库详情结构化读面（UX-WH-R2-02，照 W7 InspectionDetailView 白名单+中文
 * 标签模式）。后端详情形状 = Warehouse 投影（inventoryApi fetchObject 解包
 * 'warehouse' 键）：{ id, tenant, code, name, defaultLocationId, locations[],
 * createdAt, updatedAt }；白名单省略 tenant 技术键，locations 数组以库位表
 * 呈现（列白名单取 code/name/id/createdAt），时刻本地化。
 */
function WarehouseDetailView({ detail }: { readonly detail: Record<string, unknown> }) {
  const { t } = useTranslation('inventory');
  const text = (key: string): string => {
    const value = detail[key];
    return value === undefined || value === null ? '' : String(value);
  };
  const datetime = (key: string): string => {
    const raw = text(key);
    return raw.length > 0 ? formatLocalDateTime(raw) : '';
  };
  const locations = Array.isArray(detail['locations'])
    ? (detail['locations'] as readonly Record<string, unknown>[])
    : [];

  const fields = (
    [
      { label: t('warehouse-detail.fields.code'), value: text('code'), mono: true },
      { label: t('warehouse-detail.fields.name'), value: text('name') },
      { label: t('warehouse-detail.fields.id'), value: text('id'), mono: true },
      { label: t('warehouse-detail.fields.default-location'), value: text('defaultLocationId'), mono: true },
      { label: t('warehouse-detail.fields.location-count'), value: locations.length > 0 ? String(locations.length) : '' },
      { label: t('warehouse-detail.fields.created-at'), value: datetime('createdAt') },
      { label: t('warehouse-detail.fields.updated-at'), value: datetime('updatedAt') },
    ] satisfies ReadonlyArray<{ readonly label: string; readonly value: string; readonly mono?: boolean }>
  ).filter((field) => field.value.length > 0);

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[minmax(9rem,auto)_1fr]">
        {fields.map((field) => (
          <div key={field.label} className="contents">
            <dt className="text-xs text-muted-foreground">{field.label}</dt>
            <dd className={field.mono === true ? 'break-all font-mono text-xs' : 'break-all text-xs'}>
              {field.value}
            </dd>
          </div>
        ))}
      </dl>
      {locations.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t('warehouse-detail.locations-heading')}</p>
          <ModuleTable columns={locationColumns(t)} rows={locations} />
        </div>
      )}
    </div>
  );
}
