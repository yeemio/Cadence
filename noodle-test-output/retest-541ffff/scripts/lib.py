import json,urllib.request,uuid,time
B='http://127.0.0.1:80'
def H(t): return f'{t}.smes.example.com'
def call(t,tok,m,p,body=None,raw=False):
    d=None if body is None else json.dumps(body).encode()
    r=urllib.request.Request(B+p,data=d,method=m,headers={'Host':H(t),'content-type':'application/json',**({'authorization':'Bearer '+tok} if tok else {})})
    try:
        with urllib.request.urlopen(r,timeout=30) as x: c,s=x.status,x.read().decode()
    except urllib.error.HTTPError as e: c,s=e.code,e.read().decode()
    try: j=json.loads(s)
    except Exception: j=None
    return c,j,s
def login(t,u,pw='demo-password'):
    c,j,s=call(t,None,'POST','/auth/login',{'username':u,'password':pw}); return (j or {}).get('token'),c
def env(kind,payload,rev='initial'):
    return {'operationId':'rt-'+uuid.uuid4().hex[:12],'expectedRevision':rev,'command':{'kind':kind,'payload':payload}}
