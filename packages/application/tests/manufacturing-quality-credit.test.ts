import {describe,it,expect,vi} from 'vitest';
import {TenantId} from '@smes/business-core';
import {ManufacturingService,digest} from '../src/manufacturing/manufacturing.service.js';
import {ManufacturingQualityService} from '../src/manufacturing/manufacturing-quality.js';
import type {Data,SourceKind,ManufacturingStore} from '../src/manufacturing/manufacturing-ports.js';
const t=TenantId.create('qa-credit-test');
function setup(){
 const inspection:Data={id:'iq',state:'passed',itemId:'item',quantity:5,passedQty:5,sourceType:'dispatch',sourceRefId:'dsp'};
 const moves:Data[]=[{id:'a',kind:'inspection-in',sourceRefId:'iq',warehouseId:'a',quantity:3},{id:'b',kind:'inspection-in',sourceRefId:'iq',warehouseId:'b',quantity:1},{id:'transfer',kind:'transfer-in',sourceRefId:'iq',quantity:20},{id:'rollback',kind:'production-in',sourceRefId:'iq',quantity:20}];
 const events:Data[]=[{sourceKey:'movement:a',kind:'receive',data:{inspectionId:'iq',quantity:3}},{sourceKey:'movement:b',kind:'receive',data:{inspectionId:'iq',quantity:1}}];
 const sources:Partial<Record<SourceKind,Data[]>>={inspection:[inspection],item:[{id:'item',active:true}],dispatch:[{id:'dsp',workOrderId:'wo'}],workorder:[{id:'wo'}],release:[{inspectionId:'iq',itemId:'item',quantity:5},{inspectionId:'iq',itemId:'item',quantity:5}],movement:moves};
 const store={transaction:async(_t:TenantId,fn:()=>Promise<unknown>)=>fn(),source:async(_t:TenantId,k:SourceKind,id:string)=>sources[k]?.find(r=>r['id']===id)??null,sources:async(_t:TenantId,k:SourceKind)=>sources[k]??[],list:async()=>[],qualityEvents:async()=>events} as unknown as ManufacturingStore;
 return{quality:new ManufacturingQualityService(store,new ManufacturingService(store)),events,inspection,moves};
}
describe('current inspection credit is not a sum of judgment history',()=>{
 it('caps by current passed quantity across warehouses and does not double count movement audit or rollback/transfer',async()=>{const {quality,events}=setup();expect(await quality.consumedInspection(t,'iq')).toBe(4);expect(await quality.remainingInspection(t,'iq')).toBe(1);await expect(quality.release(t,'qc','op',{kind:'inspection',inspectionId:'iq',itemId:'item',warehouseId:'a',quantity:2})).rejects.toThrow('当前有效');await expect(quality.release(t,'qc','op',{kind:'inspection',inspectionId:'iq',itemId:'item',warehouseId:'a',quantity:1})).resolves.toBeNull();events.push({kind:'release',data:{inspectionId:'iq',quantity:1}});expect(await quality.consumedInspection(t,'iq')).toBe(5);expect(await quality.remainingInspection(t,'iq')).toBe(0);});
 it('refuses any-source partial-consumption judgment rollback',async()=>{const {quality}=setup();await expect(quality.assertUnconsumed(t,'iq')).rejects.toThrow('部分入仓');});
 it('returns the original operation receipt before zero-credit checks, but rejects changed payload',async()=>{const {quality,events,inspection}=setup();inspection['passedQty']=4;const payload={commandKind:'stock.receive.v1',kind:'inspection',inspectionId:'iq',itemId:'item',warehouseId:'a',quantity:3};const response={status:'committed',newRevision:1,events:[],movement:{id:'original-movement'},stockLevel:{itemId:'item',warehouseId:'a',availableQty:3}};events.push({sourceKey:'inspection-reply:original',kind:'inspection-reply',data:{requestHash:digest(payload),payload,response}});const action=vi.fn(async()=>{throw new Error('must not issue again');});expect(await quality.run(t,'wh','original',payload,action)).toEqual({...response,duplicate:true});expect(action).not.toHaveBeenCalled();await expect(quality.run(t,'wh','original',{...payload,quantity:1},action)).rejects.toThrow('同操作键');});
});
