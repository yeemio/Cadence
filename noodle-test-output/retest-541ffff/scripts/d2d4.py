import sys,json,uuid,urllib.request; sys.path.insert(0,'/workspace/retest-541ffff/scripts'); from lib import *
R=[]; T='tenant-a'; A,_=login(T,'admin'); AB,_=login('tenant-b','admin'); V,_=login(T,'viewer')
def rec(i,desc,req,exp,c,s,ok,ref): R.append(dict(mod='org' if ref=='D-2' else 'attachment',id=i,desc=desc,u='admin',req=req,exp=exp,act=c,ok=bool(ok),ref=ref,body=s[:300])); print('PASS' if ok else 'FAIL',i,c,s[:150])
u='qa-'+uuid.uuid4().hex[:6]
c,j,s=call(T,A,'POST','/org/users',{'username':u,'displayName':'复测用户','password':'Init-pass-123'}); rec('D2-01','带初始口令建号','POST /org/users','201',c,s,c==201,'D-2'); uid=(j or {}).get('id') or (j or {}).get('user',{}).get('id')
c2,j2,s2=call(T,None,'POST','/auth/login',{'username':u,'password':'Init-pass-123'}); rec('D2-02','初始口令登录','POST /auth/login','200/201 + token',c2,s2[:80],c2 in(200,201) and (j2 or {}).get('token'),'D-2'); ut=(j2 or {}).get('token')
c,j,s=call(T,ut,'GET','/auth/me'); rec('D2-03','新用户 /auth/me','GET /auth/me','200',c,s,c==200,'D-2')
u2='qa-'+uuid.uuid4().hex[:6]; c,j,s=call(T,A,'POST','/org/users',{'username':u2,'displayName':'无口令'}); uid2=(j or {}).get('id')
c,j,s=call(T,None,'POST','/auth/login',{'username':u2,'password':'demo-password'}); rec('D2-04','不带口令建号→登录 401','POST /auth/login','401',c,s,c==401,'D-2')
c,j,s=call(T,A,'PUT',f'/org/users/{uid}/password',{'password':'short'}); rec('D2-05','弱口令重置','PUT /org/users/:id/password','400',c,s,c==400,'D-2')
c,j,s=call(T,V,'PUT',f'/org/users/{uid}/password',{'password':'New-pass-456'}); rec('D2-06','viewer 无 user:write 重置','PUT /org/users/:id/password','403',c,s,c==403,'D-2')
c,j,s=call(T,A,'PUT',f'/org/users/{uid}/password',{'password':'New-pass-456'}); rec('D2-07','admin 重置口令','PUT /org/users/:id/password','200',c,s,c in(200,201),'D-2')
c,j,s=call(T,None,'POST','/auth/login',{'username':u,'password':'Init-pass-123'}); rec('D2-08','旧口令登录','POST /auth/login','401',c,s,c==401,'D-2')
c,j,s=call(T,None,'POST','/auth/login',{'username':u,'password':'New-pass-456'}); rec('D2-09','新口令登录','POST /auth/login','200/201',c,s[:80],c in(200,201),'D-2')
c,j,s=call(T,ut,'GET','/auth/me'); rec('D2-10','重置前签发的旧会话','GET /auth/me','401（全端撤销）',c,s,c==401,'D-2')
c,j,s=call('tenant-b',AB,'PUT',f'/org/users/{uid}/password',{'password':'Hack-pass-789'}); rec('D2-11','B 租户 admin 重置 A 用户','PUT /org/users/:id/password @tenant-b','403/404',c,s,c in(403,404),'D-2')
c,j,s=call('tenant-b',A,'PUT',f'/org/users/{uid}/password',{'password':'Hack-pass-789'}); rec('D2-12','A token 打 B 子域重置','PUT /org/users/:id/password @tenant-b(A token)','401/403/404',c,s,c in(401,403,404),'D-2')
c,j,s=call('tenant-b',None,'POST','/auth/login',{'username':u,'password':'New-pass-456'}); rec('D2-13','A 用户在 B 子域登录','POST /auth/login @tenant-b','401',c,s,c==401,'D-2')
c,j,s=call(T,None,'POST','/auth/login',{'username':u,'password':'Hack-pass-789'}); rec('D2-14','跨租户重置未生效','POST /auth/login','401',c,s,c==401,'D-2')
c,j,s=call(T,A,'PUT','/org/users/nope-id/password',{'password':'New-pass-456'}); rec('D2-15','不存在用户重置','PUT /org/users/nope/password','404',c,s,c==404,'D-2')
# D-4
biz='rt-'+uuid.uuid4().hex[:6]
c,j,s=call(T,A,'POST','/attachment/upload',{'fileName':'s.txt','contentBase64':'c2VjcmV0LUE=','bizId':biz,'bizType':'wo'}); aid=(j or {}).get('id')
c,j,s=call(T,A,'GET',f'/attachment/download-reference?id={aid}'); rec('D4-01','签发下载引用','GET /attachment/download-reference','200',c,s,c==200,'D-4')
url=(j or {}).get('url') or (j or {}).get('downloadUrl') or (j or {}).get('reference',{}).get('url') if j else None
tok=None
import re
m=re.search(r'storage/([^"?&\s]+)',s); tok=m.group(1) if m else None
for host,exp,i in [('tenant-a','200','D4-02'),('tenant-b','403/404','D4-03'),('default','403/404','D4-04')]:
    c,j2,s2=call(host,None,'GET',f'/attachment/storage/{tok}'); rec(i,f'用 A 的引用在 {host} 子域取字节','GET /attachment/storage/:token @'+host,exp,c,s2[:100],(c==200 and 'secret' in s2) if exp=='200' else c in(403,404),'D-4')
json.dump(R,open('/workspace/retest-541ffff/raw/d2-d4.json','w'),ensure_ascii=False,indent=1); print(len(R),sum(r['ok'] for r in R))
