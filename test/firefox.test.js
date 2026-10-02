import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Patronus } from '../src/patronus/engine.js';
import { patronusTools } from '../src/patronus/schema.js';
import { browserError } from '../src/patronus/browser-errors.js';
import { launchConfig, profileDir, firefoxPrefs } from '../src/patronus/launch.js';

const proxy={url:'http://127.0.0.1:1'};

test('launch policy keeps Chromium flags and gives Firefox equivalent prefs',()=>{
 const c=launchConfig({proxy,permissions:[],userAgent:'ua'});
 assert.equal(c.channel,'chromium');assert.equal(c.chromiumSandbox,true);assert.equal(c.headless,true);
 assert.ok(c.args.includes('--disable-quic'));assert.ok(!c.args.includes('--disable-gpu'));assert.equal(c.firefoxUserPrefs,undefined);
 assert.ok(launchConfig({headed:true,proxy}).args.includes('--disable-gpu'));
 const f=launchConfig({browser:'firefox',headed:true,proxy,permissions:[],userAgent:'ua'});
 assert.equal(f.headless,false);assert.equal(f.channel,undefined);assert.equal(f.chromiumSandbox,undefined);assert.equal(f.args,undefined);
 assert.deepEqual(f.proxy,{server:proxy.url,bypass:'<-loopback>'});assert.equal(f.serviceWorkers,'block');assert.equal(f.acceptDownloads,false);
 for(const [k,v] of [['network.http.http3.enable',false],['media.peerconnection.enabled',false],['network.trr.mode',5]])assert.equal(f.firefoxUserPrefs[k],v);
 f.firefoxUserPrefs['network.trr.mode']=0;assert.equal(firefoxPrefs['network.trr.mode'],5);
 assert.equal(profileDir('/r','x10','firefox'),'/r/firefox-profiles/x10');assert.equal(profileDir('/r','x10'),'/r/profiles/x10');
});

test('browser and headed stay absent unless requested, so old idempotency inputs still match',()=>{
 const plain=patronusTools.patronus_start.schema.parse({urls:['https://example.com'],idempotencyKey:'plain-key-1'});
 assert.equal('browser' in plain,false);assert.equal('headed' in plain,false);
 const ff=patronusTools.patronus_start.schema.parse({urls:['https://example.com'],browser:'firefox',headed:true,idempotencyKey:'ff-key-1'});
 assert.equal(ff.browser,'firefox');assert.equal(ff.headed,true);
 assert.throws(()=>patronusTools.patronus_start.schema.parse({urls:['https://example.com'],browser:'webkit',idempotencyKey:'bad-key-1'}));
 assert.equal(patronusTools.patronus_login.schema.parse({account:'x10',browser:'firefox',idempotencyKey:'login-key-1'}).browser,'firefox');
});

test('Firefox jobs launch Firefox with a separate profile and import provisioned cookies',async()=>{
 const root=mkdtempSync(join(tmpdir(),'patronus-firefox-'));const calls=[];
 const engine=new Patronus(root,{launch:async options=>{calls.push(options);throw new Error('launch secret');}});
 try{
  mkdirSync(join(root,'profiles','acct'),{recursive:true});writeFileSync(join(root,'profiles','acct','access.json'),'{"cookies":[]}');
  const args=patronusTools.patronus_start.schema.parse({urls:['https://example.com'],browser:'firefox',headed:true,profile:'acct',idempotencyKey:'firefox-launch-1'});
  const job=engine.start(args);assert.equal(job.browser,'firefox');assert.equal(job.headed,true);
  await engine.tick();
  assert.equal(calls.length,1);assert.equal(calls[0].browser,'firefox');assert.equal(calls[0].path,join(root,'firefox-profiles','acct'));
  assert.equal(calls[0].config.headless,false);assert.ok(calls[0].config.firefoxUserPrefs);assert.ok(existsSync(join(root,'firefox-profiles','acct')));
  const s=engine.status({jobId:job.jobId});assert.equal(s.obstacles[0].code,'BROWSER_LAUNCH_FAILED');assert.doesNotMatch(JSON.stringify(s),/launch secret/);
  const plain=engine.start(patronusTools.patronus_start.schema.parse({urls:['https://example.com'],rendering:'browser',idempotencyKey:'chromium-launch-1'}));
  await engine.tick();assert.equal(calls[1].browser,'chromium');assert.equal(calls[1].path,join(root,'profiles','public'));assert.equal(calls[1].config.headless,true);assert.equal(plain.browser,'chromium');
  assert.throws(()=>engine.start(patronusTools.patronus_start.schema.parse({urls:['https://example.com'],rendering:'http',browser:'firefox',idempotencyKey:'conflict-key-1'})),{code:'RENDERING_CONFLICT'});
  assert.throws(()=>engine.start(patronusTools.patronus_start.schema.parse({urls:['https://example.com'],rendering:'http',headed:true,idempotencyKey:'conflict-key-2'})),{code:'RENDERING_CONFLICT'});
  const missing=engine.start(patronusTools.patronus_start.schema.parse({urls:['https://example.com'],browser:'firefox',profile:'nobody',idempotencyKey:'firefox-missing-1'}));
  await engine.tick();assert.equal(engine.status({jobId:missing.jobId}).obstacles[0].code,'PROFILE_MISSING');assert.equal(calls.length,2);
  assert.deepEqual(engine.capabilities().browsers,['chromium','firefox']);
 }finally{await engine.close();rmSync(root,{recursive:true,force:true});}
});

