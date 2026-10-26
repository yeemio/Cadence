import sys,json,uuid,re,subprocess; sys.path.insert(0,'/workspace/retest-541ffff/scripts'); from lib import *
T='tenant-a'; R=[]; tag='rt'+uuid.uuid4().hex[:6]
A,_=login(T,'admin'); V,_=login(T,'viewer'); P,_=login(T,'approver')
def rec(mod,i,desc,req,exp,c,j,s,ok,u='admin',ref=None):
    R.append(dict(mod=mod,id=i,desc=desc,u=u,req=req,exp=exp,act=c,ok=bool(ok),ref=ref,body=s[:300])); print(('PASS' if ok else 'FAIL'),i,c,s[:160].replace('\n',' '))
def cmd(p,kind,payload,rev='initial',tok=None): return call(T,tok or A,'POST',p,env(kind,payload,rev))
def committed(c,j): return c==201 and (j or {}).get('status')=='committed'
# --- processes / routing
for code in [f'{tag}-PRE',f'{tag}-FIN']:
    c,j,s=cmd('/baseline/processes/commands','baseline.process.define.v1',{'code':code,'name':'复测工序'+code}); rec('baseline','BL-P1','定义工序 '+code,'POST /baseline/processes/commands','201 committed',c,j,s,committed(c,j))
DWG=f'{tag}-DWG'
c,j,s=cmd('/baseline/routings/commands','baseline.routing.define.v1',{'drawingNo':DWG,'name':'复测路线','steps':[{'processCode':f'{tag}-PRE'},{'processCode':f'{tag}-FIN'}]}); rec('baseline','BL-R1','定义工艺路线','POST /baseline/routings/commands','201 committed',c,j,s,committed(c,j))
# --- D-8 #1 work order
c,j,s=cmd('/workorder/work-orders','workorder.create.v1',{'projectName':'复测项目'+tag}); rec('workorder','WO-01','建工作令(D-8)','POST /workorder/work-orders','201 committed',c,j,s,committed(c,j),ref='D-8')
wo=(j or {}).get('workOrder',{}); WID=wo.get('id','x')
c,j,s=cmd('/workorder/work-orders','workorder.create.v1',{'projectName':'复测项目2'+tag}); rec('workorder','WO-02','建第二张工作令(D-8)','POST /workorder/work-orders','201 committed',c,j,s,committed(c,j),ref='D-8')
c,j,s=call(T,A,'GET',f'/workorder/work-orders/{WID}'); rec('workorder','WO-07','按 id 查工作令','GET /workorder/work-orders/:id','200',c,j,s,c==200)
wov=((j or {}).get('workOrder') or j or {}).get('objectVersion',1)
c,j,s=cmd(f'/workorder/work-orders/{WID}/attachments','workorder.attach.v1',{'name':'att1','kind':'drawing','ref':DWG+'@v1'},wov); rec('workorder','WO-08','工作令挂附件','POST /workorder/work-orders/:id/attachments','201 committed',c,j,s,committed(c,j))
c,j,s=cmd(f'/workorder/work-orders/{WID}/attachments','workorder.attach.v1',{'name':'att2','kind':'drawing','ref':DWG+'@v1'},wov); rec('workorder','WO-09','旧版本号重复挂附件(乐观锁)','POST /workorder/work-orders/:id/attachments','409 或 201+rejected',c,j,s,c==409 or (c==201 and (j or {}).get('status')=='rejected'))
c,j,s=call(T,A,'GET','/workorder/work-orders/not-a-uuid'); rec('workorder','D7-1','非 UUID 工作令 id','GET /workorder/work-orders/not-a-uuid','404',c,j,s,c==404,ref='D-7')
c,j,s=call(T,A,'GET','/baseline/material-validations/abc'); rec('baseline','BL-02','非 UUID 物料校验 id(D-7)','GET /baseline/material-validations/abc','404',c,j,s,c==404,ref='D-7')
for p in ['/masterdata/items/abc','/inspection/orders/abc','/reports/abc','/dispatch/orders/abc','/purchase/orders/abc','/approval/cases/abc']:
    c,j,s=call(T,A,'GET',p); rec('misc','D7-x','非 UUID id: '+p,'GET '+p,'404 (非 5xx)',c,j,s,c in(400,404),ref='D-7')
