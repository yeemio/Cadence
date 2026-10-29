import { createHash } from 'node:crypto';
import { randomUUID as uuidv7 } from 'node:crypto';
import type { TenantId } from '@smes/business-core';
import { ManufacturingAccessError, ManufacturingRejected, type ManufacturingStore, type ManufacturingActions, type ControlRecord, type ControlKind, type Data, type SourceKind } from './manufacturing-ports.js';
export function stable(value: unknown): string { return JSON.stringify(value, (_k,v:unknown) => v && typeof v==='object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0)) : v); }
export function digest(v:unknown) { return createHash('sha256').update(stable(v)).digest('hex'); }
export function object(v:unknown): Data { if(!v||typeof v!=='object'||Array.isArray(v)) throw new ManufacturingRejected('载荷须为对象'); return v as Data; }
export function text(p:Data,k:string,max=256):string { const v=p[k]; if(typeof v!=='string'||!v.trim()||v.length>max) throw new ManufacturingRejected(`${k}须填写有效文本`); return v.trim(); }
export function strings(p:Data,k:string):string[] { const v=p[k]; if(!Array.isArray(v)||v.length>200||v.some(x=>typeof x!=='string'||!x.trim())) throw new ManufacturingRejected(`${k}须为真实对象集合`); return [...new Set(v as string[])]; }
export function rows(v:unknown):Data[] { return Array.isArray(v)?v.map(object):[]; }
export function amount(v:unknown):number { if(!Number.isSafeInteger(v)||Number(v)<0) throw new ManufacturingRejected('金额须为明确的非负小币种整数；未知金额不能填0'); return Number(v); }
export function instant(p:Data,k:string):string { const v=text(p,k); if(!Number.isFinite(Date.parse(v))) throw new ManufacturingRejected('时间无效'); return new Date(v).toISOString(); }
export function decimalMinor(q:unknown,price:unknown):number {
  if(typeof q!=='number'||!Number.isFinite(q)||q<=0) throw new ManufacturingRejected('有效采购数量须为正数'); const unit=BigInt(amount(price));
  const [mantissa,expText='0']=String(q).toLowerCase().split('e'); const [whole,frac='']=(mantissa??'').split('.'); let n=BigInt((whole??'')+frac),d=10n**BigInt(frac.length),exp=Number(expText);
  if(exp>=0)n*=10n**BigInt(exp);else d*=10n**BigInt(-exp);
  const result=(n*unit+d/2n)/d;if(result>BigInt(Number.MAX_SAFE_INTEGER))throw new ManufacturingRejected('净额超安全整数范围');return Number(result);
}
export function poContent(po:Data) { return { id:po['id'],workOrderId:po['workOrderId'],supplierRef:po['supplierRef'],supplierName:po['supplierName'],requestIds:po['requestIds'],lines:rows(po['lines']).map(l=>({lineNo:l['lineNo'],itemId:l['itemId'],quantity:l['quantity'],unitPriceMinor:l['unitPriceMinor']})) }; }
const ROLES=['mfg-e01','mfg-e02','mfg-e05','mfg-e07','mfg-e08','mfg-e10','mfg-e13'];
export class ManufacturingService {
  private actions: ManufacturingActions | null=null;
  constructor(readonly store:ManufacturingStore) {}
  bindActions(actions:ManufacturingActions){this.actions=actions;}
  async need(t:TenantId,u:string,roles:string[]) { const held=await this.store.roles(t,u); if(!roles.some(r=>held.includes(r))) throw new ManufacturingAccessError('当前身份没有本流程所需职责；管理员通配权限不替代人员职责映射'); }
  async source(t:TenantId,k:SourceKind,id:string) { const r=await this.store.source(t,k,id);if(!r)throw new ManufacturingRejected('来源不存在或不属于当前租户');return r; }
  async record(t:TenantId,k:ControlKind,id:string,expected:unknown) { const r=await this.store.find(t,k,id);if(!r||r.version!==expected)throw new ManufacturingRejected('单据不存在、跨租户或版本已变化');return r; }
  async create(t:TenantId,k:ControlKind,sourceId:string,state:string,data:Data) { const now=new Date().toISOString();return this.store.save(t,k,{id:`mfg-${uuidv7()}`,tenantId:String(t),sourceId,state,version:1,data,createdAt:now,updatedAt:now},null); }
  update(t:TenantId,k:ControlKind,r:ControlRecord,state:string,data:Data) { return this.store.save(t,k,{...r,state,data},r.version); }
  async frozen(t:TenantId,wo:string) { return (await this.store.list(t,'engineering')).find(r=>r.state==='frozen'&&(r.data['workOrderIds'] as string[]).includes(wo)); }
  async assertUnfrozen(t:TenantId,wo:unknown) { if(typeof wo==='string'&&await this.frozen(t,wo))throw new ManufacturingRejected('工程变更冻结中，此工作令的新派工或放行被拒绝'); }
  async inspectionWorkOrder(t: TenantId, inspection: Data, requireSource = false, proposedItemId?: unknown): Promise<string | null> {
    const type=inspection['sourceType'],ref=inspection['sourceRefId'];
    if(type===null&&ref===null){if(requireSource)throw new ManufacturingRejected('人工检验缺真实来源，不能据此新增受控合格库存放行；须补有依据的真实业务来源');return null;}
    if(typeof ref!=='string'||!ref||!['report','dispatch','receipt'].includes(String(type)))throw new ManufacturingRejected('检验来源不完整，不能核定其工作令与冻结状态');
    let workOrderId:unknown;
    if(type==='report'){
      const report=await this.source(t,'report',ref);const dispatch=await this.source(t,'dispatch',String(report['dispatchId']));
      if(!report['workOrderId']||report['workOrderId']!==dispatch['workOrderId']||report['state']==='revoked')throw new ManufacturingRejected('报工来源与真实派工工作令不一致或已撤销，不能新增质量放行');
      workOrderId=report['workOrderId'];
    }else if(type==='dispatch')workOrderId=(await this.source(t,'dispatch',ref))['workOrderId'];
    else {
      const movements=(await this.store.sources(t,'movement')).filter(m=>m['kind']==='purchase-in'&&m['sourceKey']===ref);
      if(movements.length!==1)throw new ManufacturingRejected('收货检验须唯一对应真实采购入库来源，来源不存在或有歧义');
      const movement=movements[0]!;const itemId=inspection['itemId']??proposedItemId;
      if(movement['sourceRefType']!=='purchase-order'||typeof movement['sourceRefId']!=='string'||(itemId!==undefined&&itemId!==null&&movement['itemId']!==itemId))throw new ManufacturingRejected('收货检验物料与采购入库来源不一致');
      const po=await this.source(t,'po',String(movement['sourceRefId']));
      if(!rows(po['lines']).some(l=>l['itemId']===movement['itemId']&&Number(l['receivedQty'])>=Number(movement['quantity'])))throw new ManufacturingRejected('采购订单没有对应物料的有效实收事实，不能借用收货来源');
      workOrderId=po['workOrderId'];
    }
    if(typeof workOrderId!=='string'||!workOrderId)throw new ManufacturingRejected('检验真实来源未关联工作令，不能核定受控冻结范围');
    await this.source(t,'workorder',workOrderId);return workOrderId;
  }
  async assertInspectionUnfrozen(t: TenantId, inspection: Data, requireSource = false, proposedItemId?: unknown): Promise<void> {
    await this.assertUnfrozen(t,await this.inspectionWorkOrder(t,inspection,requireSource,proposedItemId));
  }
  private async call(t:TenantId,u:string,module:'listing'|'dispatch'|'inspection',kind:string,payload:Data,id:string,revision:number) { if(!this.actions)throw new ManufacturingRejected('业务接线未就绪');const r=await this.actions.execute(t,u,module,kind,payload,id,revision);if(r['status']!=='committed')throw new ManufacturingRejected(String(r['reason']??'源单据拒绝，本次事务全部回滚'));return r; }
  async binding(t:TenantId,kind:string,id:string) { return (await this.store.list(t,'binding')).find(r=>r.data['kind']===kind&&r.sourceId===id)??null; }
  async putBinding(t:TenantId,kind:string,id:string,data:Data) { const r=await this.binding(t,kind,id);return r?this.update(t,'binding',r,'active',{...data,kind}):this.create(t,'binding',id,'active',{...data,kind}); }
  async machineBlocked(t:TenantId,machineCode:string) {
    const faults=(await this.store.sources(t,'fault')).filter(r=>r['equipmentCode']===machineCode);
    for(const fault of faults) { const restart=(await this.store.list(t,'restart')).find(r=>r.sourceId===fault['id']);if(fault['state']!=='resolved'||!restart||restart.state!=='released'||restart.data['faultVersion']!==fault['objectVersion'])return true; }return false;
  }
  async scheduleChecks(t:TenantId,data:Data,excludeId='') {
    const source=await this.source(t,'dispatch',String(data['dispatchId']));await this.assertUnfrozen(t,source['workOrderId']);const currentVersion=await this.binding(t,'engineering-version',String(source['workOrderId']));const boundVersion=await this.binding(t,'dispatch-version',String(source['id']));if(currentVersion&&boundVersion&&boundVersion.data['versionHash']!==digest(currentVersion.data))throw new ManufacturingRejected('派工所用工程版本与当前工作令适用版本不符，请按当前版本新建派工');if(data['engineeringHash']&&data['engineeringHash']!==digest(currentVersion?.data??{}))throw new ManufacturingRejected('工程适用版本已变化，旧排程不能放行');
    if(source['kind']==='outsourcing'||source['workOrderId']!==data['workOrderId']||source['operationCode']!==data['processCode'])throw new ManufacturingRejected('排程须绑定同工作令内部派工及其真实工序');
    const machine=await this.source(t,'machine',String(data['machineId']));const latest=(await this.store.sources(t,'machine')).filter(r=>r['code']===machine['code']).sort((a,b)=>Number(b['objectVersion'])-Number(a['objectVersion']))[0];
    if(machine['status']!=='active'||latest?.['id']!==machine['id'])throw new ManufacturingRejected('生产机台不是当前有效台账版本');
    const tool=await this.source(t,'tool',String(data['toolId']));if(tool['type']!=='tooling'||tool['active']!==true)throw new ManufacturingRejected('工装须来自启用的tooling资源主数据');
    const user=await this.source(t,'user',String(data['operatorId']));if(user['active']!==true)throw new ManufacturingRejected('操作人员已停用');
    const skill=(await this.store.list(t,'qualification')).find(r=>r.sourceId===user['id']&&r.state==='active'&&r.data['processCode']===source['operationCode']&&(!r.data['validUntil']||String(r.data['validUntil'])>=String(data['endsAt'])));
    if(!skill)throw new ManufacturingRejected('操作人员缺少本工序有效技能资格');
    if(await this.machineBlocked(t,String(machine['code'])))throw new ManufacturingRejected('故障设备仍在封锁；维修完成不能替代运营与品质复机会签');
    const a=Date.parse(String(data['startsAt'])),b=Date.parse(String(data['endsAt']));if(!(b>a))throw new ManufacturingRejected('排程结束须晚于开始');
    for(const other of await this.store.list(t,'schedule'))if(other.id!==excludeId&&other.state==='approved'&&Date.parse(String(other.data['startsAt']))<b&&Date.parse(String(other.data['endsAt']))>a){
      const dimensions=[['machineCode',machine['code'],'机台'],['toolId',tool['id'],'工装'],['operatorId',user['id'],'人员']];
      const conflict=dimensions.find(([key,value])=>other.data[String(key)]===value);if(conflict)throw new ManufacturingRejected(`${String(conflict[2])}时窗冲突：${other.id}；草案不会占用正式资源`);
    }
    return {source,machine,tool,user,skill};
  }
  private async demandForLine(t:TenantId,po:Data,line:Data):Promise<ControlRecord|null> {
    const requests:Data[]=[];for(const id of (po['requestIds'] as string[]??[])){const req=await this.source(t,'request',id);if(req['itemId']===line['itemId'])requests.push(req);}
    const canonical=[...new Set(requests.map(r=>r['sourceListingLineId']).filter(v=>typeof v==='string'))];
    if(canonical.length>1)throw new ManufacturingRejected('同订单行关联多个上游需求，须由财务核定真实需求，不能自动洗换来源');
    if(canonical.length===1){const source=await this.source(t,'listing',String(canonical[0]));if(source['itemId']!==line['itemId']||source['workOrderId']!==po['workOrderId'])throw new ManufacturingRejected('上游清单需求与订单物料/工作令不符');const old=(await this.store.list(t,'demand')).find(r=>r.data['listingLineId']===source['id']);return old??this.create(t,'demand',String(source['id']),'verified-source',{listingLineId:source['id'],itemId:line['itemId'],workOrderId:po['workOrderId'],basis:'真实清单行来源；核查快照重建不换需求锚',requestIds:requests.map(r=>r['id']),poLines:[]});}
    return (await this.store.list(t,'demand')).find(r=>(r.data['poLines'] as string[]??[]).includes(`${po['id']}#${line['lineNo']}`)||requests.some(q=>(r.data['requestIds'] as string[]??[]).includes(String(q['id']))))??null;
  }
  async procurementContext(t:TenantId,c:ControlRecord) {
    const po=await this.source(t,'po',c.sourceId);if(c.data['poHash']!==digest(poContent(po)))throw new ManufacturingRejected('PO有效行/价格/来源已改变，旧财务复核与批准失效');
    const prices=rows(c.data['netPrices']);const totals=new Map<string,number>();let total=0;
    for(const line of rows(po['lines'])){const quote=prices.find(q=>q['lineNo']===line['lineNo']);if(!quote||quote['netUnitPriceMinor']===null)throw new ManufacturingRejected('缺明确净单价，净额未知，不能放行');const demand=await this.demandForLine(t,po,line);if(!demand)throw new ManufacturingRejected('手工来源须E13先核定真实需求；采购不能自填分组键');const n=decimalMinor(line['quantity'],quote['netUnitPriceMinor']);totals.set(demand.id,(totals.get(demand.id)??0)+n);total+=n;}
    const cumulative=new Map(totals); const versions:Data[]=[];
    const cases=await this.store.list(t,'procurement');
    for(const otherPo of await this.store.sources(t,'po'))if(otherPo['id']!==po['id']&&['submitted','approved','issued','received'].includes(String(otherPo['state']))) {
      for(const line of rows(otherPo['lines'])) {
        const demand=await this.demandForLine(t,otherPo,line);
        if(!demand||!totals.has(demand.id))continue;
        const other=cases.find(x=>x.sourceId===otherPo['id']);
        if(!other||other.data['poHash']!==digest(poContent(otherPo)))throw new ManufacturingRejected('同规范需求存在未核定的历史/在途净额；须由E13补历史净额核定或采购更新在途报价，不能按0或忽略');
        const quote=rows(other.data['netPrices']).find(q=>q['lineNo']===line['lineNo']);
        if(!quote)throw new ManufacturingRejected('同需求采购行缺净额核定，不能新增放行');
        cumulative.set(demand.id,(cumulative.get(demand.id)??0)+decimalMinor(line['quantity'],quote['netUnitPriceMinor']));
        versions.push({id:other.id,netRevision:other.data['netRevision'],lineNo:line['lineNo'],demandId:demand.id,poHash:other.data['poHash'],netUnitPriceMinor:quote['netUnitPriceMinor']});
      }
    }
    if(!Number.isSafeInteger(total)||[...cumulative.values()].some(n=>!Number.isSafeInteger(n)))throw new ManufacturingRejected('累计净额超过安全整数范围，不能精度丢失后放行');
    const entries=[...cumulative].sort(([a],[b])=>a<b?-1:1);
    const anchors=(await this.store.list(t,'demand')).filter(d=>totals.has(d.id)).map(d=>({id:d.id,version:d.version})).sort((a,b)=>a.id<b.id?-1:1);
    return {po,total,groups:entries,route:Math.max(total,...entries.map(([,n])=>n))>10000000?'mfg-e01':'mfg-e02',groupHash:digest({entries,versions:versions.sort((a,b)=>String(a['id']).localeCompare(String(b['id']))),anchors})};
  }

  async assertPurchaseIssue(t:TenantId,po:Data) {
    const c=(await this.store.list(t,'procurement')).find(r=>r.sourceId===po['id']);
    if(!c){const legacy=(await this.store.list(t,'binding')).find(r=>r.sourceId===po['id']&&r.state==='legacy-approved');if(legacy){const raw=object(legacy.data['snapshot']);const norm=Object.fromEntries(Object.entries(raw).map(([k,v])=>[k.replace(/_([a-z])/g,(_,x:string)=>x.toUpperCase()),v]));if(digest(poContent(norm))===digest(poContent(po)))return;}throw new ManufacturingRejected('采购下发缺有效净额分流与独立财务复核，不允许旧入口绕过');}
    const ctx=await this.procurementContext(t,c);if(c.state!=='approved'||c.data['groupHash']!==ctx.groupHash||c.data['approvedRole']!==ctx.route)throw new ManufacturingRejected('累计需求净额或版本变化，须重新独立复核并按当前阈值批准');
  }
  async execute(t:TenantId,u:string,op:string,revision:unknown,kind:string,p:Data):Promise<Data> {
    await this.need(t,u,ROLES);const requestHash=digest({kind,p,revision});const previous=await this.store.operation(t,op);if(previous){if(previous['requestHash']!==requestHash)throw new ManufacturingRejected('同操作键不能用于另一载荷');return {...previous,duplicate:true};}
    let result:ControlRecord;
    if(kind==='mfg.qualification.grant.v1'){
      await this.need(t,u,['mfg-e05']);const user=await this.source(t,'user',text(p,'userId'));const processCode=text(p,'processCode');if(!(await this.store.sources(t,'process')).some(r=>r['code']===processCode&&r['status']==='active'))throw new ManufacturingRejected('技能须关联有效工序');result=await this.create(t,'qualification',String(user['id']),'active',{processCode,basis:text(p,'basis',2000),certifiedBy:u,validUntil:p['validUntil']?instant(p,'validUntil'):null});
    }else if(kind==='mfg.schedule.draft.v1'){
      await this.need(t,u,['mfg-e07','mfg-e02']);const dispatch=await this.source(t,'dispatch',text(p,'dispatchId'));await this.assertUnfrozen(t,dispatch['workOrderId']);if(!dispatch['workOrderId']||dispatch['state']==='done'||dispatch['state']==='cancelled')throw new ManufacturingRejected('派工单无工作令或已终态');const machine=await this.source(t,'machine',text(p,'machineId'));await this.source(t,'tool',text(p,'toolId'));await this.source(t,'user',text(p,'operatorId'));
      result=await this.create(t,'schedule',String(dispatch['id']),'draft',{dispatchId:dispatch['id'],workOrderId:dispatch['workOrderId'],processCode:dispatch['operationCode'],machineId:machine['id'],machineCode:machine['code'],toolId:p['toolId'],operatorId:p['operatorId'],startsAt:instant(p,'startsAt'),endsAt:instant(p,'endsAt'),reason:text(p,'reason',2000),createdBy:u,engineeringHash:digest((await this.binding(t,'engineering-version',String(dispatch['workOrderId'])))?.data??{})});
    }else if(kind==='mfg.schedule.approve.v1'){
      await this.need(t,u,['mfg-e02']);const r=await this.record(t,'schedule',text(p,'id'),revision);if(r.state!=='draft')throw new ManufacturingRejected('仅草案可批准');const ctx=await this.scheduleChecks(t,r.data);if((await this.store.list(t,'schedule')).some(x=>x.id!==r.id&&x.sourceId===r.sourceId&&x.state==='approved'))throw new ManufacturingRejected('该派工已有有效排程；请先取消后改排');
      result=await this.update(t,'schedule',r,'approved',{...r.data,approvedBy:u,approvedAt:new Date().toISOString(),qualificationId:ctx.skill.id});
      if(ctx.source['state']==='draft')await this.call(t,u,'dispatch','dispatch.assign.v1',{assignee:ctx.user['id']},r.sourceId,Number(ctx.source['objectVersion']));else if(ctx.source['state']!=='assigned'||ctx.source['assignee']!==ctx.user['id'])throw new ManufacturingRejected('已执行/人员不符的派工不能重排为另一个人');
    }else if(kind==='mfg.schedule.cancel.v1'){
      await this.need(t,u,['mfg-e02','mfg-e07']);const r=await this.record(t,'schedule',text(p,'id'),revision);const source=await this.source(t,'dispatch',r.sourceId);if(source['state']==='executing'||source['state']==='done')throw new ManufacturingRejected('已经执行的排程不能抹除历史');if(r.state==='cancelled')throw new ManufacturingRejected('已经取消');result=await this.update(t,'schedule',r,'cancelled',{...r.data,cancelledBy:u,cancelReason:text(p,'reason',2000)});
    }else if(kind==='mfg.commitment.publish.v1'){
      await this.need(t,u,['mfg-e02']);const wo=await this.source(t,'workorder',text(p,'workOrderId'));const old=(await this.store.list(t,'commitment')).find(r=>r.sourceId===wo['id']);if(old&&old.version!==revision)throw new ManufacturingRejected('承诺版本已变化');const when=instant(p,'committedAt');const data={...(old?.data??{}),committedAt:when,originalCommittedAt:old?.data['originalCommittedAt']??when,previousCommittedAt:old?.data['committedAt']??null,reason:text(p,'reason',2000),publishedBy:u,publishedAt:new Date().toISOString(),deliveries:old?.data['deliveries']??[]};result=old?await this.update(t,'commitment',old,'published',data):await this.create(t,'commitment',String(wo['id']),'published',data);
    }else if(kind==='mfg.demand.certify.v1'){
      await this.need(t,u,['mfg-e13']);const po=await this.source(t,'po',text(p,'poId'));const lineNo=Number(p['lineNo']);const line=rows(po['lines']).find(l=>l['lineNo']===lineNo);if(!line)throw new ManufacturingRejected('订单行不存在');const existing=await this.demandForLine(t,po,line);if(existing)throw new ManufacturingRejected('来源已绑定真实需求，不得换锚洗掉累计采购');
      const requestIds=[];for(const id of (po['requestIds'] as string[]??[])){const req=await this.source(t,'request',id);if(req['itemId']===line['itemId'])requestIds.push(id);}
      const refs=[`${po['id']}#${lineNo}`];const data={poLines:refs,requestIds,itemId:line['itemId'],workOrderId:po['workOrderId'],basis:text(p,'basis',2000),certifiedBy:u,certifiedAt:new Date().toISOString()};
      if(p['demandId']){const d=await this.sourceDemand(t,text(p,'demandId'));if(d.data['itemId']!==line['itemId'])throw new ManufacturingRejected('同需求关联物料不符');result=await this.update(t,'demand',d,'certified',{...d.data,poLines:[...(d.data['poLines'] as string[]??[]),...refs],requestIds:[...new Set([...(d.data['requestIds'] as string[]??[]),...requestIds])],lastCertification:data});}else result=await this.create(t,'demand',String(po['id']),'certified',data);
    }else if(kind==='mfg.procurement.quote.v1'){
      await this.need(t,u,['mfg-e08']);const po=await this.source(t,'po',text(p,'poId'));if(po['state']==='issued'||po['state']==='received')throw new ManufacturingRejected('已经下发的采购事实不得通过重建审核洗掉来源或金额');const origin=await this.binding(t,'po-origin',String(po['id']));if(!origin)throw new ManufacturingRejected('缺可信采购发起人事实，需先核查来源，不能信客户端buyer字段');
      const netPrices=rows(p['netPrices']);for(const line of rows(po['lines'])){const q=netPrices.find(x=>x['lineNo']===line['lineNo']);if(!q)throw new ManufacturingRejected('每行须明确净单价及依据，原含税价不自动换算');amount(q['netUnitPriceMinor']);text(q,'basis',2000);}
      const old=(await this.store.list(t,'procurement')).find(r=>r.sourceId===po['id']);if(old&&old.version!==revision)throw new ManufacturingRejected('审核单版本已变化');const data={poHash:digest(poContent(po)),netRevision:(Number(old?.data['netRevision'])||0)+1,netPrices,originator:origin.data['actor'],proposedBy:u,proposedAt:new Date().toISOString(),reviewedBy:null,approvedBy:null};result=old?await this.update(t,'procurement',old,'proposed',data):await this.create(t,'procurement',String(po['id']),'proposed',data);
    }else if(kind==='mfg.procurement.historical-net.v1'){
      await this.need(t,u,['mfg-e13']);const po=await this.source(t,'po',text(p,'poId'));
      const legacy=(await this.store.list(t,'binding')).some(r=>r.sourceId===po['id']&&r.state==='legacy-approved');
      if(!legacy&&!['issued','received'].includes(String(po['state'])))throw new ManufacturingRejected('只对已有批准/已发生采购补独立历史净额核定，在途新单须正常报价审核');
      const netPrices=rows(p['netPrices']);for(const line of rows(po['lines'])){const q=netPrices.find(x=>x['lineNo']===line['lineNo']);if(!q)throw new ManufacturingRejected('历史核定须逐行明确净单价');amount(q['netUnitPriceMinor']);text(q,'basis',2000);if(!await this.demandForLine(t,po,line))throw new ManufacturingRejected('须先由E13关联真实规范需求，历史核定不能另换需求锚');}
      if(text(p,'currency',8)!=='CNY')throw new ManufacturingRejected('当前阈值合同使用CNY；其它币种缺明确换算合同，不得静默折算');
      const old=(await this.store.list(t,'procurement')).find(r=>r.sourceId===po['id']);if(old&&old.version!==revision)throw new ManufacturingRejected('历史核定版本已变化');if(old&&old.state!=='historical-net-verified')throw new ManufacturingRejected('已有新流程批准事实不能改写为历史核定');
      const value={poHash:digest(poContent(po)),netRevision:(Number(old?.data['netRevision'])||0)+1,netPrices,currency:'CNY',quantityScope:rows(po['lines']).map(l=>({lineNo:l['lineNo'],orderedQuantity:l['quantity']})),basis:text(p,'basis',2000),certifiedBy:u,certifiedAt:new Date().toISOString(),originalSnapshot:old?.data['originalSnapshot']??poContent(po),priorCertification:old?{version:old.version,data:old.data}:null};
      result=old?await this.update(t,'procurement',old,'historical-net-verified',value):await this.create(t,'procurement',String(po['id']),'historical-net-verified',value);
    }else if(kind==='mfg.procurement.review.v1'){
      await this.need(t,u,['mfg-e13']);const r=await this.record(t,'procurement',text(p,'id'),revision);if(r.data['originator']===u||r.data['proposedBy']===u)throw new ManufacturingRejected('采购发起人/报价人不能独立复核自己的采购');const ctx=await this.procurementContext(t,r);result=await this.update(t,'procurement',r,'reviewed',{...r.data,netTotalMinor:ctx.total,demandTotals:ctx.groups,requiredRole:ctx.route,groupHash:ctx.groupHash,reviewedBy:u,reviewBasis:text(p,'basis',2000),reviewedAt:new Date().toISOString(),approvedBy:null});
    }else if(kind==='mfg.procurement.approve.v1'){
      const r=await this.record(t,'procurement',text(p,'id'),revision);const ctx=await this.procurementContext(t,r);await this.need(t,u,[ctx.route]);if(r.state!=='reviewed'||r.data['groupHash']!==ctx.groupHash)throw new ManufacturingRejected('同需求累计变化或缺独立财务复核，须重新复核');if([r.data['originator'],r.data['proposedBy'],r.data['reviewedBy']].includes(u))throw new ManufacturingRejected('发起/财务复核/批准须为不同自然用户，角色叠加不能替代独立性');
      result=await this.update(t,'procurement',r,'approved',{...r.data,approvedBy:u,approvedRole:ctx.route,approvedAt:new Date().toISOString()});if(ctx.po['state']==='submitted')await this.call(t,u,'listing','purchase.order.approve.v1',{remark:'MFG净额分流与独立财务复核已完成'},r.sourceId,Number(ctx.po['objectVersion']));else if(ctx.po['state']!=='approved')throw new ManufacturingRejected('当前PO状态不能授权下发');
    }else if(kind==='mfg.restart.sign.v1'){
      const r=await this.record(t,'restart',text(p,'id'),revision);const role=text(p,'role');if(!['mfg-e02','mfg-e10'].includes(role))throw new ManufacturingAccessError('复机仅运营与品质职责签署');await this.need(t,u,[role]);const fault=await this.source(t,'fault',r.sourceId);if(fault['state']!=='resolved'||fault['objectVersion']!==r.data['faultVersion'])throw new ManufacturingRejected('须本次维修完成版本，旧签名不能用于新故障/修复版本');const signatures=rows(r.data['signatures']);if(signatures.some(x=>x['role']===role||x['user']===u))throw new ManufacturingRejected('每个职责只能签一次且须独立自然用户');signatures.push({role,user:u,basis:text(p,'basis',2000),at:new Date().toISOString()});result=await this.update(t,'restart',r,signatures.length===2?'released':'awaiting-signatures',{...r.data,signatures});
    }else if(kind==='mfg.scrap.request.v1'){
      await this.need(t,u,['mfg-e10']);const nc=await this.source(t,'nc',text(p,'ncId'));if(nc['state']!=='open')throw new ManufacturingRejected('仅未处置NC可申请报废');const old=(await this.store.list(t,'scrap')).find(r=>r.sourceId===nc['id']);if(old&&old.version!==revision)throw new ManufacturingRejected('报废申请版本已变化');const data={ncHash:digest(nc),ncVersion:nc['objectVersion'],reason:text(p,'reason',2000),netLossMinor:amount(p['netLossMinor']),lossBasis:text(p,'lossBasis',2000),requestedBy:u,signatures:[]};result=old?await this.update(t,'scrap',old,'requested',data):await this.create(t,'scrap',String(nc['id']),'requested',data);
    }else if(kind==='mfg.scrap.sign.v1'){
      const r=await this.record(t,'scrap',text(p,'id'),revision);const nc=await this.source(t,'nc',r.sourceId);if(nc['state']!=='open'||digest(nc)!==r.data['ncHash'])throw new ManufacturingRejected('NC或报废申请源版本已变化，旧审批不能形成报废终态');const required=Number(r.data['netLossMinor'])>5000000?['mfg-e05','mfg-e10','mfg-e01']:['mfg-e05','mfg-e10'];const role=text(p,'role');if(!required.includes(role))throw new ManufacturingAccessError('此职责不在本单报废会签链');await this.need(t,u,[role]);const signatures=rows(r.data['signatures']);if(signatures.some(x=>x['role']===role||x['user']===u))throw new ManufacturingRejected('报废会签须独立人员，不允许同人跨职责签署');signatures.push({role,user:u,basis:text(p,'basis',2000),at:new Date().toISOString()});const complete=required.every(x=>signatures.some(s=>s['role']===x));result=await this.update(t,'scrap',r,complete?'approved':'requested',{...r.data,signatures});if(complete)await this.call(t,u,'inspection','nonconform.dispose.v1',{disposal:'scrap',reason:r.data['reason'],remark:`会签批准 ${r.id}；损失依据 ${r.data['lossBasis']}`},r.sourceId,Number(nc['objectVersion']));
    }else if(kind==='mfg.engineering.initialize.v1'){
      await this.need(t,u,['mfg-e05']);const wo=await this.source(t,'workorder',text(p,'workOrderId'));if(await this.binding(t,'engineering-version',String(wo['id'])))throw new ManufacturingRejected('工作令已有适用版本，须走工程变更');const snapshot=await this.engineeringSnapshot(t,String(wo['id']),p);result=await this.putBinding(t,'engineering-version',String(wo['id']),{versionLabel:text(p,'versionLabel',32),snapshot,basis:text(p,'basis',2000),initializedBy:u});
    }else if(kind==='mfg.engineering.freeze.v1'){
      await this.need(t,u,['mfg-e05']);const workOrderIds=strings(p,'workOrderIds');if(!workOrderIds.length)throw new ManufacturingRejected('须指定受影响工作令');const from=text(p,'fromVersion',32),to=text(p,'toVersion',32);if(from===to)throw new ManufacturingRejected('源/目标版本须不同');const snapshots=[];for(const id of workOrderIds){await this.source(t,'workorder',id);await this.assertUnfrozen(t,id);const binding=await this.binding(t,'engineering-version',id);if(binding?.data['versionLabel']!==from)throw new ManufacturingRejected('工作令源适用版本不符');snapshots.push({workOrderId:id,snapshot:await this.engineeringSnapshot(t,id,p),fromBinding:binding.id});}result=await this.create(t,'engineering',workOrderIds[0]!,'frozen',{workOrderIds,fromVersion:from,toVersion:to,snapshots,reason:text(p,'reason',2000),requestedBy:u});
    }else if(kind==='mfg.engineering.approve.v1'){
      await this.need(t,u,['mfg-e02']);const r=await this.record(t,'engineering',text(p,'id'),revision);if(r.state!=='frozen'||r.data['requestedBy']===u)throw new ManufacturingRejected('仅冻结变更可由独立运营人员批准解冻');for(const entry of rows(r.data['snapshots']))await this.putBinding(t,'engineering-version',String(entry['workOrderId']),{versionLabel:r.data['toVersion'],snapshot:entry['snapshot'],engineeringChangeId:r.id,approvedBy:u,basis:text(p,'basis',2000)});result=await this.update(t,'engineering',r,'approved',{...r.data,approvedBy:u,approvedAt:new Date().toISOString(),basis:p['basis']});
    }else throw new ManufacturingRejected('未知制造控制命令');
    await this.store.event(t,op,u,kind,result.id,{requestHash,record:result});const response:Data={status:'committed',newRevision:result.version,record:result,requestHash};await this.store.saveResult(t,op,response);return response;
  }
  private async sourceDemand(t:TenantId,id:string) { const d=await this.store.find(t,'demand',id);if(!d)throw new ManufacturingRejected('需求核定记录不存在或跨租户');return d; }
  private async engineeringSnapshot(t:TenantId,wo:string,p:Data) {
    const listingIds=strings(p,'listingLineIds');const listings=[];for(const id of listingIds){const r=await this.source(t,'listing',id);if(r['workOrderId']!==wo)throw new ManufacturingRejected('清单不是该工作令来源');listings.push(r);}
    const drawings=[];for(const id of strings(p,'drawingRevisionIds')){const r=await this.source(t,'drawing',id);if(!listings.some(l=>l['drawingNo']===r['drawingId']))throw new ManufacturingRejected('图纸版次须属于指定工作令清单的实际图号');drawings.push(r);}const routings=[];for(const id of strings(p,'routingIds')){const r=await this.source(t,'routing',id);if(!listings.some(l=>l['drawingNo']===r['code']))throw new ManufacturingRejected('工艺须属于指定工作令清单的实际图号');routings.push(r);}if(!listings.length||!drawings.length||!routings.length)throw new ManufacturingRejected('须明确实际清单、图纸版次与工艺来源，不得空壳版本');return {listings,drawings,routings};
  }
  async board(t:TenantId,u:string) {
    await this.need(t,u,ROLES);const roles=await this.store.roles(t,u);const financial=roles.some(r=>['mfg-e01','mfg-e02','mfg-e08','mfg-e13'].includes(r));const kinds:ControlKind[]=['schedule','commitment','restart','engineering','qualification','binding',...(financial?['procurement','demand'] as ControlKind[]:[]),...(roles.some(r=>['mfg-e01','mfg-e05','mfg-e10'].includes(r))?['scrap'] as ControlKind[]:[])];const cases:Data={};for(const k of kinds)cases[k]=await this.store.list(t,k);
    cases['binding']=(cases['binding'] as ControlRecord[]??[]).filter(r=>['engineering-version','dispatch-version'].includes(String(r.data['kind']))||(financial&&r.data['kind']==='po-origin'));
    const options:Data={};const sourceKinds:SourceKind[]=['workorder','dispatch','machine','tool','user','process','item',...(roles.some(r=>['mfg-e02','mfg-e10','mfg-e05'].includes(r))?['fault'] as SourceKind[]:[]),...(roles.some(r=>['mfg-e01','mfg-e05','mfg-e10'].includes(r))?['nc'] as SourceKind[]:[]),...(roles.some(r=>['mfg-e02','mfg-e05'].includes(r))?['drawing','listing','routing'] as SourceKind[]:[])];
    for(const k of sourceKinds)options[k]=await this.store.sources(t,k);
    if(financial)options['po']=await this.store.sources(t,'po');return {roles,cases,options};
  }
}
