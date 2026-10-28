import { Prisma, PrismaClient } from '@prisma/client';
import { TenantId } from '@smes/business-core';
import { WorkOrderConflictError, type WorkOrderEquipment, type WorkOrderEquipmentStore } from '@smes/application';
export class PgWorkOrderEquipmentStore implements WorkOrderEquipmentStore {
  constructor(private readonly prisma: PrismaClient) {}
  private view(row: { id: string; tenantId: string; workOrderId: string; code: string; name: string; quantity: number; kind: string }): WorkOrderEquipment {
    return { ...row, tenant: TenantId.create(row.tenantId), kind: row.kind as WorkOrderEquipment['kind'] };
  }
  async create(input: WorkOrderEquipment) {
    try { return this.view(await this.prisma.workOrderEquipmentRecord.create({ data: { id: input.id, tenantId: input.tenant, workOrderId: input.workOrderId, code: input.code, name: input.name, quantity: input.quantity, kind: input.kind } })); }
    catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new WorkOrderConflictError('同一工作令的设备编码或名称已存在'); throw error; }
  }
  async find(tenant: TenantId, id: string) { const row = await this.prisma.workOrderEquipmentRecord.findFirst({ where: { tenantId: tenant, id } }); return row ? this.view(row) : null; }
  async list(tenant: TenantId, workOrderId: string) { return (await this.prisma.workOrderEquipmentRecord.findMany({ where: { tenantId: tenant, workOrderId }, orderBy: { code: 'asc' } })).map((row) => this.view(row)); }
}