test('Firefox login forwards browser selection without changing Chromium login inputs',()=>{
 const root=mkdtempSync(join(tmpdir(),'patronus-firefox-login-'));const engine=new Patronus(root);
 try{
  const ff=engine.login({account:'x10',sessionOnly:true,browser:'firefox',idempotencyKey:'ff-login-1'});assert.equal(ff.browser,'firefox');
  const cr=engine.login({account:'x10',sessionOnly:true,idempotencyKey:'cr-login-1'});assert.equal(cr.browser,'chromium');
  assert.equal(engine.get(cr.jobId).args.browser,undefined);assert.equal(engine.get(ff.jobId).args.browser,'firefox');
 }finally{engine.db.close();rmSync(root,{recursive:true,force:true});}
});

test('Firefox network failures map to stable codes without exposing text',()=>{
 for(const [text,code] of [['NS_ERROR_UNKNOWN_HOST at https://x.secret','BROWSER_DNS_ERROR'],['SSL_ERROR_BAD_CERT_DOMAIN','BROWSER_TLS_ERROR'],['SEC_ERROR_UNKNOWN_ISSUER','BROWSER_TLS_ERROR'],
  ['MOZILLA_PKIX_ERROR_SELF_SIGNED_CERT','BROWSER_TLS_ERROR'],['NS_ERROR_CONNECTION_REFUSED','BROWSER_NETWORK_ERROR'],['NS_ERROR_NET_RESET','BROWSER_NETWORK_ERROR'],['NS_ERROR_PROXY_CONNECTION_REFUSED','BROWSER_NETWORK_ERROR']]){
  const e=browserError(new Error(text),'navigation');assert.equal(e.code,code,text);assert.doesNotMatch(e.message,/secret/);
 }
});

test('real Firefox renders through the Patronus proxy in headed and headless modes',{skip:!process.env.PATRONUS_TEST_FIREFOX},async()=>{
 const { firefox } = await import('playwright');
 for(const headed of [false,true]){
  const root=mkdtempSync(join(tmpdir(),'patronus-firefox-real-'));
  const engine=new Patronus(root,{launch:({path,config})=>firefox.launchPersistentContext(path,{...config,executablePath:process.env.PATRONUS_TEST_FIREFOX})});
  try{
   const job=engine.start(patronusTools.patronus_start.schema.parse({urls:['https://example.com/'],browser:'firefox',headed,browserWaitSeconds:5,timeoutSeconds:90,idempotencyKey:'firefox-real-'+headed}));
   await engine.tick();const s=engine.status({jobId:job.jobId});
   assert.equal(s.state,'succeeded',JSON.stringify(s.obstacles));assert.equal(s.pages[0].route,'browser');assert.match(s.pages[0].title,/Example Domain/);
  }finally{await engine.close();rmSync(root,{recursive:true,force:true});}
 }
});
