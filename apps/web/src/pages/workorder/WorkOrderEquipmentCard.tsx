import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePermissions } from '@refinedev/core';
import { permissionCode, sessionHasPermission, toPermissionCodes } from '@smes/product-ui';
import { listWorkOrderEquipment, defineWorkOrderEquipment } from '../../data/workorderApi';
import { ModuleTable, QueryState } from '../../components/ModuleTable';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

export function WorkOrderEquipmentCard({ workOrderId }: { workOrderId: string }) {
  const client = useQueryClient(); const { data } = usePermissions({});
  const canWrite = sessionHasPermission(toPermissionCodes(data), permissionCode('workorder:write'));
  const query = useQuery({ queryKey: ['workorder', 'equipment', workOrderId], queryFn: () => listWorkOrderEquipment(workOrderId) });
  const [code, setCode] = useState(''); const [name, setName] = useState(''); const [quantity, setQuantity] = useState('1'); const [kind, setKind] = useState<'self-made' | 'purchased'>('self-made');
  const mutation = useMutation({ mutationFn: () => defineWorkOrderEquipment(workOrderId, { code, name, quantity: Number(quantity), kind }), onSuccess: () => { setCode(''); setName(''); void client.invalidateQueries({ queryKey: ['workorder', 'equipment', workOrderId] }); } });
  return <section className="flex flex-col gap-3 rounded-lg border p-4">
    <h3 className="font-medium">工作令设备清单</h3><p className="text-sm text-muted-foreground">这里维护本项目交付的设备。生产清单和装配/电气派工须选择同一工作令内的自制设备。</p>
    <QueryState isPending={query.isPending} error={query.error} isEmpty={query.data?.length === 0} empty="尚无设备，请先新增真实设备再关联生产清单。">
      <ModuleTable columns={[{ key: 'code', label: '设备编码' }, { key: 'name', label: '设备名称' }, { key: 'quantity', label: '设备数量' }, { key: 'kindLabel', label: '类型' }]} rows={(query.data ?? []).map((row) => ({ ...row, kindLabel: row['kind'] === 'self-made' ? '自制' : '外购' }))} />
    </QueryState>
    {canWrite && <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }}>
      <Label>设备编码<Input value={code} onChange={(e) => setCode(e.target.value)} required /></Label>
      <Label>设备名称<Input value={name} onChange={(e) => setName(e.target.value)} required /></Label>
      <Label>设备数量<Input type="number" min="1" step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} required /></Label>
      <Label>设备类型<Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="self-made">自制设备</option><option value="purchased">外购设备</option></Select></Label>
      <Button type="submit" disabled={mutation.isPending || !code.trim() || !name.trim()}>新增设备</Button>
      {mutation.isSuccess && <p role="status" className="text-sm text-emerald-700">设备已新增。</p>}
      {mutation.isError && <p role="alert" className="text-sm text-destructive">{mutation.error.message}</p>}
    </form>}
  </section>;
}
