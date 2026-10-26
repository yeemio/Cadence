import json,urllib.request,time
Q='qa'+time.strftime('%H%M%S')
T={u:open(f'/tmp/tok_a_{u}').read().strip() for u in ['admin','approver','viewer','demo-admin']}
res=[]
def call(u,m,p,body=None):
    req=urllib.request.Request('http://127.0.0.1'+p,method=m,data=json.dumps(body).encode() if body is not None else None,headers={'Host':'tenant-a.smes.example.com','content-type':'application/json','authorization':'Bearer '+T[u]})
    try:
        with urllib.request.urlopen(req,timeout=20) as r: return r.status,json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e:
        b=e.read(); 
        try: return e.code,json.loads(b)
        except: return e.code,b[:200].decode()
def chk(persona,cid,desc,u,m,p,body,expect):
    s,b=call(u,m,p,body); ok=s in (expect if isinstance(expect,tuple) else (expect,))
    res.append(dict(persona=persona,id=cid,desc=desc,req=f'{m} {p}',expect=expect,actual=s,ok=ok,body=json.dumps(b,ensure_ascii=False)[:180])); return s,b
A='admin';D='demo-admin';P='approver';V='viewer'
# ---- Admin persona: org & config setup
chk('admin','PA-01','创建部门',A,'POST','/org/departments',{'code':Q+'-D1','name':'QA部门'},201)
chk('admin','PA-02','部门 code 重复',A,'POST','/org/departments',{'code':Q+'-D1','name':'重复'},(400,409))
chk('admin','PA-03','部门缺必填 name',A,'POST','/org/departments',{'code':Q+'-D2'},400)
chk('admin','PA-04','创建岗位',A,'POST','/org/positions',{'code':Q+'-P1','name':'QA岗位'},201)
s,b=chk('admin','PA-05','创建角色 qa-clerk',A,'POST','/org/roles',{'name':Q+'-clerk','displayName':'QA文员'},201)
chk('admin','PA-06','给角色授予 customer:read',A,'PUT',f'/org/roles/{Q}-clerk/permissions',{'permissions':['customer:read']},(200,201))
s,b=chk('admin','PA-07','创建用户',A,'POST','/org/users',{'username':Q+'-u1','displayName':'QA用户'},201)
uid=(b or {}).get('id') if isinstance(b,dict) else None
chk('admin','PA-08','用户名重复',A,'POST','/org/users',{'username':Q+'-u1','displayName':'dup'},(400,409))
chk('admin','PA-09','分配角色给用户',A,'PUT',f'/org/users/{uid}/roles',{'roles':[Q+'-clerk']},(200,201))
chk('admin','PA-10','停用用户',A,'PUT',f'/org/users/{uid}/status',{'active':False},(200,201))
chk('admin','PA-11','创建物品',A,'POST','/masterdata/items',{'code':Q+'-I1','name':'QA物品','unit':'pcs'},201)
s,b=call(A,'GET','/masterdata/items'); items=b.get('items',[]) if isinstance(b,dict) else []; iid=next((i['id'] for i in items if i.get('code')==Q+'-I1'),None)
res.append(dict(persona='admin',id='PA-12',desc='列表可见新建物品',req='GET /masterdata/items',expect='含新物品',actual=bool(iid),ok=bool(iid),body=''))
chk('admin','PA-13','物品 code 超长(300)',A,'POST','/masterdata/items',{'code':'X'*300,'name':'n','unit':'pcs'},400)
chk('admin','PA-14','物品空字符串 name',A,'POST','/masterdata/items',{'code':Q+'-I2','name':'','unit':'pcs'},400)
chk('admin','PA-15','创建供应商',A,'POST','/masterdata/suppliers',{'code':Q+'-S1','name':'QA供应商'},201)
chk('admin','PA-16','审批流配置列表',A,'GET','/approval-config/flows',None,200)
chk('admin','PA-17','菜单配置读取',A,'GET','/menu-config/configs',None,200)
chk('admin','PA-18','审计日志可读',A,'GET','/audit/logs',None,200)
# ---- Submitter persona (demo-admin)
s,b=chk('demo-admin(提交人)','PS-01','发起审批案件(引用物品)',D,'POST','/approval/cases',{'subjectRef':{'type':'item','id':iid},'approvers':['user-seed-approver-a'],'title':Q+'样品审批','reason':'请审批'},201)
case1=b.get('case',{}).get('id') if isinstance(b,dict) else None
chk('demo-admin(提交人)','PS-02','空审批人被拒',D,'POST','/approval/cases',{'subjectRef':{'type':'item','id':iid},'approvers':[],'reason':'x'},400)
s,b=chk('demo-admin(提交人)','PS-03','发起第二个案件(用于驳回)',D,'POST','/approval/cases',{'subjectRef':{'type':'item','id':iid},'approvers':['user-seed-approver-a'],'title':Q+'第二件','reason':'再审'},201)
case2=b.get('case',{}).get('id') if isinstance(b,dict) else None
chk('demo-admin(提交人)','PS-04','发起审批:不存在的审批人',D,'POST','/approval/cases',{'subjectRef':{'type':'item','id':iid},'approvers':['no-such-user'],'title':'x','reason':'x'},(400,404,422))
chk('demo-admin(提交人)','PS-05','提交采购申请',D,'POST','/purchase/requests',{'itemId':iid,'qty':5,'reason':Q},(201,400))
# ---- Approver persona
s,b=chk('approver','PP-01','工作台汇总可读',P,'GET','/workbench/summary',None,200)
res[-1]['body']=json.dumps(b,ensure_ascii=False)[:180]
chk('approver','PP-02','待办列表可读',P,'GET','/workbench/todos',None,200)
chk('approver','PP-03','审批案件列表',P,'GET','/approval/cases',None,200)
s,b=chk('approver','PP-04','批准 case1(错误 objectVersion)',P,'POST',f'/approval/cases/{case1}/decisions',{'decision':'approve','reason':'ok','objectVersion':999},409)
s,b=chk('approver','PP-05','批准 case1',P,'POST',f'/approval/cases/{case1}/decisions',{'decision':'approve','reason':'同意','objectVersion':3},(200,201))
res[-1]['body']=json.dumps(b,ensure_ascii=False)[:180]
chk('approver','PP-06','重复审批已结案件',P,'POST',f'/approval/cases/{case1}/decisions',{'decision':'approve','reason':'again','objectVersion':4},(400,409))
chk('approver','PP-07','驳回 case2',P,'POST',f'/approval/cases/{case2}/decisions',{'decision':'reject','reason':'规格不符','objectVersion':3},(200,201))
chk('approver','PP-08','非法决策值',P,'POST',f'/approval/cases/{case2}/decisions',{'decision':'maybe','reason':'x','objectVersion':4},400)
s,b=chk('approver','PP-09','案件详情含事件与记录',P,'GET',f'/approval/cases/{case1}',None,200)
res[-1]['body']=json.dumps({'state':(b.get('case') or {}).get('state'),'events':[e.get('type') for e in b.get('events',[])],'records':len(b.get('records',[]))},ensure_ascii=False) if isinstance(b,dict) else ''
chk('approver','PP-10','越权:创建物品',P,'POST','/masterdata/items',{'code':Q+'-X','name':'x','unit':'pcs'},403)
chk('approver','PP-11','越权:读用户',P,'GET','/org/users',None,403)
chk('approver','PP-12','越权:读审计',P,'GET','/audit/logs',None,403)
# ---- Viewer persona
for i,(m,p,b_) in enumerate([('GET','/approval/cases',None),('GET','/masterdata/items',None),('GET','/org/users',None),('POST','/masterdata/items',{'code':Q+'-V','name':'v','unit':'pcs'}),('POST',f'/approval/cases/{case2}/decisions',{'decision':'approve','reason':'越权','objectVersion':4}),('PUT',f'/org/users/{uid}/status',{'active':True}),('POST','/org/roles',{'name':'hack','displayName':'h'}),('GET','/workbench/summary',None)],1):
    chk('viewer',f'PV-{i:02d}',f'无策略访客 {m} {p} 应被拒',V,m,p,b_,403)