# --- listing
c,j,s=cmd('/listing/imports','listing.import.v1',{'source':'workorder','workOrderId':WID}); rec('listing','LS-01','清单骨架导入','POST /listing/imports','201 committed',c,j,s,committed(c,j))
c,j,s=cmd('/listing/imports','listing.import.v1',{'source':'excel','workOrderId':WID,'kind':'part','excel':{'kind':'json-tables','sheets':[{'name':'零件清单','header':['图号','物料编码','物料名称','需求数量','需求日期'],'rows':[[DWG,'MAT-'+tag,'复测物料','10','2026-11-30']]}]}}); rec('listing','LS-01b','Excel 零件清单行导入','POST /listing/imports','201 committed',c,j,s,committed(c,j))
c,j,s=call(T,A,'GET',f'/listing/sheets?workOrderId={WID}'); rec('listing','LS-03','按工作令查四类清单','GET /listing/sheets?workOrderId=','200 含 part',c,j,s,c==200 and any(x.get('kind')=='part' for x in (j or {}).get('sheets',[])))
# --- D-8 #3 / RP / D-9
c,j,s=cmd('/dispatch/orders','dispatch.create.v1',{'workOrderId':WID,'kind':'part','drawingNo':DWG,'operationCode':f'{tag}-PRE','quantity':10}); rec('dispatch','DP-01','零件派工(前道 10)','POST /dispatch/orders','201 committed',c,j,s,committed(c,j))
d=(j or {}).get('dispatchOrder',{})
c,j,s=cmd(f"/dispatch/orders/{d.get('id')}/assign",'dispatch.assign.v1',{'assignee':'user-seed-admin-a','remark':None},d.get('objectVersion',1)); rec('dispatch','DP-02','派工 assign','POST /dispatch/orders/:id/assign','201 committed',c,j,s,committed(c,j))
c,j,s=cmd('/dispatch/orders','dispatch.create.v1',{'workOrderId':WID,'kind':'part','drawingNo':DWG,'operationCode':'UNDEFINED-OP-'+tag,'quantity':3}); dz=(j or {}).get('dispatchOrder',{}); 
if dz: cmd(f"/dispatch/orders/{dz['id']}/assign",'dispatch.assign.v1',{'assignee':'user-seed-admin-a','remark':None},dz['objectVersion'])
rec('dispatch','DP-G1','未定义工序派工（新闸门）','POST /dispatch/orders','201 committed 或 rejected(工序库)',c,j,s,c==201)
if dz:
    c,j,s=cmd('/reports','report.submit.v1',{'dispatchId':dz['id'],'doneQty':1,'laborMinutes':10}); rec('reporting','RP-G1','未定义工序报工被闸门拒','POST /reports','201+rejected 含"工序不在 baseline 工序库中"',c,j,s,c==201 and (j or {}).get('status')=='rejected' and '工序库' in s)
