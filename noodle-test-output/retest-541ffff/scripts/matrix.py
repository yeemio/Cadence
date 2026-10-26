import json,re,urllib.request,collections
R=json.load(open('/tmp/routes.json'))
T={u:open(f'/tmp/tok_a_{u}').read().strip() for u in ['admin','approver','viewer']}; T['noauth']=''
def call(m,p,tok):
    req=urllib.request.Request('http://127.0.0.1'+p,method=m,data=(b'{}' if m!='GET' else None),headers={'Host':'tenant-a.smes.example.com','content-type':'application/json',**({'authorization':'Bearer '+tok} if tok else {})})
    try:
        with urllib.request.urlopen(req,timeout=8) as r: return r.status,r.read()[:200].decode('utf8','replace')
    except urllib.error.HTTPError as e: return e.code,e.read()[:200].decode('utf8','replace')
    except Exception as e: return 0,str(e)[:100]
def mod(f):
    m=re.search(r'application/src/([\w-]+)/',f) or re.search(r'server/src/([\w-]+?)(?:-http)?\.(?:module|controller)',f) or re.search(r'packages/([\w-]+)/',f)
    return m.group(1) if m else f
res=[]
for r in R:
    if r['p'] in ('/auth/logout','/auth/refresh'): continue
    p=re.sub(r':\w+','qa-nonexistent-0001',r['p']); row=dict(mod=mod(r['f']),m=r['m'],p=r['p'],perm=r['perm'])
    for u in ['admin','approver','viewer','noauth']:
        s,b=call(r['m'],p,T[u]); row[u]=s
        if u=='admin': row['body']=b
    res.append(row)
json.dump(res,open('/workspace/retest-541ffff/raw/matrix.json','w'),ensure_ascii=False,indent=0); print('done',len(res))