s,b=chk('viewer','PV-09','/auth/me 可用且 admin=false',V,'GET','/auth/me',None,200)
# ---- Cross-role handoff
s,b=call(D,'GET',f'/approval/cases/{case1}'); st=(b.get('case') or {}).get('state') if isinstance(b,dict) else None
res.append(dict(persona='跨角色',id='PX-01',desc='提交→审批→提交人可见 approved',req=f'GET /approval/cases/{case1} as demo-admin',expect='approved',actual=st,ok=st=='approved',body=''))
s,b=call(D,'GET',f'/approval/cases/{case2}'); st=(b.get('case') or {}).get('state') if isinstance(b,dict) else None
res.append(dict(persona='跨角色',id='PX-02',desc='驳回后提交人可见 rejected',req=f'GET /approval/cases/{case2}',expect='rejected',actual=st,ok=st=='rejected',body=''))
s,b=call(P,'GET','/workbench/summary'); res.append(dict(persona='跨角色',id='PX-03',desc='审批完成后审批人待办清空',req='GET /workbench/summary as approver',expect='approval open=0',actual=json.dumps(b,ensure_ascii=False)[:120],ok='"open": 1' not in json.dumps(b) and '"open": 2' not in json.dumps(b),body=''))
s,b=call(V,'GET',f'/approval/cases/{case1}'); res.append(dict(persona='跨角色',id='PX-04',desc='审批结果对 viewer(无策略)不可见',req='GET case as viewer',expect=403,actual=s,ok=s==403,body=''))
s,b=call(A,'GET','/audit/logs'); n=json.dumps(b,ensure_ascii=False).count('/approval/cases'); res.append(dict(persona='跨角色',id='PX-05',desc='审计日志记录审批写操作',req='GET /audit/logs',expect='>=4 条 approval 记录',actual=n,ok=n>=4,body=''))
import subprocess
# disabled user login
s,b=call(A,'GET','/org/users'); 
json.dump(res,open('/workspace/retest-541ffff/raw/persona.json','w'),ensure_ascii=False,indent=0)
for r in res: print(('PASS' if r['ok'] else 'FAIL'),r['persona'],r['id'],r['desc'],r['req'],'exp',r['expect'],'act',r['actual'],'' if r['ok'] else r['body'])
