import type { TenantId } from '@smes/business-core';
import { WorkOrderConflictError } from './workorder-errors.js';

/** 项目设备身份，与车间设备资产分开；数量来自工作令设备清单。 */
export interface WorkOrderEquipment {
  readonly id: string;
  readonly tenant: TenantId;
  readonly workOrderId: string;
  readonly code: string;
  readonly name: string;
  readonly quantity: number;
  readonly kind: 'self-made' | 'purchased';
}
export interface WorkOrderEquipmentStore {
  create(input: WorkOrderEquipment): Promise<WorkOrderEquipment>;
  find(tenant: TenantId, id: string): Promise<WorkOrderEquipment | null>;
  list(tenant: TenantId, workOrderId: string): Promise<readonly WorkOrderEquipment[]>;
}
export class InMemoryWorkOrderEquipmentStore implements WorkOrderEquipmentStore {
  private readonly rows = new Map<string, WorkOrderEquipment>();
  async create(input: WorkOrderEquipment) {
    if ([...this.rows.values()].some((row) => row.tenant === input.tenant && row.workOrderId === input.workOrderId && (row.code === input.code || row.name === input.name))) throw new WorkOrderConflictError('同一工作令的设备编码或名称已存在');
    this.rows.set(`${input.tenant}|${input.id}`, { ...input }); return { ...input };
  }
  async find(tenant: TenantId, id: string) { return this.rows.get(`${tenant}|${id}`) ?? null; }
  async list(tenant: TenantId, workOrderId: string) { return [...this.rows.values()].filter((row) => row.tenant === tenant && row.workOrderId === workOrderId); }
}