c,j,s=cmd('/reports','report.submit.v1',{'dispatchId':d.get('id'),'doneQty':6,'laborMinutes':60}); rec('reporting','RP-01','报工 submit 6/10 (D-8)','POST /reports','201 committed',c,j,s,committed(c,j),ref='D-8')
rp=(j or {}).get('report',{})
c,j,s=cmd('/reports','report.submit.v1',{'dispatchId':d.get('id'),'doneQty':5,'laborMinutes':30}); rec('reporting','RP-02','超量报工 6+5>10 (D-9)','POST /reports','201+rejected 含累计超派工',c,j,s,c==201 and (j or {}).get('status')=='rejected' and re.search('累计有效报工.*超过派工数量',s),ref='D-9')
c,j,s=cmd('/reports','report.submit.v1',{'dispatchId':d.get('id'),'doneQty':4,'laborMinutes':30}); rec('reporting','RP-02b','边界报工 6+4=10','POST /reports','201 committed',c,j,s,committed(c,j),ref='D-9')
c,j,s=cmd('/reports','report.submit.v1',{'dispatchId':d.get('id'),'doneQty':1,'laborMinutes':5}); rec('reporting','RP-02c','满额后再报 1','POST /reports','201+rejected',c,j,s,c==201 and (j or {}).get('status')=='rejected',ref='D-9')
c,j,s=cmd(f"/reports/{rp.get('id')}/verify",'report.verify.v1',{},rp.get('objectVersion',1)); rec('reporting','RP-03','报工核查 verify','POST /reports/:id/verify','201 committed',c,j,s,committed(c,j))
c,j,s=cmd(f"/reports/{rp.get('id')}/verify",'report.verify.v1',{},rp.get('objectVersion',1)); rec('reporting','RP-04','旧版本重复核查','POST /reports/:id/verify','409/400 或 201+rejected',c,j,s,c in(400,409) or (c==201 and (j or {}).get('status')=='rejected'))
c,j,s=call(T,A,'GET',f'/hours/work-orders/{WID}'); rec('hours','HR-05','核查后工时入账','GET /hours/work-orders/:id','entryCount>=1',c,j,s,c==200 and (j or {}).get('view',{}).get('entryCount',0)>=1)
# costing
c,j,s=cmd('/costing/models','costing.model.publish.v1',{'code':'standard','name':'复测口径','hourlyRates':{'machining':6000,'assembly':5000,'electrical':6500,'aftercare':5500,'misc':4000},'status':'active'},'initial'); 
if (j or {}).get('status')!='committed':
    cur=[m for m in (call(T,A,'GET','/costing/models')[1] or {}).get('models',[]) if m.get('code')=='standard']
    if cur: c,j,s=cmd('/costing/models','costing.model.publish.v1',{'code':'standard','name':'复测口径','hourlyRates':{'machining':6000,'assembly':5000,'electrical':6500,'aftercare':5500,'misc':4000},'status':'active'},cur[0]['objectVersion'])
