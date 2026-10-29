import { randomUUID as uuidv7 } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantId } from '@smes/business-core';
import { ManufacturingRejected, type ManufacturingStore, type QualityLot, type QualityState, type Data } from './manufacturing-ports.js';
import { ManufacturingService, text, digest, object, rows } from './manufacturing.service.js';
const EPS=1e-8;
export interface QualityCheckpoint { movements: Data[]; reservations: Data[]; inspections: Data[]; balances: Data[] }
export class ManufacturingQualityService {
  constructor(readonly store:ManufacturingStore,readonly control:ManufacturingService){}
  private readonly scope = new AsyncLocalStorage<boolean>();
  async run<T>(t: TenantId, u: string, op: string, p: Data, action: () => Promise<T>): Promise<T> {
    if (this.scope.getStore()) return action();
    return this.store.transaction(t, () => this.scope.run(true, async () => {
      const inspectionReceipt=p['commandKind']==='stock.receive.v1'&&p['kind']==='inspection';
      if(inspectionReceipt){const replay=await this.replayReceipt(t,op,p);if(replay)return replay as T;}
      const before = await this.capture(t);
      const neutral = inspectionReceipt ? await this.release(t, u, op, p) : null;
      let result = (neutral ?? await action()) as T;
      const outcome = result as Data;
      if (outcome['status'] === 'rejected' || outcome['status'] === 'indeterminate' || outcome['received'] === false || outcome['issued'] === false || outcome['reserved'] === false || outcome['released'] === false) throw new ManufacturingRejected(String(outcome['reason'] ?? outcome['refusedReason'] ?? '库存命令拒绝；整单回滚'));
      await this.after(t, u, op, before);
      const level=outcome['stockLevel'];
      if(level&&typeof level==='object'){const at=level as Data;result={...outcome,stockLevel:(await this.levels(t,String(at['warehouseId']),String(at['itemId'])))[0]} as T;}
      if(inspectionReceipt)await this.store.qualityEvent(t,`inspection-reply:${op}`,'inspection-reply',{requestHash:digest(p),payload:p,response:result});
      return result;
    }));
  }
  private async replayReceipt(t:TenantId,op:string,p:Data):Promise<Data|null> {
    const events=await this.store.qualityEvents(t);const exact=events.find(e=>e['sourceKey']===`inspection-reply:${op}`);
    if(exact){const saved=object(exact['data']);if(saved['requestHash']!==digest(p))throw new ManufacturingRejected('同操作键不能用于不同放行载荷');return {...object(saved['response']),duplicate:true};}
    // Previously committed neutral receipts already carried their immutable request hash.
    const legacy=events.find(e=>e['sourceKey']===`release:${op}`);
    if(legacy){const saved=object(legacy['data']);if(saved['requestHash']!==digest(p))throw new ManufacturingRejected('同操作键不能用于不同放行载荷');return {status:'committed',newRevision:1,events:[],duplicate:true,qualityRelease:saved};}
    if(typeof p['receiptKey']==='string'&&p['receiptKey']){
      const alias=events.find(e=>e['kind']==='inspection-reply'&&object(object(e['data'])['payload'])['receiptKey']===p['receiptKey']);
      if(alias){const saved=object(alias['data']);if(saved['requestHash']!==digest(p))throw new ManufacturingRejected('同收货幂等键不能用于不同放行载荷');await this.store.qualityEvent(t,`inspection-reply:${op}`,'inspection-reply',saved);return {...object(saved['response']),duplicate:true};}
    }
    return null;
  }
  effectiveQuantity(inspection:Data):number {return Math.max(0,Math.min(Number(inspection['passedQty']??0),Number(inspection['quantity'])));}
  async consumedInspection(t:TenantId,id:string):Promise<number> {
    const physical=(await this.store.sources(t,'movement')).filter(m=>m['kind']==='inspection-in'&&m['sourceRefId']===id).reduce((n,m)=>n+Number(m['quantity']),0);
    return physical+await this.receivedInspection(t,id);
  }
  async assertUnconsumed(t:TenantId,id:string):Promise<void> {if(await this.consumedInspection(t,id)>EPS)throw new ManufacturingRejected('仓管已消费此检验放行（含跨仓/部分入仓），不能直接撤销判定；须先按受控流程处理既有库存事实');}
  async remainingInspection(t:TenantId,id:string):Promise<number> {
    const i=await this.control.source(t,'inspection',id);if(i['state']!=='passed'||!i['itemId'])return 0;
    try{await this.control.assertInspectionUnfrozen(t,i,true);}catch(error){if(error instanceof ManufacturingRejected)return 0;throw error;}
    const facts=(await this.store.sources(t,'release')).filter(f=>f['inspectionId']===id);if(!facts.length||facts.some(f=>f['itemId']!==i['itemId']))return 0;
    const credit=Math.max(0,this.effectiveQuantity(i)-await this.consumedInspection(t,id));
    if(i['sourceType']==='receipt'){const pending=(await this.store.lots(t)).filter(l=>l.sourceKind==='purchase'&&l.sourceRefId===i['sourceRefId']&&l.itemId===i['itemId']&&l.qualityState==='pending').reduce((n,l)=>n+l.quantity,0);return Math.min(credit,pending);}
    return credit;
  }
  async availableAt(t: TenantId, warehouseId: string, itemId: string, locationId: string, ownKey?: string | null): Promise<number> {
    const held = await this.store.qualityReservations(t); let total = 0;
    for (const lot of await this.store.lots(t)) if (lot.itemId === itemId && lot.warehouseId === warehouseId && lot.locationId === locationId && lot.qualityState === 'qualified') {
      const other = held.filter(r => r.lotId === lot.id && r.reservationKey !== ownKey).reduce((n,r) => n + r.remaining, 0);
      const own = ownKey ? held.filter(r => r.lotId === lot.id && r.reservationKey === ownKey).reduce((n,r) => n + r.remaining, 0) : Infinity;
      total += Math.max(0, Math.min(lot.quantity - other, own));
    }
    return total;
  }
  async levels(t:TenantId,warehouseId?:string,itemId?:string) {
    const [accounts,lots,held]=await Promise.all([this.store.sources(t,'account'),this.store.lots(t),this.store.qualityReservations(t)]);
    return accounts.filter(a=>(!warehouseId||a['warehouseId']===warehouseId)&&(!itemId||a['itemId']===itemId)).map(a=>{
      const group=lots.filter(l=>l.itemId===a['itemId']&&l.warehouseId===a['warehouseId']);const count=(state:QualityState)=>group.filter(l=>l.qualityState===state).reduce((n,l)=>n+l.quantity,0);
      const ids=new Set(group.filter(l=>l.qualityState==='qualified').map(l=>l.id));const backedReservedQty=held.filter(r=>ids.has(r.lotId)).reduce((n,r)=>n+r.remaining,0);const unbackedReservedQty=Math.max(0,Number(a['qtyReserved'])-backedReservedQty);const effectiveReservedQty=Math.min(count('qualified'),backedReservedQty+unbackedReservedQty);const classified=group.reduce((n,l)=>n+l.quantity,0);
      if(Math.abs(classified-Number(a['qtyOnHand']))>EPS)throw new ManufacturingRejected('物理库存与质量分账不守恒，禁止继续按伪合格可用量操作');
      return {itemId:String(a['itemId']),warehouseId:String(a['warehouseId']),qtyOnHand:Number(a['qtyOnHand']),qtyReserved:Number(a['qtyReserved']),qualifiedQty:count('qualified'),pendingQty:count('pending'),quarantineQty:count('quarantine'),unknownQty:count('unknown'),effectiveReservedQty,unbackedReservedQty,availableQty:Math.max(0,count('qualified')-effectiveReservedQty)};
    });
  }
  async qualifiedReceipt(t:TenantId,key:string) { const events=await this.store.qualityEvents(t);return events.filter(e=>e['kind']==='release'&&object(e['data'])['receiptKey']===key).reduce((n,e)=>n+Number(object(e['data'])['quantity']),0); }
  async receivedInspection(t:TenantId,id:string) { return (await this.store.qualityEvents(t)).filter(e=>e['kind']==='release'&&object(e['data'])['inspectionId']===id).reduce((n,e)=>n+Number(object(e['data'])['quantity']),0); }
  async capture(t:TenantId):Promise<QualityCheckpoint> { return {movements:await this.store.sources(t,'movement'),reservations:await this.store.sources(t,'reservation'),inspections:await this.store.sources(t,'inspection'),balances:await this.store.sources(t,'balance')}; }
  private async split(t:TenantId,lot:QualityLot,qty:number,next:QualityState,evidence:Data):Promise<QualityLot> {
    if(qty>lot.quantity+EPS||qty<0)throw new ManufacturingRejected('质量分账数量超出同批余量');
    if(Math.abs(qty-lot.quantity)<EPS){const changed={...lot,qualityState:next,evidence:{...lot.evidence,...evidence}};await this.store.saveLot(t,changed);return changed;}
    await this.store.saveLot(t,{...lot,quantity:lot.quantity-qty});const created={...lot,id:`ql-${uuidv7()}`,qualityState:next,quantity:qty,evidence:{...lot.evidence,...evidence,parentLotId:lot.id}};await this.store.saveLot(t,created);return created;
  }
  async release(t:TenantId,u:string,op:string,p:Data):Promise<Data|null> {
    if(p['kind']!=='inspection')return null;const id=text(p,'inspectionId');const inspection=await this.control.source(t,'inspection',id);await this.control.assertInspectionUnfrozen(t,inspection,true);if(inspection['state']!=='passed')throw new ManufacturingRejected('须消费有效合格质检事实，不能由入库动作改判');const itemId=text(p,'itemId');if(inspection['itemId']!==itemId)throw new ManufacturingRejected('物料与质检放行锚不一致');const qty=Number(p['quantity']);if(!(qty>0&&Number.isFinite(qty)))throw new ManufacturingRejected('入库数量须为正数');
    const item=await this.control.source(t,'item',itemId);if(item['active']!==true)throw new ManufacturingRejected('物料停用');
    const facts=(await this.store.sources(t,'release')).filter(f=>f['inspectionId']===id);if(!facts.length||facts.some(f=>f['itemId']!==itemId))throw new ManufacturingRejected('放行事实无合法物料，不能消费');
    const consumed=await this.consumedInspection(t,id),credit=this.effectiveQuantity(inspection)-consumed;
    if(qty>credit+EPS)throw new ManufacturingRejected('同检验当前有效放行余量不足；历史重判事实不能叠加额度，跨仓物理入仓与中性放行须合并累计');
    const receiptKey=inspection['sourceType']==='receipt'?String(inspection['sourceRefId']):null;
    if(!receiptKey)return null;
    const warehouseId=text(p,'warehouseId');await this.control.source(t,'warehouse',warehouseId);const candidates=(await this.store.lots(t)).filter(l=>l.sourceKind==='purchase'&&l.sourceRefId===receiptKey&&l.itemId===itemId&&l.warehouseId===warehouseId&&l.qualityState==='pending');if(candidates.reduce((n,l)=>n+l.quantity,0)+EPS<qty)throw new ManufacturingRejected('同批同仓待检余量不足；不得以另一来源或另一仓补放行');
    let remaining=qty;for(const lot of candidates){const n=Math.min(remaining,lot.quantity);if(n>EPS)await this.split(t,lot,n,'qualified',{inspectionId:id,releasedBy:u,releaseOperationId:op});remaining-=n;}
    const data={requestHash:digest(p),inspectionId:id,receiptKey,itemId,warehouseId,quantity:qty,releasedBy:u,physicalDelta:0};await this.store.qualityEvent(t,`release:${op}`,'release',data);
    return {status:'committed',newRevision:1,events:[],qualityRelease:data,stockLevel:(await this.levels(t,warehouseId,itemId))[0]};
  }
  async reconcile(t:TenantId,u:string,op:string,p:Data):Promise<Data> {
    await this.control.need(t,u,['mfg-e10']);const old=(await this.store.qualityEvents(t)).find(e=>e['sourceKey']===`reconcile:${op}`);if(old){if(object(old['data'])['requestHash']!==digest(p))throw new ManufacturingRejected('同核对操作键不能改变载荷');return {status:'committed',duplicate:true,qualityReconciliation:old['data']};}
    const lot=(await this.store.lots(t)).find(l=>l.id===text(p,'lotId'));if(!lot||lot.qualityState!=='unknown'||!['legacy','production'].includes(lot.sourceKind))throw new ManufacturingRejected('只允许对无证历史/手工余额作明确人工质量核对，不能绕过采购来料检');if(lot.locationId===null)throw new ManufacturingRejected('余额缺实际库位来源，须先完成仓库实物定位，不可凭空认定合格批次');const qty=Number(p['quantity']);if(!(qty>0&&qty<=lot.quantity))throw new ManufacturingRejected('核对数量超余量');const state=text(p,'qualityState') as QualityState;if(!['qualified','quarantine'].includes(state))throw new ManufacturingRejected('人工核对须明确合格或隔离');const basis=text(p,'basis',2000),evidenceRef=text(p,'evidenceRef',1000);await this.split(t,lot,qty,state,{verifiedBy:u,basis,evidenceRef});const data={requestHash:digest(p),lotId:lot.id,itemId:lot.itemId,quantity:qty,state,actor:u,basis,evidenceRef};await this.store.qualityEvent(t,`reconcile:${op}`,'reconcile',data);return {status:'committed',qualityReconciliation:data};
  }
  private async classifyInspection(t:TenantId,old:Data|undefined,current:Data) {
    if(current['sourceType']!=='receipt')return;const ref=String(current['sourceRefId']);const lots=(await this.store.lots(t)).filter(l=>l.sourceKind==='purchase'&&l.sourceRefId===ref&&l.itemId===current['itemId']);if(!lots.length)return;
    const desired=current['state']==='pending'?0:Number(current['failedQty']??0);const quarantined=lots.filter(l=>l.qualityState==='quarantine'&&l.evidence['inspectionId']===current['id']).reduce((n,l)=>n+l.quantity,0);let delta=desired-quarantined;
    for(const lot of lots.filter(l=>delta>0?l.qualityState==='pending':l.qualityState==='quarantine'&&l.evidence['inspectionId']===current['id'])){const n=Math.min(Math.abs(delta),lot.quantity);if(n<=EPS)continue;await this.split(t,lot,n,delta>0?'quarantine':'pending',{inspectionId:current['id'],judgmentVersion:current['objectVersion']});delta+=delta>0?-n:n;if(Math.abs(delta)<EPS)break;}
    if(Math.abs(delta)>EPS)throw new ManufacturingRejected('同批质量判定数量与实物余量不符');
    await this.store.qualityEvent(t,`judge:${current['id']}:${current['objectVersion']}`,'classify',{inspectionId:current['id'],receiptKey:ref,failedQty:desired,passedQty:current['passedQty'],state:current['state']});
  }
  async after(t:TenantId,u:string,op:string,before:QualityCheckpoint) {
    const beforeIds=new Set(before.movements.map(m=>String(m['id'])));const moves=(await this.store.sources(t,'movement')).filter(m=>!beforeIds.has(String(m['id']))).sort((a,b)=>Number(a['seq'])-Number(b['seq']));
    const oldRes=new Map(before.reservations.map(r=>[String(r['reservationKey']),r]));const afterRes=await this.store.sources(t,'reservation');const consumption=new Map<string,{lotId:string;quantity:number;qualityState:QualityState}[]>();
    // 原预占的释放与核销以真实余量变化为准；未知旧预占不能被当作合格占用发走。
    for(const r of afterRes){const key=String(r['reservationKey']),old=oldRes.get(key);const decrease=old?Number(old['remaining'])-Number(r['remaining']):0;if(decrease<=EPS)continue;const out=moves.filter(m=>['issue-out','shipping-out'].includes(String(m['kind']))&&m['itemId']===r['itemId']&&m['warehouseId']===r['warehouseId']).reduce((n,m)=>n+Number(m['quantity']),0);const consume=out>0&&r['status']!=='released';const allocations=(await this.store.qualityReservations(t)).filter(a=>a.reservationKey===key&&a.remaining>EPS);if(consume&&allocations.reduce((n,a)=>n+a.remaining,0)+EPS<decrease)throw new ManufacturingRejected('此预占没有同批合格质量依据，不能用历史未知余额核销发料');let left=decrease;
      for(const a of allocations){const n=Math.min(a.remaining,left);await this.store.saveQualityReservation(t,{...a,remaining:a.remaining-n});if(consume){const lot=(await this.store.lots(t)).find(l=>l.id===a.lotId)!;if(lot.qualityState!=='qualified'||lot.quantity+EPS<n)throw new ManufacturingRejected('预占对应批次不再合格');const k=`${lot.itemId}|${lot.warehouseId}`;const parts=consumption.get(k)??[];parts.push({lotId:lot.id,quantity:n,qualityState:lot.qualityState});consumption.set(k,parts);}left-=n;if(left<EPS)break;}
    }
    const transferLots=new Map<string,{lot:QualityLot;quantity:number}[]>();
    for(const m of moves){const kind=String(m['kind']),qty=Number(m['quantity']),item=String(m['itemId']),wh=String(m['warehouseId']);const id=String(m['id']);
      if(['purchase-in','production-in','inspection-in','stocktake-gain'].includes(kind)){
        // 有证的末道/外协入库才合格；手工完工/盘盈默认未知，不能绕过新质量语义。
        let state:QualityState=kind==='purchase-in'?'pending':'unknown';let sourceKind=kind==='purchase-in'?'purchase':'production',sourceRef=String(m['sourceKey']??id);
        if(kind==='inspection-in'){const inspection=await this.control.source(t,'inspection',String(m['sourceRefId']));if(inspection['state']!=='passed'||inspection['itemId']!==item)throw new ManufacturingRejected('物理入仓缺有效同料质量放行');await this.control.assertInspectionUnfrozen(t,inspection,true);if(inspection['sourceType']==='receipt')throw new ManufacturingRejected('采购已收实物批次只能中性转质量状态，不得再次物理增库');if(await this.consumedInspection(t,String(inspection['id']))>this.effectiveQuantity(inspection)+EPS)throw new ManufacturingRejected('同检验跨仓物理入库累计超出当前有效合格量，本次整单回滚');state='qualified';sourceKind='inspection';sourceRef=String(inspection['id']);}
        // 发料撤销仅从已核销流水的质量拆分回补，不能凭手填production备注标合格。
        const reverse = kind==='production-in' && String(m['recordedBy'])==='u-system-wiring-issue' ? await this.reverseOriginal(t,m) : false;
        if(!reverse)await this.store.saveLot(t,{id:`ql-${uuidv7()}`,tenantId:String(t),itemId:item,warehouseId:wh,locationId:typeof m['locationId']==='string'?m['locationId']:null,sourceKind,sourceRefId:sourceRef,qualityState:state,quantity:qty,receivedAt:String(m['occurredAt']),evidence:{movementId:id,actor:u}});
        await this.store.qualityEvent(t,`movement:${id}`,'receive',{movementId:id,itemId:item,warehouseId:wh,quantity:qty,state,sourceRef});
      }else if(['issue-out','shipping-out','transfer-out','stocktake-loss'].includes(kind)){
        const key=`${item}|${wh}`;let left=qty;const split:{lot:QualityLot;quantity:number}[]=[];let reserved=0;
        const currentBalances=await this.store.sources(t,'balance');const byLocation=new Map<string,number>();
        for(const b of before.balances.filter(b=>b['itemId']===item&&b['warehouseId']===wh)){const now=currentBalances.find(a=>a['id']===b['id']);const n=Number(b['qty'])-Number(now?.['qty']??0);if(n>EPS)byLocation.set(String(b['locationId']),n);}
        for(const prior of moves.filter(x=>x!==m&&['issue-out','shipping-out','transfer-out','stocktake-loss'].includes(String(x['kind']))&&x['itemId']===item&&x['warehouseId']===wh)){
          const event=(await this.store.qualityEvents(t)).find(e=>e['sourceKey']===`movement:${prior['id']}`);if(event)for(const a of rows(object(event['data'])['allocations'])){const lot=(await this.store.lots(t)).find(l=>l.id===a['lotId']);if(lot?.locationId)byLocation.set(lot.locationId,(byLocation.get(lot.locationId)??0)-Number(a['quantity']));}
        }
        for(const a of consumption.get(key)??[]){if(left<EPS)break;const lot=(await this.store.lots(t)).find(l=>l.id===a.lotId)!;const locationLeft=byLocation.get(lot.locationId??'')??0;const n=Math.min(left,a.quantity,locationLeft);if(n>EPS){await this.store.saveLot(t,{...lot,quantity:lot.quantity-n});split.push({lot,quantity:n});a.quantity-=n;left-=n;reserved+=n;byLocation.set(lot.locationId!,locationLeft-n);}}

        const held=await this.store.qualityReservations(t);const candidates=(await this.store.lots(t)).filter(l=>l.itemId===item&&l.warehouseId===wh&&l.quantity>EPS&&(byLocation.get(l.locationId??'')??0)>EPS&&(kind==='transfer-out'||kind==='stocktake-loss'||l.qualityState==='qualified')).sort((a,b)=>(kind==='stocktake-loss'?['unknown','pending','quarantine','qualified'].indexOf(a.qualityState)-['unknown','pending','quarantine','qualified'].indexOf(b.qualityState):0)||a.receivedAt.localeCompare(b.receivedAt));
        for(const lot of candidates){const blocked=held.filter(a=>a.lotId===lot.id).reduce((n,a)=>n+a.remaining,0);const take=Math.min(left,Math.max(0,lot.quantity-blocked),byLocation.get(lot.locationId??'')??0);if(take>EPS){await this.store.saveLot(t,{...lot,quantity:lot.quantity-take});split.push({lot,quantity:take});left-=take;byLocation.set(lot.locationId!, (byLocation.get(lot.locationId!)??0)-take);}if(left<EPS)break;}
        if(left>EPS)throw new ManufacturingRejected('同仓/所选库位没有足够合格可用库存；待检、隔离、未知或其它预占不能用于发料');
        if(kind==='transfer-out')transferLots.set(String(m['transferId']),split);await this.store.qualityEvent(t,`movement:${id}`,'deduct',{movementId:id,sourceKey:m['sourceKey'],itemId:item,warehouseId:wh,quantity:qty,reservedConsumedQty:reserved,allocations:split.map(x=>({lotId:x.lot.id,quantity:x.quantity,qualityState:x.lot.qualityState}))});
      }else if(kind==='transfer-in'){
        const split=transferLots.get(String(m['transferId']));if(!split)throw new ManufacturingRejected('调拨质量来源不完整');for(const part of split)await this.store.saveLot(t,{...part.lot,id:`ql-${uuidv7()}`,warehouseId:wh,locationId:typeof m['locationId']==='string'?m['locationId']:null,quantity:part.quantity,evidence:{...part.lot.evidence,transferId:m['transferId'],parentLotId:part.lot.id}});
        await this.store.qualityEvent(t,`movement:${id}`,'transfer',{movementId:id,quantity:qty,transferId:m['transferId']});
      }
    }
    if([...consumption.values()].flat().some(a=>a.quantity>EPS))throw new ManufacturingRejected('预占批次与实际扣减库位不一致，本次整单回滚');
    // 新增预占只能从同仓合格且未占用批次分配，原旧库存/旧预占不回填伪质量。
    for(const r of afterRes){const key=String(r['reservationKey']);if(oldRes.has(key)||r['status']!=='active')continue;let left=Number(r['remaining']);const existing=await this.store.qualityReservations(t);for(const lot of (await this.store.lots(t)).filter(l=>l.itemId===r['itemId']&&l.warehouseId===r['warehouseId']&&l.qualityState==='qualified')){const used=existing.filter(a=>a.lotId===lot.id).reduce((n,a)=>n+a.remaining,0);const n=Math.min(left,Math.max(0,lot.quantity-used));if(n>EPS)await this.store.saveQualityReservation(t,{id:`qr-${uuidv7()}`,reservationKey:key,lotId:lot.id,quantity:n,remaining:n});left-=n;if(left<EPS)break;}if(left>EPS)throw new ManufacturingRejected('预占缺同仓合格余量，待检/隔离/未知不得抵齐套');}
    const oldInspections=new Map(before.inspections.map(i=>[String(i['id']),i]));for(const i of await this.store.sources(t,'inspection')){const old=oldInspections.get(String(i['id']));if(old&&old['objectVersion']!==i['objectVersion']){if(i['state']==='pending'&&old['state']!=='pending')await this.assertUnconsumed(t,String(i['id']));await this.classifyInspection(t,old,i);}}
    // 所有来源路径最终都检查物理/质量守恒；拒绝即外层PG事务整单回滚。
    await this.levels(t);void op;
  }
  private async reverseOriginal(t:TenantId,m:Data):Promise<boolean> {
    // 可信系统撤销来源由原质量扣减事实定位；用户手工入库不会进入此分支。
    const key=String(m['sourceKey']??'');const events=await this.store.qualityEvents(t);const original=events.find(e=>e['kind']==='deduct'&&key===`issue-rb:${String(object(e['data'])['sourceKey'])}`);
    if(!original)return false;const data=object(original['data']);if(Number(data['quantity'])!==Number(m['quantity']))throw new ManufacturingRejected('撤销数量与原质量扣减事实不符');if(events.some(e=>e['sourceKey']===`reverse:${original['id']}`))throw new ManufacturingRejected('此质量出库已经回补，不重复增加库存');
    for(const a of rows(data['allocations'])){const lot=(await this.store.lots(t)).find(l=>l.id===a['lotId']);if(!lot)throw new ManufacturingRejected('原批次不存在，不能伪造合格回补');await this.store.saveLot(t,{...lot,quantity:lot.quantity+Number(a['quantity'])});}
    await this.store.qualityEvent(t,`reverse:${original['id']}`,'reverse',{movementId:m['id'],originalEventId:original['id']});return true;
  }
}
