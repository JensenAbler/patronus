#!/usr/bin/env python3
"""Install a reviewed published source tree as a versioned unprivileged service."""
import os,pathlib,subprocess,sys,shutil,hashlib,json
source=pathlib.Path(sys.argv[1]).resolve()
revision=sys.argv[2]
if len(revision)!=40 or any(c not in '0123456789abcdef' for c in revision): raise SystemExit('Exact published commit required')
def run(*args,**kw): subprocess.run(args,check=True,**kw)
for credential in ['password-hash','jwks.json','cookie-keys.json']:
 if not (pathlib.Path('/etc/patronus')/credential).is_file(): raise SystemExit('Provision independent Patronus credentials first')
target=pathlib.Path('/srv/patronus/releases')/revision
run('id','patronus') if subprocess.run(['id','patronus'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0 else run('useradd','--system','--home-dir','/var/lib/patronus','--shell','/usr/sbin/nologin','patronus')
os.umask(0o022)
target.mkdir(parents=True,exist_ok=True)
# Only the installation parent needs traversal; profile/state paths are elsewhere.
os.chmod('/srv/patronus',0o755)
for name in ['src','package.json','package-lock.json']:
 p=source/name
 if p.is_dir(): shutil.copytree(p,target/name,dirs_exist_ok=True)
 else: shutil.copy2(p,target/name)
run('npm','ci','--omit=dev','--no-audit','--no-fund',cwd=target)
run('npx','playwright','install','--with-deps','chromium',cwd=target,env={**os.environ,'PLAYWRIGHT_BROWSERS_PATH':str(target/'browsers')})
# Installed code and browser binaries are public; runtime profiles remain private.
for root,dirs,files in os.walk(target):
 os.chmod(root,0o755)
 for name in files:
  p=pathlib.Path(root)/name
  if not p.is_symlink(): os.chmod(p,0o755 if p.stat().st_mode&0o111 else 0o644)
# Owner-approved, version-specific user namespace permission for Chromium.
if pathlib.Path('/sys/module/apparmor/parameters/enabled').exists():
 binaries=list((target/'browsers').glob('chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell'))+list((target/'browsers').glob('chromium-*/chrome-linux64/chrome'))
 if not binaries: raise SystemExit('Installed browser executable missing')
 policy='abi <abi/4.0>,\ninclude <tunables/global>\n'
 for i,binary in enumerate(binaries):
  policy+=f'profile patronus-{revision}-{i} {binary} flags=(unconfined) {{\n userns,\n}}\n'
 policy_path=pathlib.Path('/etc/apparmor.d')/('patronus-'+revision)
 policy_path.write_text(policy);run('apparmor_parser','-r',str(policy_path))
for p in ['/var/lib/patronus','/run/patronus']:
 pathlib.Path(p).mkdir(parents=True,exist_ok=True);run('chown','patronus:patronus',p);os.chmod(p,0o750 if p=='/run/patronus' else 0o700)
unit=f"""[Unit]
Description=Patronus persistent web reader
After=network-online.target
[Service]
Type=simple
User=patronus
Group=patronus
ExecStart=/usr/bin/node {target}/src/patronus/server.js
Environment=PLAYWRIGHT_BROWSERS_PATH={target}/browsers
Environment=HOME=/var/lib/patronus
UMask=0077
RuntimeDirectory=patronus
RuntimeDirectoryMode=0750
StateDirectory=patronus
StateDirectoryMode=0700
Restart=on-failure
RestartSec=3
TimeoutStopSec=25
KillMode=control-group
MemoryMax=2G
TasksMax=256
CPUQuota=150%
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/patronus /run/patronus
InaccessiblePaths=-/opt -/root -/var/lib/praxis-root -/srv/praxis-code -/srv/praxis-control -/etc/praxis
[Install]
WantedBy=multi-user.target
"""
unit_path=pathlib.Path('/etc/systemd/system/patronus.service')
if unit_path.exists(): (target/'previous-service.unit').write_text(unit_path.read_text())
unit_path.write_text(unit)
run('systemctl','daemon-reload');run('systemctl','enable','--now','patronus.service');run('systemctl','restart','patronus.service')
run('systemctl','is-active','patronus.service')


# Independent gateway: no Praxis process, key, path, or upstream at runtime.
if subprocess.run(['id','patronus-gateway'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
 run('useradd','--system','--home-dir','/var/lib/patronus-gateway','--shell','/usr/sbin/nologin','patronus-gateway')
gateway=f'''[Unit]
Description=Patronus authenticated MCP gateway
After=network.target patronus.service
Wants=patronus.service
[Service]
Type=simple
User=patronus-gateway
Group=patronus-gateway
SupplementaryGroups=patronus
ExecStart=/usr/bin/node {target}/src/gateway.js
Environment=PORT=8794
Environment=PATRONUS_BASE_URL=https://mcp.jensenabler.com/patronus
Environment=PATRONUS_RELEASE={revision}
StateDirectory=patronus-gateway
StateDirectoryMode=0700
LoadCredential=password-hash:/etc/patronus/password-hash
LoadCredential=jwks.json:/etc/patronus/jwks.json
LoadCredential=cookie-keys.json:/etc/patronus/cookie-keys.json
UMask=0077
Restart=on-failure
RestartSec=3
TimeoutStopSec=15
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictNamespaces=yes
RestrictSUIDSGID=yes
CapabilityBoundingSet=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
IPAddressDeny=any
IPAddressAllow=localhost
InaccessiblePaths=-/etc/praxis -/etc/praxis-probe -/var/lib/praxis-root -/var/lib/praxis-probe -/srv/praxis-app
ReadWritePaths=/var/lib/patronus-gateway
MemoryMax=256M
TasksMax=64
[Install]
WantedBy=multi-user.target
'''
gateway_path=pathlib.Path('/etc/systemd/system/patronus-gateway.service')
if gateway_path.exists():(target/'previous-gateway.unit').write_text(gateway_path.read_text())
gateway_path.write_text(gateway)
run('systemctl','daemon-reload');run('systemctl','enable','--now','patronus-gateway.service');run('systemctl','restart','patronus-gateway.service')
run('systemctl','is-active','patronus-gateway.service')
print(json.dumps({'revision':revision,'services':['patronus','patronus-gateway'],'source':str(target)}))