rec('costing','CS-02','发布成本口径','POST /costing/models','201 committed',c,j,s,committed(c,j))
c,j,s=cmd('/costing/rebuild','costing.rebuild.v1',{'workOrderId':WID}); rec('costing','CS-03','成本重建','POST /costing/rebuild','201 committed, laborMinor>0',c,j,s,committed(c,j) and (j or {}).get('totals',{}).get('laborMinor',0)>0)
c,j,s=call(T,A,'GET',f'/costing/work-orders/{WID}/summary'); rec('costing','CS-04','成本汇总读回','GET /costing/work-orders/:id/summary','200',c,j,s,c==200)
c,j,s=cmd('/costing/rebuild','costing.rebuild.v1',{'workOrderId':'wo-nope-'+tag}); rec('costing','CS-07','不存在工作令重建','POST /costing/rebuild','201+rejected',c,j,s,c==201 and (j or {}).get('status')=='rejected')
# final-step report -> QC
c,j,s=cmd('/dispatch/orders','dispatch.create.v1',{'workOrderId':WID,'kind':'part','drawingNo':DWG,'operationCode':f'{tag}-FIN','quantity':6}); df=(j or {}).get('dispatchOrder',{})
cmd(f"/dispatch/orders/{df.get('id')}/assign",'dispatch.assign.v1',{'assignee':'user-seed-admin-a','remark':None},df.get('objectVersion',1))
c,j,s=cmd('/reports','report.submit.v1',{'dispatchId':df.get('id'),'doneQty':6,'laborMinutes':60}); rec('reporting','RP-06','末道报工(D-8)','POST /reports','201 committed',c,j,s,committed(c,j),ref='D-8'); rf=(j or {}).get('report',{})
c,j,s=call(T,A,'GET','/inspection/orders?kind=self_outsourced&state=pending'); q=[o for o in (j or {}).get('orders',[]) if o.get('sourceRefId')==rf.get('id')]
rec('inspection','IN-06','末道报工→自制质检单','GET /inspection/orders?kind=self_outsourced','出现 sourceRefId=报工单',c,j,json.dumps(q,ensure_ascii=False),bool(q))
io=q[0] if q else {}
c,j,s=call(T,A,'GET',f"/inspection/orders/{io.get('id','none')}"); rec('inspection','IN-01','按 id 查质检单','GET /inspection/orders/:id','200',c,j,s,c==200)
iov=((j or {}).get('order') or (j or {}).get('inspection') or j or {}).get('objectVersion',io.get('objectVersion',1))
c,j,s=cmd(f"/inspection/orders/{io.get('id')}/judgment",'inspection.judge.v1',{'passedQty':5,'failedQty':5},iov); rec('inspection','IN-02','判定数量超出送检数','POST /inspection/orders/:id/judgment','400 或 201+rejected',c,j,s,c==400 or (c==201 and (j or {}).get('status')=='rejected'))
c,j,s=cmd(f"/inspection/orders/{io.get('id')}/judgment",'inspection.judge.v1',{'passedQty':5,'failedQty':1,'remark':'复测'},iov); rec('inspection','IN-03','质检判定 5 合格 1 不合格','POST /inspection/orders/:id/judgment','201 committed',c,j,s,committed(c,j))
c,j,s=call(T,A,'GET','/inspection/nonconformities'); rec('inspection','IN-05','不合格品清单','GET /inspection/nonconformities','200 且≥1',c,j,s,c==200 and len((j or {}).get('nonconforms',[]))>=1)
# purchase chain D-8 #2
c,j,s=cmd('/purchase/requests','purchase.request.create.v1',{'workOrderId':WID,'kind':'standard','itemId':'item-'+tag,'quantity':8}); rec('purchase','PU-00','建采购申请','POST /purchase/requests','201 committed',c,j,s,committed(c,j)); prq=(j or {}).get('purchaseRequest',{})
c,j,s=cmd('/purchase/orders','purchase.order.submit.v1',{'workOrderId':WID,'supplierRef':'SUP-'+tag,'supplierName':'复测供应商','promisedAt':'2026-11-30T00:00:00.000Z','lines':[{'itemId':'item-'+tag,'quantity':8,'unitPriceMinor':1200}],'requestIds':[prq.get('id')] if prq else [],'buyer':'user-seed-admin-a','remark':None}); rec('purchase','PU-01','采购下单(D-8)','POST /purchase/orders','201 committed',c,j,s,committed(c,j),ref='D-8'); po=(j or {}).get('purchaseOrder',{})
v=po.get('objectVersion',2)
c,j,s=cmd(f"/purchase/orders/{po.get('id')}/approval",'purchase.order.approve.v1',{'remark':'ok'},v); rec('purchase','PU-08','采购审批','POST /purchase/orders/:id/approval','201 committed',c,j,s,committed(c,j)); v=(j or {}).get('purchaseOrder',{}).get('objectVersion',v+1)
c,j,s=cmd(f"/purchase/orders/{po.get('id')}/issue",'purchase.order.issue.v1',{'remark':None},v); rec('purchase','PU-09','采购下发','POST /purchase/orders/:id/issue','201 committed',c,j,s,committed(c,j)); v=(j or {}).get('purchaseOrder',{}).get('objectVersion',v+1)
c,j,s=cmd(f"/purchase/orders/{po.get('id')}/receipts",'purchase.order.receive.v1',{'lines':[{'lineNo':1,'receivedQty':8}],'receiptRef':'RCPT-'+tag},v); rec('purchase','PU-10','采购收货确认','POST /purchase/orders/:id/receipts','201 committed',c,j,s,committed(c,j))
c,j,s=call(T,A,'GET','/inspection/orders?kind=standard_purchase&state=pending'); q=[o for o in (j or {}).get('orders',[]) if o.get('sourceRefId')==f"{po.get('id')}#1"]
rec('inspection','IN-07','收货→采购质检单','GET /inspection/orders?kind=standard_purchase','出现 sourceRefId=订单#1',c,j,json.dumps(q,ensure_ascii=False),bool(q))
# outsourcing D-8 #4
c,j,s=cmd('/dispatch/orders','dispatch.create.v1',{'workOrderId':WID,'kind':'outsourcing','drawingNo':DWG,'operationCode':f'{tag}-PRE','quantity':5,'lines':[{'processCode':f'{tag}-PRE','drawingNo':DWG,'supplierRef':'SUPO-'+tag,'supplierName':'外协厂','quantity':5,'unitPriceMinor':500}]}); rec('dispatch','DP-05','外协派工创建(D-8)','POST /dispatch/orders','201 committed',c,j,s,committed(c,j),ref='D-8'); od=(j or {}).get('dispatchOrder',{})
c,j,s=cmd(f"/dispatch/orders/{od.get('id')}/assign",'dispatch.assign.v1',{'assignee':'user-seed-admin-a','remark':None},od.get('objectVersion',1)); rec('dispatch','DP-06','外协派工 assign(D-8)','POST /dispatch/orders/:id/assign','201 committed',c,j,s,committed(c,j),ref='D-8'); ov=(j or {}).get('dispatchOrder',{}).get('objectVersion',2)
c,j,s=cmd(f"/dispatch/orders/{od.get('id')}/complete",'dispatch.complete.v1',{},ov); rec('dispatch','DP-08','assigned 态直接 complete','POST /dispatch/orders/:id/complete','201+rejected（设计）',c,j,s,c in(201,409,400) and (j or {}).get('status')!='committed')
c,j,s=cmd(f"/dispatch/orders/{od.get('id')}/start",'dispatch.start.v1',{},ov); rec('dispatch','DP-07','外协派工 start','POST /dispatch/orders/:id/start','201 committed',c,j,s,committed(c,j)); ov=(j or {}).get('dispatchOrder',{}).get('objectVersion',ov+1)
c,j,s=cmd(f"/dispatch/orders/{od.get('id')}/complete",'dispatch.complete.v1',{},ov); rec('dispatch','DP-08b','外协派工 complete','POST /dispatch/orders/:id/complete','201 committed',c,j,s,committed(c,j))
c,j,s=call(T,A,'GET','/inspection/orders'); q=[o for o in (j or {}).get('orders',[]) if od.get('id') and od['id'] in str(o.get('sourceRefId'))]
rec('inspection','IN-08','外协完成→回厂质检单','GET /inspection/orders','出现 sourceRefId 含派工单',c,j,json.dumps(q,ensure_ascii=False)[:300],bool(q))
c,j,s=call(T,A,'GET','/outsourcing/lines?supplierRef=SUPO-'+tag); rec('dispatch','DP-09','外协明细按供应商查询','GET /outsourcing/lines?supplierRef=','200',c,j,s,c==200)
# maintenance
c,j,s=cmd('/maintenance/tasks/commands','maintenance.task.create.v1',{'resourceRef':'eq-'+tag,'kind':'repair','assignee':'user-seed-admin-a'}); rec('maintenance','MT-03','建维修任务','POST /maintenance/tasks/commands','201 committed',c,j,s,committed(c,j)); tk=(j or {}).get('task',{})
c,j,s=cmd('/maintenance/tasks/start/commands','maintenance.task.start.v1',{'taskId':tk.get('id')},tk.get('objectVersion',1)); rec('maintenance','MT-04','任务开始','POST /maintenance/tasks/start/commands','201 committed',c,j,s,committed(c,j)); tv=(j or {}).get('task',{}).get('objectVersion',2)
c,j,s=cmd('/maintenance/tasks/complete/commands','maintenance.task.complete.v1',{'taskId':tk.get('id')},tv); rec('maintenance','MT-05','任务完成','POST /maintenance/tasks/complete/commands','201 committed',c,j,s,committed(c,j))
c,j,s=cmd('/maintenance/plans/commands','maintenance.plan.publish.v1',{'planId':'plan-'+tag,'name':'日点检','resourceRef':'eq-'+tag,'cycle':{'kind':'daily'},'checkpoints':[{'checkpointId':'c1','label':'检查','expectation':'ok'}],'upkeepActions':['润滑']}); rec('maintenance','MT-01','发布保养计划','POST /maintenance/plans/commands','201 committed',c,j,s,committed(c,j))
c,j,s=cmd('/maintenance/plans/due-scan/commands','maintenance.plan.due-scan.v1',{'asOf':'2026-12-01T00:00:00.000Z'}); rec('maintenance','MT-02','到期扫描(上轮 indeterminate)','POST /maintenance/plans/due-scan/commands','201 committed',c,j,s,committed(c,j))
# drawing
c,j,s=cmd('/drawing/revisions/commands','drawing.publish.v1',{'drawingId':DWG,'fileRef':'storage://d/v1.pdf','changeNote':'首发','classification':'public'}); rec('drawing','DW-01','发布图纸','POST /drawing/revisions/commands','201 committed',c,j,s,committed(c,j))
c,j,s=call(T,A,'GET',f'/drawing/revisions/{DWG}?clearance=public'); rec('drawing','DW-03','按许可查图纸修订','GET /drawing/revisions/:id?clearance=public','200',c,j,s,c==200)
# metric-pack (上轮 indeterminate)
c,j,s=call(T,A,'GET','/metric-pack/packs'); rec('metric-pack','MP-02','口径包列表','GET /metric-pack/packs','200',c,j,s,c==200)
# notifications / inventory
c,j,s=call(T,A,'POST','/notifications',{'recipient':'user-seed-admin-a','title':'复测通知','source':'qa-retest','body':'hi'}); rec('notifications','NT-01','发通知(source 小写)','POST /notifications','201',c,j,s,c==201)
c,j,s=cmd('/inventory/warehouses','warehouse.define.v1',{'code':'WH-'+tag,'name':'复测仓','locations':[{'code':'L1','name':'库位1'}]}); rec('inventory','IV-01','建仓库(warehouse.define.v1)','POST /inventory/warehouses','201 committed',c,j,s,committed(c,j))
c,j,s=call(T,A,'GET','/inventory/warehouses'); wh=[w for w in (j or {}).get('warehouses',[]) if w.get('code')=='WH-'+tag]
c,j,s=cmd('/inventory/stock/receipts','stock.receive.v1',{'kind':'production','itemId':'item-'+tag,'warehouseId':wh[0]['id'] if wh else None,'locationId':None,'quantity':10,'inspectionId':None,'purchaseOrderId':None,'workOrderId':WID,'receiptKey':None,'remark':None}); rec('inventory','IV-05','生产入库','POST /inventory/stock/receipts','201 committed',c,j,s,committed(c,j))
# approval D-11
c,j,s=call(T,A,'POST','/approval/cases',{'subjectRef':{'type':'item','id':'x-'+tag},'approvers':['user-does-not-exist'],'reason':'复测','title':'D-11'}); rec('approval','AP-D11','不存在审批人','POST /approval/cases','400',c,j,s,c==400,ref='D-11')
c,j,s=call(T,A,'POST','/approval/cases',{'subjectRef':{'type':'item','id':'y-'+tag},'approvers':['user-seed-approver-a'],'reason':'复测','title':'正常'}); rec('approval','AP-01','正常发起审批','POST /approval/cases','201',c,j,s,c==201)
json.dump(R,open('/workspace/retest-541ffff/raw/retest-chain.json','w'),ensure_ascii=False,indent=1)
print('TOTAL',len(R),'PASS',sum(r['ok'] for r in R))
