import type { TenantId } from '@smes/business-core';
export type ControlKind = 'schedule' | 'commitment' | 'procurement' | 'restart' | 'scrap' | 'engineering' | 'demand' | 'qualification' | 'binding';
export type SourceKind = 'report' | 'item' | 'warehouse' | 'workorder' | 'dispatch' | 'po' | 'request' | 'nc' | 'fault' | 'machine' | 'tool' | 'user' | 'process' | 'drawing' | 'listing' | 'routing' | 'inspection' | 'release' | 'account' | 'balance' | 'movement' | 'reservation' | 'shipping' | 'issue' | 'task';
export type Data = Record<string, unknown>;
export interface ControlRecord { id: string; tenantId: string; sourceId: string; state: string; version: number; data: Data; createdAt: string; updatedAt: string }
export type QualityState = 'pending' | 'qualified' | 'quarantine' | 'unknown';
export interface QualityLot { id: string; tenantId: string; itemId: string; warehouseId: string; locationId: string | null; sourceKind: string; sourceRefId: string; qualityState: QualityState; quantity: number; receivedAt: string; evidence: Data }
export interface QualityReservation { id: string; reservationKey: string; lotId: string; quantity: number; remaining: number }
export interface ManufacturingStore {
  transaction<T>(tenant: TenantId, fn: () => Promise<T>): Promise<T>;
  list(tenant: TenantId, kind: ControlKind): Promise<ControlRecord[]>;
  find(tenant: TenantId, kind: ControlKind, id: string): Promise<ControlRecord | null>;
  save(tenant: TenantId, kind: ControlKind, value: ControlRecord, expected: number | null): Promise<ControlRecord>;
  sources(tenant: TenantId, kind: SourceKind): Promise<Data[]>;
  source(tenant: TenantId, kind: SourceKind, id: string): Promise<Data | null>;
  roles(tenant: TenantId, userId: string): Promise<string[]>;
  event(tenant: TenantId, operationId: string, actor: string, kind: string, sourceId: string, payload: Data): Promise<void>;
  operation(tenant: TenantId, operationId: string): Promise<Data | null>;
  saveResult(tenant: TenantId, operationId: string, result: Data): Promise<void>;
  lots(tenant: TenantId): Promise<QualityLot[]>;
  saveLot(tenant: TenantId, lot: QualityLot): Promise<void>;
  qualityReservations(tenant: TenantId): Promise<QualityReservation[]>;
  saveQualityReservation(tenant: TenantId, value: QualityReservation): Promise<void>;
  qualityEvent(tenant: TenantId, sourceKey: string, kind: string, data: Data): Promise<boolean>;
  qualityEvents(tenant: TenantId): Promise<Data[]>;
}
export interface ManufacturingActions {
  execute(tenant: TenantId, actor: string, module: 'listing' | 'dispatch' | 'inspection', kind: string, payload: Data, id: string, revision: number): Promise<Data>;
}
export class ManufacturingRejected extends Error {}
export class ManufacturingAccessError extends Error {}
