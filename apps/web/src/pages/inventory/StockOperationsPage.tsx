/**
 * 出入库操作页（S2 批次）：三类入库（质检放行/采购收货/完工入库）+ 出库 +
 * 调拨/移库三组命令表单。覆盖矩阵 #77-80（三源入库 + 标准配件出库）、
 * #82 调拨和移库。
 *
 * W7 UX 缺陷批：成功提示回显流水号（UX-WH-02——committed 回执携带 movement/
 * movements 聚合视图，shortId 短码化显示）；提交后数量保留用户上次输入
 * （UX-WH-06——批量同类收发场景不重置）；三表单补备注字段（UX-WH-07——
 * 载荷后端 stock.receive/issue/transfer.v1 原生支持 remark）。
 *
 * W10b Round-2 缺陷批：成功条流水号补 title 悬停全文（UX-WH-R2-01——短码
 * 之外悬停可读完整单号；页内本地成功条组件，基线文案「操作已生效。」原样
 * 保留为 e2e 断言锚点）。
 */
import { useState, type FormEvent } from 'react';
import { usePermissions } from '@refinedev/core';
import { permissionCode, sessionHasPermission, toPermissionCodes } from '@smes/product-ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
// i18n 波 2：inventory namespace 绑定（zh-CN 权威源=原页面文案；业务数据与
// 服务端 message 不翻译；namespace 注册与 shell init 由总控统一接线）。
import { useTranslation } from 'react-i18next';
import { receiveOptions, issueStock, receiveStock, transferStock } from '../../data/inventoryApi';
import { businessIdsOfOutcome, errorOutcomeOf, type CommandOutcomeView } from '../../data/commandClient';
import { CommandOutcomeHint } from '../../components/ModuleTable';
import { shortId } from '../../lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

/**
 * 本地成功条（UX-WH-R2-01）：committed 且回执带流水号时自绘成功行——短码 +
 * title 悬停完整单号；其余形态（rejected/indeterminate/无流水号回执）走共享
 * CommandOutcomeHint（基线文案「操作已生效。」与未生效文案经 t() 取
 * inventory namespace，zh-CN 原样保留为 e2e 断言锚点）。
 */
function MovementOutcomeHint({ outcome }: { readonly outcome: CommandOutcomeView }) {
  const { t } = useTranslation('inventory');
  const ids = businessIdsOfOutcome(outcome);
  if (outcome.committed && ids.length > 0) {
    return (
      <p className="text-sm text-emerald-600 dark:text-emerald-400">
        {t('operations.success.committed')}
        <span className="text-muted-foreground" title={ids.join('、')}>
          {t('operations.success.movement-ids', { ids: ids.map((id) => shortId(id)).join('、') })}
        </span>
      </p>
    );
  }
  return <CommandOutcomeHint outcome={outcome} />;
}

export function StockOperationsPage() {
  const { data } = usePermissions({});
  const codes = toPermissionCodes(data);
  const allowed = (code: string) => sessionHasPermission(codes, permissionCode(code));
  if (!['stock:receive', 'stock:issue', 'stock:transfer'].some(allowed)) return <p role="note">当前账号没有库存操作权限。</p>;
  return (
    <div className="flex flex-col gap-6">
      {allowed('stock:receive') && <ReceiveCard />}
      {allowed('stock:issue') && <IssueCard />}
      {allowed('stock:transfer') && <TransferCard />}
    </div>
  );
}

