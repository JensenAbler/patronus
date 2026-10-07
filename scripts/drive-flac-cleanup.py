import argparse,configparser,concurrent.futures,json,os,pathlib,threading,time,urllib.request,urllib.parse,urllib.error
p=pathlib.Path('/var/lib/drive-storage-audit')
parser=argparse.ArgumentParser()
parser.add_argument('--execute',action='store_true')
args=parser.parse_args()
plan=json.loads((p/'flac-cleanup-plan.json').read_text())
keepers={g['keeper']['id'] for g in plan}
extras=[(x,g['keeper']) for g in plan for x in g['duplicates']]
assert len(keepers)==11 and len(extras)==15580
assert len({x['id'] for x,k in extras})==15580
assert not keepers.intersection(x['id'] for x,k in extras)
c=configparser.ConfigParser(interpolation=None);c.read(p/'rclone.conf');cfg=c['hardcore-audit']
token=json.loads(cfg['token']);lock=threading.Lock();token_until=0;access=''
def bearer():
 global token_until,access
 with lock:
  if time.time()>token_until:
   req=urllib.request.Request('https://oauth2.googleapis.com/token',data=urllib.parse.urlencode({'client_id':cfg['client_id'],'client_secret':cfg['client_secret'],'refresh_token':token['refresh_token'],'grant_type':'refresh_token'}).encode())
   with urllib.request.urlopen(req,timeout=30) as r:d=json.load(r)
   access=d['access_token'];token_until=time.time()+min(d.get('expires_in',3600)-120,3000)
  return access
def request(fid,method='GET'):
 url='https://www.googleapis.com/drive/v3/files/'+fid
 if method=='GET':url+='?fields=id,name,size,md5Checksum,ownedByMe,trashed,parents'
 for attempt in range(5):
  try:
   with urllib.request.urlopen(urllib.request.Request(url,method=method,headers={'Authorization':'Bearer '+bearer()}),timeout=45) as r:
    return json.load(r) if method=='GET' else True
  except urllib.error.HTTPError as e:
   if e.code==404:return None
   if e.code in (429,500,502,503,504) and attempt<4:time.sleep(2**attempt);continue
   raise
def matches(d,k):
 return d.get('ownedByMe') and not d.get('trashed') and d.get('md5Checksum')==k['md5Checksum'] and d.get('size')==k['size']
for g in plan:
 k=g['keeper'];d=request(k['id'])
 assert d and matches(d,k) and d['name']==k['name'] and d.get('parents')==k.get('parents'), 'Keeper verification failed'
print('All 11 keepers verified',flush=True)
if not args.execute:
 print('Dry run: 15580 manifest targets, no deletions requested',flush=True)
 raise SystemExit
journal=p/'flac-delete-journal.jsonl'
done=set()
if journal.exists():
 for line in journal.read_text().splitlines():
  d=json.loads(line)
  if d['status'] in ('deleted','already_absent'):done.add(d['id'])
loglock=threading.Lock()
def record(fid,status):
 with loglock:
  with journal.open('a') as f:f.write(json.dumps({'id':fid,'status':status,'at':time.time()})+'\n');f.flush();os.fsync(f.fileno())
  done.add(fid)
  if len(done)%100==0:print('Completed',len(done),'of',len(extras),flush=True)
def delete(pair):
 x,k=pair;fid=x['id']
 if fid in done:return
 d=request(fid)
 if d is None:record(fid,'already_absent');return
 assert fid not in keepers and matches(d,k) and d['name']==x['name'] and d.get('parents')==x.get('parents'), 'Duplicate changed; stopping'
 request(fid,'DELETE')
 record(fid,'deleted')
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
 for start in range(0,len(extras),100):
  list(pool.map(delete,extras[start:start+100]))
for g in plan:
 d=request(g['keeper']['id']);assert d and matches(d,g['keeper'])
print('COMPLETE: all manifest extras removed; all 11 keepers remain intact',flush=True)
