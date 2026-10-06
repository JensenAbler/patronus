#!/usr/bin/env python3
"""Activate only the reviewed gateway release; leave the live desktop untouched."""
import os, pathlib, re, shutil, subprocess, sys, json, urllib.request
source=pathlib.Path(sys.argv[1]).resolve()
revision,expected=sys.argv[2:4]
if any(not re.fullmatch(r'[a-f0-9]{40}',v) for v in (revision,expected)):
 raise SystemExit('Exact published and expected revisions required')
unit=pathlib.Path('/etc/systemd/system/patronus-gateway.service')
prior=unit.read_text()
if f'/srv/patronus/releases/{expected}/src/gateway.js' not in prior:
 raise SystemExit('Gateway changed; inspect current deployment first')
root=pathlib.Path('/srv/patronus/releases')
target=root/revision
previous=root/expected
if target.exists(): raise SystemExit('Release already exists; recover its outcome instead of retrying activation')
if (source/'package-lock.json').read_bytes()!=(previous/'package-lock.json').read_bytes():
 raise SystemExit('Gateway-only activation cannot change dependencies')
def run(*args):
 return subprocess.check_output(args,text=True).strip()
reader_before=run('systemctl','show','patronus.service','--property=MainPID','--value')
chrome_before=run('pgrep','-u','patronus','-x','chrome').splitlines()
target.mkdir(mode=0o755)
shutil.copytree(source/'src',target/'src')
for name in ['package.json','package-lock.json']: shutil.copy2(source/name,target/name)
runtime=(previous/'node_modules').resolve()
if not runtime.is_relative_to(root) or not runtime.is_dir(): raise SystemExit('Installed dependencies missing')
(target/'node_modules').symlink_to(runtime,target_is_directory=True)
for folder,dirs,files in os.walk(target):
 os.chmod(folder,0o755)
 for name in files:
  p=pathlib.Path(folder)/name
  if not p.is_symlink(): os.chmod(p,0o644)
(target/'previous-gateway.unit').write_text(prior)
next_unit=prior.replace(f'/srv/patronus/releases/{expected}/src/gateway.js',f'/srv/patronus/releases/{revision}/src/gateway.js')
next_unit=re.sub(r'^Environment=PATRONUS_RELEASE=.*$',f'Environment=PATRONUS_RELEASE={revision}',next_unit,flags=re.M)
next_unit=re.sub(r'^Environment=PATRONUS_HANDOFF=.*\n','',next_unit,flags=re.M)
next_unit=next_unit.replace('[Service]\n','[Service]\nEnvironment=PATRONUS_HANDOFF=1\n',1)
activated=False
try:
 unit.write_text(next_unit)
 subprocess.run(['systemctl','daemon-reload'],check=True)
 subprocess.run(['systemctl','restart','patronus-gateway.service'],check=True)
 subprocess.run(['systemctl','is-active','--quiet','patronus-gateway.service'],check=True)
 import time
 for attempt in range(30):
  try:
   req=urllib.request.Request('http://127.0.0.1:8794/patronus/healthz',headers={'Host':'mcp.jensenabler.com'})
   health=json.load(urllib.request.urlopen(req,timeout=3))
   if health.get('release')==revision: break
  except Exception: pass
  time.sleep(.3)
 else: raise RuntimeError('Gateway health check failed')
 reader_after=run('systemctl','show','patronus.service','--property=MainPID','--value')
 chrome_after=run('pgrep','-u','patronus','-x','chrome').splitlines()
 if reader_before!=reader_after or chrome_before[0]!=chrome_after[0]: raise RuntimeError('Desktop process changed during activation')
 activated=True
 print(json.dumps({'release':revision,'gatewayActive':True,'readerPIDUnchanged':True,'chromePIDUnchanged':True,'handoffEnabled':True}))
finally:
 if not activated:
  unit.write_text(prior)
  subprocess.run(['systemctl','daemon-reload'],check=True)
  subprocess.run(['systemctl','restart','patronus-gateway.service'],check=True)
