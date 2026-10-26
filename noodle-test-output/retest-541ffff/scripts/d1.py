import sys,json; sys.path.insert(0,'/workspace/retest-541ffff/scripts'); from lib import *
order=sys.argv[1].split(','); out=[]
for t in order:
    tok,lc=login(t,'admin')
    for p in ['/org/users','/org/roles','/masterdata/items','/audit/logs']:
        c,_,s=call(t,tok,'GET',p); out.append((t,p,lc,c)); 
for o in out: print(*o)
print('ALL200' if all(o[3]==200 for o in out) else 'FAILS')
