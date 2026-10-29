import { PrismaClient } from '@prisma/client';
import { TenantId } from '@smes/business-core';
import { ManufacturingRejected, type ManufacturingStore, type ControlKind, type ControlRecord, type SourceKind, type Data, type QualityLot, type QualityReservation } from '@smes/application';
import { runWithRlsTenant, withRlsTenantSession } from '../rls-session.js';
const TABLES: Record<ControlKind, string> = { schedule: 'mfg_schedules', commitment: 'mfg_commitments', procurement: 'mfg_procurements', restart: 'mfg_restarts', scrap: 'mfg_scraps', engineering: 'mfg_engineering_changes', demand: 'mfg_demands', qualification: 'mfg_qualifications', binding: 'mfg_source_bindings' };
const SOURCES: Record<SourceKind, string> = { report: 'work_reports', item: 'items', warehouse: 'warehouses', workorder: 'work_orders', dispatch: 'dispatch_orders', po: 'purchase_orders', request: 'purchase_requests', nc: 'nonconformities', fault: 'fault_reports', machine: 'equipment_records', tool: 'resources', user: 'users', process: 'process_defs', drawing: 'drawing_revisions', listing: 'listing_lines', routing: 'routings', inspection: 'inspections', release: 'release_facts', account: 'stock_accounts', balance: 'stock_location_balances', movement: 'stock_movements', reservation: 'stock_reservations', shipping: 'shipping_orders', issue: 'issue_records', task: 'issue_tasks' };
function camel(row: Data): Data { return Object.fromEntries(Object.entries(row).map(([k,v]) => [k.replace(/_([a-z])/g, (_,c:string) => c.toUpperCase()), v])); }
function control(row: Data): ControlRecord { const r = camel(row); return { ...r, version: Number(r['objectVersion']) } as unknown as ControlRecord; }
export class PgManufacturingStore implements ManufacturingStore {
  readonly client: PrismaClient;
  constructor(prisma: PrismaClient = new PrismaClient()) { this.client = withRlsTenantSession(prisma); }
  private query<T>(tenant: TenantId, sql: string, ...values: unknown[]): Promise<T> {
    return runWithRlsTenant(tenant, () => this.client.$transaction(() => this.client.$queryRawUnsafe<T>(sql, ...values)));
  }
  async transaction<T>(tenant: TenantId, fn: () => Promise<T>): Promise<T> {
    return runWithRlsTenant(tenant, () => this.client.$transaction(async () => {
      await this.client.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended('mfg-controlled:' || $1,0))", String(tenant));
      return fn();
    }, { maxWait: 20000, timeout: 60000 }));
  }
  async list(tenant: TenantId, kind: ControlKind) { const rows = await this.query<Data[]>(tenant,`SELECT row_to_json(t) AS row FROM "${TABLES[kind]}" t WHERE tenant_id=$1 ORDER BY created_at,id`, String(tenant)); return rows.map((r) => control(r['row'] as Data)); }
  async find(tenant: TenantId, kind: ControlKind, id: string) { return (await this.list(tenant,kind)).find((r) => r.id===id) ?? null; }
  async save(tenant: TenantId, kind: ControlKind, value: ControlRecord, expected: number | null) {
    const table=TABLES[kind]; let n:number;
    if(expected===null) n=await this.client.$executeRawUnsafe(`INSERT INTO "${table}"(id,tenant_id,source_id,state,object_version,data) VALUES($1,$2,$3,$4,1,$5::jsonb) ON CONFLICT DO NOTHING`,value.id,String(tenant),value.sourceId,value.state,JSON.stringify(value.data));
    else n=await this.client.$executeRawUnsafe(`UPDATE "${table}" SET state=$1,data=$2::jsonb,object_version=object_version+1,updated_at=now() WHERE tenant_id=$3 AND id=$4 AND object_version=$5`,value.state,JSON.stringify(value.data),String(tenant),value.id,expected);
    if(n!==1) throw new ManufacturingRejected('单据版本冲突，未产生本次业务变更');
    return (await this.find(tenant,kind,value.id))!;
  }
  async sources(tenant: TenantId, kind: SourceKind): Promise<Data[]> {
    const columns=kind==='user'?'id,tenant_id,username,display_name,active':'*';
    const rows=await this.query<Data[]>(tenant,`SELECT row_to_json(t) AS row FROM (SELECT ${columns} FROM "${SOURCES[kind]}" WHERE tenant_id=$1) t`,String(tenant)); return rows.map((r)=>camel(r['row'] as Data));
  }
  async source(tenant: TenantId, kind: SourceKind, id: string) { return (await this.sources(tenant,kind)).find((r)=>String(r['id'])===id)??null; }
  async roles(tenant: TenantId,userId:string) { const rows=await this.query<{role:string}[]>(tenant,'SELECT role FROM policies WHERE tenant_id=$1 AND kind=\'grant-role\' AND user_id=$2',String(tenant),userId); return rows.map((r)=>r.role); }
  async event(tenant:TenantId,operationId:string,actor:string,kind:string,sourceId:string,payload:Data) {
    const n=await this.client.$executeRawUnsafe('INSERT INTO mfg_control_events(id,tenant_id,operation_id,actor,kind,source_id,payload) VALUES(gen_random_uuid()::text,$1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING',String(tenant),operationId,actor,kind,sourceId,JSON.stringify(payload)); if(n!==1) throw new ManufacturingRejected('该操作已经执行；请读取原单据，不会重复产生副作用');
  }
  async operation(tenant:TenantId,id:string) { const rows=await this.query<{result:Data|null}[]>(tenant,'SELECT result FROM mfg_control_events WHERE tenant_id=$1 AND operation_id=$2',String(tenant),id); return rows[0]?.result??null; }
  async saveResult(tenant:TenantId,id:string,result:Data) { await this.client.$executeRawUnsafe('UPDATE mfg_control_events SET result=$1::jsonb WHERE tenant_id=$2 AND operation_id=$3',JSON.stringify(result),String(tenant),id); }
  async lots(tenant:TenantId) { const rows=await this.query<Data[]>(tenant,'SELECT row_to_json(t) AS row FROM stock_quality_lots t WHERE tenant_id=$1 ORDER BY received_at,id',String(tenant)); return rows.map(r=>camel(r['row'] as Data) as unknown as QualityLot); }
  async saveLot(tenant:TenantId,r:QualityLot) { if(!Number.isFinite(r.quantity)||r.quantity< -1e-8) throw new ManufacturingRejected('质量批次数量不守恒'); await this.client.$executeRawUnsafe('INSERT INTO stock_quality_lots(id,tenant_id,item_id,warehouse_id,location_id,source_kind,source_ref_id,quality_state,quantity,received_at,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::jsonb) ON CONFLICT(id) DO UPDATE SET quality_state=excluded.quality_state,quantity=excluded.quantity,evidence=excluded.evidence,object_version=stock_quality_lots.object_version+1 WHERE stock_quality_lots.tenant_id=excluded.tenant_id',r.id,String(tenant),r.itemId,r.warehouseId,r.locationId,r.sourceKind,r.sourceRefId,r.qualityState,Math.max(0,r.quantity),r.receivedAt,JSON.stringify(r.evidence)); }
  async qualityReservations(tenant:TenantId) { const rows=await this.query<Data[]>(tenant,'SELECT row_to_json(t) AS row FROM stock_quality_reservations t WHERE tenant_id=$1 ORDER BY id',String(tenant)); return rows.map(r=>camel(r['row'] as Data) as unknown as QualityReservation); }
  async saveQualityReservation(tenant:TenantId,r:QualityReservation) { await this.client.$executeRawUnsafe('INSERT INTO stock_quality_reservations(id,tenant_id,reservation_key,lot_id,quantity,remaining) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET remaining=excluded.remaining,object_version=stock_quality_reservations.object_version+1 WHERE stock_quality_reservations.tenant_id=excluded.tenant_id',r.id,String(tenant),r.reservationKey,r.lotId,r.quantity,r.remaining); }
  async qualityEvent(tenant:TenantId,key:string,kind:string,data:Data) { return (await this.client.$executeRawUnsafe('INSERT INTO stock_quality_events(id,tenant_id,source_key,kind,data) VALUES(gen_random_uuid()::text,$1,$2,$3,$4::jsonb) ON CONFLICT(tenant_id,source_key) DO NOTHING',String(tenant),key,kind,JSON.stringify(data)))===1; }
  async qualityEvents(tenant:TenantId) { const rows=await this.query<Data[]>(tenant,'SELECT row_to_json(t) AS row FROM stock_quality_events t WHERE tenant_id=$1 ORDER BY created_at,id',String(tenant)); return rows.map(r=>camel(r['row'] as Data)); }
  async disconnect() { await this.client.$disconnect(); }
}