function ReceiveCard() {
  const queryClient = useQueryClient();
  const { t } = useTranslation('inventory');
  const options = useQuery({ queryKey: ['inventory', 'receive-options'], queryFn: receiveOptions });
  const [kind, setKind] = useState<'inspection' | 'purchase' | 'production'>('production');
  const [itemId, setItemId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [inspectionId, setInspectionId] = useState('');
  const [receiptKey, setReceiptKey] = useState('');
  const [workOrderId, setWorkOrderId] = useState('');
  const [remark, setRemark] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      receiveStock({
        kind,
        itemId: itemId.trim(),
        warehouseId: warehouseId.trim(),
        quantity: Number(quantity),
        ...(kind === 'inspection' && inspectionId.trim().length > 0 ? { inspectionId: inspectionId.trim() } : {}),
        ...(kind === 'purchase' && receiptKey.trim().length > 0 ? { receiptKey: receiptKey.trim() } : {}),
        ...(workOrderId.trim().length > 0 ? { workOrderId: workOrderId.trim() } : {}),
        ...(remark.trim().length > 0 ? { remark: remark.trim() } : {}),
      }),
    onSuccess: (result) => {
      setOutcome(result);
      // UX-WH-06：数量与各项输入保留上次值（连续同类收发不重置），仅结果提示刷新。
      if (result.committed) { setInspectionId(''); setItemId(''); queryClient.invalidateQueries({ queryKey: ['inventory'] }); }
    },
    onError: (error) => setOutcome(errorOutcomeOf(error)),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{t('operations.receive.title')}</CardTitle>
        <CardDescription>{t('operations.receive.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {options.isError && <p role="alert">入库选项加载失败，请刷新后重试。</p>}
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="recv-kind">{t('operations.receive.kind-label')}</Label>
            <Select id="recv-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="production">{t('operations.receive.kind.production')}</option>
              <option value="inspection">{t('operations.receive.kind.inspection')}</option>
              <option value="purchase">{t('operations.receive.kind.purchase')}</option>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="recv-item">{t('operations.receive.item-label')}</Label>
            <Select id="recv-item" value={itemId} onChange={(e) => setItemId(e.target.value)} disabled={kind === 'inspection'} required>
              <option value="">请选择物料（图号不能代替物料）</option>
              {(options.data?.items ?? []).map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="recv-wh">{t('operations.receive.warehouse-label')}</Label>
            <Select id="recv-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} required>
              <option value="">请选择入库仓库</option>
              {(options.data?.warehouses ?? []).map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.code} · {warehouse.name}</option>)}
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="recv-qty">{t('operations.receive.quantity-label')}</Label>
            <Input id="recv-qty" type="number" min="0.000001" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
          </div>
          {kind === 'inspection' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="recv-inspection">{t('operations.receive.inspection-label')}</Label>
              <Select id="recv-inspection" value={inspectionId} onChange={(e) => {
                const release = options.data?.releases.find((row) => row.id === e.target.value);
                setInspectionId(e.target.value); setItemId(release?.itemId ?? ''); setQuantity(String(release?.remainingQty ?? 1)); setOutcome(null);
              }} required>
                <option value="">请选择可入库的放行单</option>
                {(options.data?.releases ?? []).map((release) => <option key={release.id} value={release.id}>{release.id} · 剩余 {release.remainingQty}</option>)}
              </Select>
              <p className="text-xs text-muted-foreground">仅列出已关联有效物料且尚有余量的放行单；无物料的单据须先由质检岗位处理。</p>
            </div>
          )}
          {kind === 'purchase' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="recv-receipt-key">{t('operations.receive.receipt-key-label')}</Label>
              <Input id="recv-receipt-key" value={receiptKey} onChange={(e) => setReceiptKey(e.target.value)} required />
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="recv-wo">{t('operations.receive.wo-label')}</Label>
            <Input id="recv-wo" value={workOrderId} onChange={(e) => setWorkOrderId(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="recv-remark">{t('operations.receive.remark-label')}</Label>
            <Input id="recv-remark" value={remark} onChange={(e) => setRemark(e.target.value)} />
          </div>
          {outcome !== null && (
            <div className="sm:col-span-2">
              <MovementOutcomeHint outcome={outcome} />
            </div>
          )}
          <div className="sm:col-span-2">
            <Button
              type="submit"
              disabled={
                mutation.isPending ||
                itemId.trim().length === 0 ||
                warehouseId.trim().length === 0 ||
                Number(quantity) <= 0 ||
                (kind === 'inspection' && inspectionId.trim().length === 0) ||
                (kind === 'purchase' && receiptKey.trim().length === 0)
              }
            >
              {t('operations.receive.submit')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function IssueCard() {
  const queryClient = useQueryClient();
  const { t } = useTranslation('inventory');
  const [itemId, setItemId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [purpose, setPurpose] = useState<'production' | 'parts' | 'manual'>('production');
  const [workOrderId, setWorkOrderId] = useState('');
  const [reservationKey, setReservationKey] = useState('');
  const [remark, setRemark] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      issueStock({
        itemId: itemId.trim(),
        warehouseId: warehouseId.trim(),
        quantity: Number(quantity),
        purpose,
        ...(workOrderId.trim().length > 0 ? { workOrderId: workOrderId.trim() } : {}),
        ...(reservationKey.trim().length > 0 ? { reservationKey: reservationKey.trim() } : {}),
        ...(remark.trim().length > 0 ? { remark: remark.trim() } : {}),
      }),
    onSuccess: (result) => {
      setOutcome(result);
      // UX-WH-06：数量与各项输入保留上次值，仅结果提示刷新。
      if (result.committed) queryClient.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (error) => setOutcome(errorOutcomeOf(error)),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{t('operations.issue.title')}</CardTitle>
        <CardDescription>{t('operations.issue.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="issue-item">{t('operations.issue.item-label')}</Label>
            <Input id="issue-item" value={itemId} onChange={(e) => setItemId(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="issue-wh">{t('operations.issue.warehouse-label')}</Label>
            <Input id="issue-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="issue-qty">{t('operations.issue.quantity-label')}</Label>
            <Input id="issue-qty" type="number" min="0.000001" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="issue-purpose">{t('operations.issue.purpose-label')}</Label>
            <Select id="issue-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value as typeof purpose)}>
              <option value="production">{t('operations.issue.purpose.production')}</option>
              <option value="parts">{t('operations.issue.purpose.parts')}</option>
              <option value="manual">{t('operations.issue.purpose.manual')}</option>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="issue-wo">{t('operations.issue.wo-label')}</Label>
            <Input id="issue-wo" value={workOrderId} onChange={(e) => setWorkOrderId(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="issue-reservation">{t('operations.issue.reservation-label')}</Label>
            <Input id="issue-reservation" value={reservationKey} onChange={(e) => setReservationKey(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2 sm:col-span-2">
            <Label htmlFor="issue-remark">{t('operations.issue.remark-label')}</Label>
            <Input id="issue-remark" value={remark} onChange={(e) => setRemark(e.target.value)} />
          </div>
          {outcome !== null && (
            <div className="sm:col-span-2">
              <MovementOutcomeHint outcome={outcome} />
            </div>
          )}
          <div className="sm:col-span-2">
            <Button
              disabled={mutation.isPending || itemId.trim().length === 0 || warehouseId.trim().length === 0 || Number(quantity) <= 0}
            >
              {t('operations.issue.submit')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function TransferCard() {
  const queryClient = useQueryClient();
  const { t } = useTranslation('inventory');
  const [itemId, setItemId] = useState('');
  const [fromWarehouseId, setFromWarehouseId] = useState('');
  const [toWarehouseId, setToWarehouseId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [fromLocationId, setFromLocationId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [remark, setRemark] = useState('');
  const [outcome, setOutcome] = useState<CommandOutcomeView | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      transferStock({
        itemId: itemId.trim(),
        fromWarehouseId: fromWarehouseId.trim(),
        toWarehouseId: toWarehouseId.trim(),
        quantity: Number(quantity),
        ...(fromLocationId.trim().length > 0 ? { fromLocationId: fromLocationId.trim() } : {}),
        ...(toLocationId.trim().length > 0 ? { toLocationId: toLocationId.trim() } : {}),
        ...(remark.trim().length > 0 ? { remark: remark.trim() } : {}),
      }),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.committed) queryClient.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (error) => setOutcome(errorOutcomeOf(error)),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{t('operations.transfer.title')}</CardTitle>
        <CardDescription>{t('operations.transfer.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="tr-item">{t('operations.transfer.item-label')}</Label>
            <Input id="tr-item" value={itemId} onChange={(e) => setItemId(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="tr-qty">{t('operations.transfer.quantity-label')}</Label>
            <Input id="tr-qty" type="number" min="0.000001" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="tr-from-wh">{t('operations.transfer.from-warehouse-label')}</Label>
            <Input id="tr-from-wh" value={fromWarehouseId} onChange={(e) => setFromWarehouseId(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="tr-to-wh">{t('operations.transfer.to-warehouse-label')}</Label>
            <Input id="tr-to-wh" value={toWarehouseId} onChange={(e) => setToWarehouseId(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="tr-from-loc">{t('operations.transfer.from-location-label')}</Label>
            <Input id="tr-from-loc" value={fromLocationId} onChange={(e) => setFromLocationId(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="tr-to-loc">{t('operations.transfer.to-location-label')}</Label>
            <Input id="tr-to-loc" value={toLocationId} onChange={(e) => setToLocationId(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2 sm:col-span-2">
            <Label htmlFor="tr-remark">{t('operations.transfer.remark-label')}</Label>
            <Input id="tr-remark" value={remark} onChange={(e) => setRemark(e.target.value)} />
          </div>
          {outcome !== null && (
            <div className="sm:col-span-2">
              <MovementOutcomeHint outcome={outcome} />
            </div>
          )}
          <div className="sm:col-span-2">
            <Button
              type="submit"
              disabled={
                mutation.isPending ||
                itemId.trim().length === 0 ||
                fromWarehouseId.trim().length === 0 ||
                toWarehouseId.trim().length === 0 ||
                Number(quantity) <= 0
              }
            >
              {t('operations.transfer.submit')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
