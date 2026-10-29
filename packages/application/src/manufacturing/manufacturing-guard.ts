import type { TenantId } from '@smes/business-core';
import { ManufacturingRejected, type Data } from './manufacturing-ports.js';
import { ManufacturingService, digest, object, rows } from './manufacturing.service.js';
import { ManufacturingQualityService, type QualityCheckpoint } from './manufacturing-quality.js';
export interface ControlledCheckpoint { quality?: QualityCheckpoint; faults?: Data[]; pos?: Data[]; dispatches?: Data[]; shipments?: Data[] }
/** Only named manufacturing commands join the tenant transaction; ordinary reads and other modules retain their original path. */
export class ManufacturingCommandGuard {
  constructor(readonly control: ManufacturingService, readonly quality: ManufacturingQualityService) {}
  applies(kind: string): boolean { return /^(dispatch\.|report\.|inspection\.|nonconform\.|purchase\.|gap\.|issue\.|stock\.|stocktake\.approve|shipping\.|workorder\.parts\.ship|baseline\.fault\.)/.test(kind); }
  async production(t: TenantId, dispatchId: string, assignee?: unknown): Promise<void> {
    const d = await this.control.source(t, 'dispatch', dispatchId);
    if(d['kind']==='outsourcing') { await this.control.assertUnfrozen(t,d['workOrderId']); return; }
    const s=(await this.control.store.list(t,'schedule')).find(r=>r.sourceId===dispatchId&&r.state==='approved');
    if(!s)throw new ManufacturingRejected('须先由计划提交联合排程并经运营批准生产放行；原派工/开工/报工入口不能绕过');
    if(assignee && assignee!==s.data['operatorId'])throw new ManufacturingRejected('派工人员与批准联合排程不一致');
    await this.control.scheduleChecks(t,s.data,s.id);
  }
  async before(t: TenantId, kind: string, p: Data, id: string): Promise<ControlledCheckpoint> {
    if(kind==='purchase.order.approve.v1')throw new ManufacturingRejected('请在制造控制台完成净额报价、独立财务复核及分流批准；原批准入口不再直接放行');
    if(kind==='purchase.order.issue.v1'){const po=await this.control.source(t,'po',id);await this.control.assertUnfrozen(t,po['workOrderId']);await this.control.assertPurchaseIssue(t,po);}
    if(kind==='dispatch.create.v1')await this.control.assertUnfrozen(t,p['workOrderId']);
    if(['dispatch.assign.v1','dispatch.start.v1','dispatch.transfer.v1'].includes(kind))await this.production(t,id,p['assignee']);
    if(kind==='dispatch.batch-assign.v1')for(const item of rows(p['items']))await this.production(t,String(item['id']),p['assignee']);
    if(kind==='report.submit.v1')await this.production(t,String(p['dispatchId']));
    if(kind==='report.submit-batch.v1')for(const line of rows(p['lines']))await this.production(t,String(line['dispatchId']));
    if(kind==='issue.confirm.v1'){const task=await this.control.source(t,'task',id);const refs=rows(task['triggerRefs']).filter(r=>r['type']==='dispatch-order');if(!refs.length)throw new ManufacturingRejected('任务缺真实派工来源');for(const ref of refs)await this.production(t,String(ref['id']));}
    if(['inspection.judge.v1','inspection.recheck.v1','inspection.concession.v1'].includes(kind)){const i=await this.control.source(t,'inspection',id);await this.control.assertInspectionUnfrozen(t,i,false,p['itemId']);}
    if(kind==='inspection.judge-batch.v1')for(const entry of rows(p['lines'])){const i=await this.control.source(t,'inspection',String(entry['id']??entry['inspectionId']));await this.control.assertInspectionUnfrozen(t,i);}
    if(kind==='nonconform.dispose.v1'&&p['disposal']==='scrap')throw new ManufacturingRejected('报废须有依据的净损失申请并完成工程/品质及必要总经理会签，旧处置入口不能直接报废');
    if(kind==='nonconform.close.v1'){const nc=await this.control.source(t,'nc',id);if(nc['disposal']==='scrap'&&!(await this.control.store.list(t,'scrap')).some(r=>r.sourceId===id&&r.state==='approved')&&!(await this.control.store.list(t,'binding')).some(r=>r.sourceId===id&&r.state==='legacy-scrap'))throw new ManufacturingRejected('缺有效报废会签，不得经关闭入口形成终态');}
    if(kind==='inspection.revoke.v1')await this.quality.assertUnconsumed(t,id);
    if(kind==='inspection.create.v1'&&(p['sourceType']!=null||p['sourceRefId']!=null))await this.control.inspectionWorkOrder(t,p,false,p['itemId']);
    const c: ControlledCheckpoint={};
    if(kind.startsWith('inspection.'))c.quality=await this.quality.capture(t);
    if(kind.startsWith('baseline.fault.'))c.faults=await this.control.store.sources(t,'fault');
    if(kind==='purchase.order.submit.v1')c.pos=await this.control.store.sources(t,'po');
    if(kind==='dispatch.create.v1')c.dispatches=await this.control.store.sources(t,'dispatch');
    if(kind==='shipping.confirm.v1')c.shipments=await this.control.store.sources(t,'shipping');
    return c;
  }
  async after(t: TenantId,u: string,op: string,kind: string,c: ControlledCheckpoint): Promise<void> {
    if(c.quality)await this.quality.after(t,u,op,c.quality);
    if(c.pos)for(const po of await this.control.store.sources(t,'po'))if(!c.pos.some(x=>x['id']===po['id']))await this.control.putBinding(t,'po-origin',String(po['id']),{actor:u,operationId:op,sourceHash:digest(po)});
    if(c.dispatches)for(const d of await this.control.store.sources(t,'dispatch'))if(!c.dispatches.some(x=>x['id']===d['id'])){const version=await this.control.binding(t,'engineering-version',String(d['workOrderId']));await this.control.putBinding(t,'dispatch-version',String(d['id']),{versionLabel:version?.data['versionLabel']??null,versionHash:digest(version?.data??{}),source:d});}
    if(c.faults)for(const f of await this.control.store.sources(t,'fault'))if(!c.faults.some(x=>x['id']===f['id']&&x['objectVersion']===f['objectVersion'])){const r=(await this.control.store.list(t,'restart')).find(x=>x.sourceId===f['id']);const data={faultVersion:f['objectVersion'],equipmentCode:f['equipmentCode'],signatures:[],repairState:f['state'],updatedBy:u};if(r)await this.control.update(t,'restart',r,'awaiting-signatures',data);else await this.control.create(t,'restart',String(f['id']),'awaiting-signatures',data);}
    if(c.shipments)for(const ship of await this.control.store.sources(t,'shipping'))if(ship['state']==='shipped'&&!c.shipments.some(x=>x['id']===ship['id']&&x['state']==='shipped')){
      const commitment=(await this.control.store.list(t,'commitment')).find(r=>r.sourceId===ship['workOrderId']);if(!commitment)continue;const when=String(ship['confirmedAt']);const delivery={shipmentId:ship['id'],confirmedAt:when,lines:ship['lines'],lateAgainstOriginal:when>String(commitment.data['originalCommittedAt']),lateAgainstCurrent:when>String(commitment.data['committedAt']),promiseVersion:commitment.version};await this.control.update(t,'commitment',commitment,'published',{...commitment.data,deliveries:[...rows(commitment.data['deliveries']),delivery],everLate:commitment.data['everLate']===true||delivery.lateAgainstOriginal||delivery.lateAgainstCurrent});
    }
    void kind;void object;
  }
}
