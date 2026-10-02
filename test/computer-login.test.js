import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Patronus } from '../src/patronus/engine.js';

test('computer-use login uses coordinates and private keyboard input, submits once and recovers action receipts',{skip:!process.env.PATRONUS_TEST_CHROMIUM},async()=>{
 const root=mkdtempSync(join(tmpdir(),'patronus-computer-'));
 let posts=0,job,worker;
 const engine=new Patronus(root,{launch:async({path,config})=>{
  const context=await chromium.launchPersistentContext(path,{...config,headless:true,executablePath:process.env.PATRONUS_TEST_CHROMIUM,chromiumSandbox:false});
  await context.addInitScript(()=>{HTMLFormElement.prototype.requestSubmit=()=>{throw new Error('Programmatic submission forbidden in fixture');};});
  const original=context.route.bind(context);
  context.route=async(pattern,handler)=>original(pattern,async r=>handler({
   request:()=>r.request(),abort:()=>r.abort(),
   fetch:async()=>{
    posts++;
    assert.equal(r.request().postData().includes('keyboard-password'),true);
    return {status:()=>200,headers:()=>({}),dispose:async()=>{}};
   },
   fulfill:async()=>r.fulfill({status:200,contentType:'text/html',body:"<script>location.replace('/account')</script>"}),
   continue:async()=>{
    const body=new URL(r.request().url()).pathname==='/account'?'<a href="/logout">Log out</a>':
     '<form method="POST" action="/login"><input type="email" name="email" style="position:absolute;left:50px;top:50px;width:200px;height:40px"><input type="password" name="password" style="position:absolute;left:50px;top:120px;width:200px;height:40px"><button style="position:absolute;left:50px;top:190px;width:200px;height:40px">Log in</button></form>';
    return r.fulfill({status:200,contentType:'text/html',body});
   }
  }));
  return context;
 }});
 try {
  mkdirSync(join(root,'accounts'));
  writeFileSync(join(root,'accounts','x10.json'),JSON.stringify({email:'keyboard@example.test',password:'keyboard-password'}),{mode:0o600});
  job=engine.login({account:'x10',interaction:'computer-use',solveCaptchas:false,timeoutSeconds:60,idempotencyKey:'computer-use-fixture'});
  worker=engine.tick();
  for(let n=0;n<1000&&!engine.computerSessions.has(job.jobId);n++)await new Promise(r=>setTimeout(r,20));
  assert.ok(engine.computerSessions.has(job.jobId));
  const image=()=>engine.status({jobId:job.jobId}).computerUse.screenshotArtifactId;
  const first=image();
  const initial=engine.status({jobId:job.jobId});
  assert.equal(Date.parse(initial.computerUse.deadlineAt)-Date.parse(initial.startedAt),60000);
  const email={jobId:job.jobId,action:'credential',field:'email',x:100,y:70,screenshotArtifactId:first,idempotencyKey:'computer-email-key'};
  const result=await engine.computerAction(email);
  assert.equal(result.deadlineAt,initial.computerUse.deadlineAt);
  assert.ok(result.remainingSeconds>0&&result.remainingSeconds<=60);
  assert.deepEqual(await engine.computerAction(email),result);
  await assert.rejects(engine.computerAction({...email,field:'password'}),{code:'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(engine.computerAction({jobId:job.jobId,action:'click',x:100,y:140,screenshotArtifactId:first,idempotencyKey:'computer-stale-key'}),{code:'COMPUTER_STALE_SCREENSHOT'});
  await assert.rejects(engine.computerAction({jobId:job.jobId,action:'credential',field:'password',x:100,y:210,screenshotArtifactId:image(),idempotencyKey:'computer-wrong-target'}),{code:'COMPUTER_CREDENTIAL_TARGET'});
  await engine.computerAction({jobId:job.jobId,action:'credential',field:'password',x:100,y:140,screenshotArtifactId:image(),idempotencyKey:'computer-password-key'});
  await engine.computerAction({jobId:job.jobId,action:'submit',x:100,y:210,screenshotArtifactId:image(),idempotencyKey:'computer-submit-key'});
  await worker;
  const done=engine.status({jobId:job.jobId});
  assert.equal(posts,1);
  assert.equal(done.state,'succeeded');
  assert.equal(JSON.parse(engine.result({jobId:job.jobId}).content)[0].login.authenticated,true);
  assert.equal(done.computerUse.commands.filter(c=>c.state==='completed').length,3);
  assert.equal(done.loginDiagnostic.credentialSubmissionObserved,true);
  assert.ok(!JSON.stringify(done).includes('keyboard-password'));
  assert.ok(!JSON.stringify(done).includes('keyboard@example.test'));
  assert.equal(engine.computerSessions.has(job.jobId),false);
 }finally {
  if(job)engine.cancel({jobId:job.jobId});
  await worker?.catch(()=>{});await engine.close();rmSync(root,{recursive:true,force:true});
 }
});


test('computer-use permits a bounded inspection window while programmatic login stays capped',async()=>{
 const root=mkdtempSync(join(tmpdir(),'patronus-computer-deadline-'));
 const engine=new Patronus(root);
 try {
  assert.throws(()=>engine.login({account:'x10',timeoutSeconds:301,idempotencyKey:'long-programmatic'}),{code:'LOGIN_TIMEOUT_POLICY'});
  assert.throws(()=>engine.login({account:'x10',interaction:'computer-use',timeoutSeconds:901,idempotencyKey:'too-long-computer'}),{code:'LOGIN_TIMEOUT_POLICY'});
  const job=engine.login({account:'x10',interaction:'computer-use',timeoutSeconds:900,idempotencyKey:'bounded-computer'});
  assert.equal(engine.get(job.jobId).args.timeoutSeconds,900);
  assert.equal(engine.status({jobId:job.jobId}).state,'queued');
  engine.cancel({jobId:job.jobId});
 }finally {await engine.close();rmSync(root,{recursive:true,force:true});}
});

test('computer-use sessions forbid credential actions during a session-only probe',async()=>{
 const root=mkdtempSync(join(tmpdir(),'patronus-computer-probe-'));
 const page={on:()=>{},off:()=>{},mainFrame:()=>page,url:()=> 'https://x10hosting.com/login',
  goto:async()=>({status:()=>200}),waitForTimeout:async()=>{},viewportSize:()=>({width:1100,height:900}),
  locator:()=>({count:async()=>1,evaluateAll:async()=>[]}),screenshot:async()=>Buffer.from('fixture-image')};
 const context={route:async()=>{},routeWebSocket:async()=>{},pages:()=>[page],close:async()=>{}};
 const engine=new Patronus(root,{launch:async()=>context});
 let job,worker;
 try {
  job=engine.login({account:'x10',interaction:'computer-use',sessionOnly:true,solveCaptchas:false,timeoutSeconds:30,idempotencyKey:'computer-probe-fixture'});
  worker=engine.tick();
  for(let n=0;n<100&&!engine.computerSessions.has(job.jobId);n++)await new Promise(r=>setTimeout(r,10));
  const screenshotArtifactId=engine.status({jobId:job.jobId}).computerUse.screenshotArtifactId;
  for(const action of ['credential','solveCaptcha','submit'])
   await assert.rejects(engine.computerAction({jobId:job.jobId,action,screenshotArtifactId,idempotencyKey:'computer-probe-'+action}),{code:'SESSION_PROBE_METHOD_POLICY'});
  await engine.computerAction({jobId:job.jobId,action:'finish',screenshotArtifactId,idempotencyKey:'computer-probe-finish'});
  await worker;
  assert.equal(engine.status({jobId:job.jobId}).loginDiagnostic.credentialSubmissionObserved,false);
 }finally {if(job)engine.cancel({jobId:job.jobId});await worker?.catch(()=>{});await engine.close();rmSync(root,{recursive:true,force:true});}
});
