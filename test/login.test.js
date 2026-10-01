import { chromium } from 'playwright';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Patronus } from '../src/patronus/engine.js';
import { readX10Credentials, loginRequestPolicy, loginEvidenceURL, redactLoginText, trackLoginResponses, x10AuthenticationEvidence, classifyX10Error, continueX10Request, diagnoseX10Error, maskedLoginScreenshot } from '../src/patronus/login.js';

const req=(url,method='POST',redirect=false)=>({url:()=>url,method:()=>method,
 redirectedFrom:()=>redirect?{}:null,frame:()=>({url:()=> 'https://x10hosting.com/login'}),resourceType:()=> 'document'});
test('login allows exactly one armed credential submission and rejects redirects and other writes',()=>{
 const state={submitArmed:false,submitted:false};
 assert.equal(loginRequestPolicy(req('https://x10hosting.com/login'),state).allowed,false);
 state.submitArmed=true;
 for(const url of ['https://evil.example/login','https://x10hosting.com/logout','http://x10hosting.com/login','https://x10hosting.com/login?next=evil'])
  assert.equal(loginRequestPolicy(req(url),state).allowed,false);
 assert.equal(loginRequestPolicy(req('https://x10hosting.com/login','POST',true),state).allowed,false);
 assert.equal(loginRequestPolicy(req('https://x10hosting.com/login'),state).allowed,true);
 assert.equal(loginRequestPolicy(req('https://x10hosting.com/login'),state).allowed,false);
 assert.equal(loginRequestPolicy(req('https://analytics.example/pixel','GET'),{credentialsFilled:true}).allowed,false);
});
test('normal checkbox POSTs are bounded to known verification endpoints and armed state',()=>{
 const url='https://www.google.com/recaptcha/api2/reload';
 assert.equal(loginRequestPolicy(req(url),{}).allowed,false);
 assert.equal(loginRequestPolicy(req(url),{challengeArmed:true}).allowed,true);
 assert.equal(loginRequestPolicy(req('https://www.google.com/recaptcha/api2/other'),{challengeArmed:true}).allowed,false);
});
test('credential files must be private regular files; errors never contain secrets',()=>{
 const root=mkdtempSync(join(tmpdir(),'patronus-login-'));
 try {
  mkdirSync(join(root,'accounts'));
  const path=join(root,'accounts','x10.json');
  assert.throws(()=>readX10Credentials(root),{code:'ACCOUNT_MISSING'});
  writeFileSync(path,JSON.stringify({email:'fixture@example.test',password:'secret-fixture'}),{mode:0o600});
  assert.equal(readX10Credentials(root).email,'fixture@example.test');
  chmodSync(path,0o644);
  assert.throws(()=>readX10Credentials(root),{code:'ACCOUNT_FILE_POLICY'});
  rmSync(path);symlinkSync('/dev/null',path);
  assert.throws(()=>readX10Credentials(root),{code:'ACCOUNT_FILE_POLICY'});
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('login jobs contain only account references, use idempotency, and fail safely without credentials',async()=>{
 const root=mkdtempSync(join(tmpdir(),'patronus-login-job-'));
 const engine=new Patronus(root);
 try {
  const args={account:'x10',idempotencyKey:'fixture-login-001',timeoutSeconds:30};
  const job=engine.login(args);
  assert.equal(engine.login(args).jobId,job.jobId);
  await engine.tick();
  const done=engine.status({jobId:job.jobId});
  assert.equal(done.state,'failed');assert.equal(done.obstacles[0].code,'ACCOUNT_MISSING');
  assert.deepEqual(JSON.parse(engine.result({jobId:job.jobId}).content),[]);
  assert.equal(engine.get(job.jobId).args.password,undefined);
 }finally{await engine.close();rmSync(root,{recursive:true,force:true});}
});


test('login evidence retains response status and redirect path while excluding secrets',()=>{
 const events={},records=[],page={on:(name,fn)=>events[name]=fn,off:()=>{},mainFrame:()=>page};
 const stop=trackLoginResponses(page,r=>records.push(r));
 events.response({url:()=> 'https://x10hosting.com/login?token=secret',status:()=>302,frame:()=>page,
  request:()=>({isNavigationRequest:()=>true,method:()=> 'POST'}),
  headers:()=>({'location':'/error?code=private-code','set-cookie':'secret-session','server':'fixture'})});
 assert.equal(records[0].status,302);assert.equal(records[0].redirect.path,'/error');
 assert.deepEqual(records[0].redirect.queryNames,['code']);
 assert.ok(!JSON.stringify(records).includes('private-code'));assert.ok(!JSON.stringify(records).includes('secret-session'));
 assert.deepEqual(loginEvidenceURL('https://x10hosting.com/error?email=private&code=secret').queryNames,['email','code']);
 assert.equal(redactLoginText('wrong secret-password for private@example.test',['secret-password']),'wrong [redacted] for [redacted email]');
 assert.ok(!redactLoginText('a'.repeat(100)).includes('a'.repeat(100)));stop();
});

test('authentication requires an exact same-origin logout endpoint and a portal without password fields',async()=>{
 const page=(url,targets,passwords=0)=>({url:()=>url,locator:selector=>({
  count:async()=>passwords,evaluateAll:async()=>targets})});
 assert.equal((await x10AuthenticationEvidence(page('https://x10hosting.com/account',['/logout']))).authenticated,true);
 for(const targets of [['https://evil.example/logout'],['/help?next=/logout'],['/logout-other']])
  assert.equal((await x10AuthenticationEvidence(page('https://x10hosting.com/account',targets))).authenticated,false);
 assert.equal((await x10AuthenticationEvidence(page('https://x10hosting.com/error',['/logout']))).authenticated,false);
 assert.equal((await x10AuthenticationEvidence(page('https://x10hosting.com/account',['/logout'],1))).authenticated,false);
});
test('a generic X10 error page is not classified as a proven HTTP access denial',()=>{
 const diagnostic=status=>({network:[{navigation:true,url:{path:'/error'},status}]});
 assert.equal(classifyX10Error(diagnostic(200)),'X10_ERROR_PAGE');
 assert.equal(classifyX10Error(diagnostic(403)),'ACCESS_DENIED');
 assert.equal(classifyX10Error(diagnostic(429)),'RATE_LIMIT');
 assert.equal(classifyX10Error({network:[]}),'X10_ERROR_PAGE');
});
test('session-only checks run without credentials or solver configuration and never fill or submit',async()=>{
 for(const authenticated of [false,true]) {
  const root=mkdtempSync(join(tmpdir(),'patronus-session-'));
  let closed=false;
  const page={on:()=>{},off:()=>{},mainFrame:()=>page,
   goto:async()=>({status:()=>200}),waitForTimeout:async()=>{},
   url:()=>authenticated?'https://x10hosting.com/account':'https://x10hosting.com/login',
   locator:selector=>({count:async()=>authenticated?0:1,evaluateAll:async()=>authenticated?['/logout']:[]})};
  const context={route:async()=>{},routeWebSocket:async()=>{},pages:()=>[page],close:async()=>{closed=true;}};
  const engine=new Patronus(root,{launch:async()=>context});
  try{
   mkdirSync(join(root,'accounts'));writeFileSync(join(root,'accounts','solvecaptcha.json'),'invalid');
   const job=engine.login({account:'x10',sessionOnly:true,idempotencyKey:'session-only-fixture',timeoutSeconds:30});
   await engine.tick();
   const done=engine.status({jobId:job.jobId});
   assert.equal(done.state,'succeeded');
   const result=JSON.parse(engine.result({jobId:job.jobId}).content)[0];
   assert.equal(result.login.authenticated,authenticated);
   assert.equal(result.login.freshLogin,false);
   assert.equal(done.loginDiagnostic.credentialSubmissionObserved,false);
   assert.equal(closed,true);
  }finally{await engine.close();rmSync(root,{recursive:true,force:true});}
 }
});
test('session probe blocks even an armed login POST',()=>{
 assert.equal(loginRequestPolicy(req('https://x10hosting.com/login'),{probeOnly:true,submitArmed:true}).reason,'SESSION_PROBE_METHOD_POLICY');
});

test('browser login error recovery checks the session and never replays the credential POST',{skip:!process.env.PATRONUS_TEST_CHROMIUM},async()=>{
 for(const recover of [true,false,'blocked']) {
  const root=mkdtempSync(join(tmpdir(),'patronus-error-recovery-'));
  let posts=0,checks=0;
  const engine=new Patronus(root,{launch:async({path,config})=>{
   const context=await chromium.launchPersistentContext(path,{...config,executablePath:process.env.PATRONUS_TEST_CHROMIUM,chromiumSandbox:false});
   const route=context.route.bind(context);
   context.route=async(pattern,handler)=>route(pattern,async r=>handler({
    request:()=>r.request(),abort:()=>r.abort(),
    fetch:async()=>{posts++;return {status:()=>200,headers:()=>({}),fixtureBody:"<script>location.replace('/error')</script>",dispose:async()=>{}};},
    fulfill:async({response})=>r.fulfill({status:response.status(),contentType:'text/html',body:response.fixtureBody}),
    continue:async()=>{
     const req=r.request(),u=new URL(req.url());
     if(req.method()==='POST'){posts++;return r.fulfill({status:200,contentType:'text/html',body:"<script>location.replace('/error')</script>"});}
     if(u.pathname==='/login'&&posts){checks++;if(recover===true)return r.fulfill({status:200,contentType:'text/html',body:"<script>location.replace('/account')</script>"});}
     const body=u.pathname==='/account'?'<a href="/logout">Log out</a>':
      u.pathname==='/error'?(recover==='blocked'?'<h1>Browser Blocklisted</h1><p>This browser is blocked.</p><p>Please wait 24 hours. Your error code is EDAD2D404A932AEB9.</p>':'<title>Unknown Error</title><p>Unknown Error</p>'):
      '<form method="POST" action="/login"><input type="email" name="email"><input type="password" name="password"><button>Login</button></form>';
     return r.fulfill({status:200,contentType:'text/html',body});
    }
   }));
   return context;
  }});
  try {
   mkdirSync(join(root,'accounts'));
   writeFileSync(join(root,'accounts','x10.json'),JSON.stringify({email:'fixture@example.test',password:'private-fixture-password'}),{mode:0o600});
   const job=engine.login({account:'x10',solveCaptchas:false,screenshots:true,idempotencyKey:'error-session-fixture',timeoutSeconds:60});
   await engine.tick();
   const done=engine.status({jobId:job.jobId});
   assert.equal(posts,1);assert.equal(checks,recover==='blocked'?0:1);
   assert.ok(done.loginDiagnostic.screenshots.some(s=>s.stage==='FORM_READY'&&s.artifactId));
   assert.ok(done.loginDiagnostic.screenshots.some(s=>s.stage==='X10_ERROR'&&s.artifactId));
   assert.equal(done.loginDiagnostic.credentialSubmissionObserved,true);
   assert.ok(done.loginDiagnostic.submittedAt);
   if(recover===true) {
    assert.equal(done.state,'succeeded',JSON.stringify(done));
    const result=JSON.parse(engine.result({jobId:job.jobId}).content)[0];
    assert.equal(result.login.outcome,'AUTHENTICATED_AFTER_ERROR');
    assert.equal(result.login.freshLogin,true);
   }else{
    assert.equal(done.state,'failed');assert.equal(done.obstacles[0].code,recover==='blocked'?'X10_BROWSER_BLOCKLISTED':'X10_ERROR_PAGE');
    if(recover==='blocked'){assert.equal(done.loginDiagnostic.serverDiagnosis.supportCode,'EDAD2D404A932AEB9');assert.equal(done.loginDiagnostic.serverDiagnosis.requiresProviderReview,true);}
   }
   assert.ok(!JSON.stringify(done).includes('private-fixture-password'));
   assert.ok(!JSON.stringify(done).includes('fixture@example.test'));
  }finally{await engine.close();rmSync(root,{recursive:true,force:true});}
 }
});

test('credential POST fetch never follows redirects or permits replay and cross-origin redirects',async()=>{
 for(const [status,location,allowed] of [[302,'/account',true],[303,'/account',true],[307,'/account',false],[308,'/account',false],[302,'https://evil.example/',false],[302,'/logout',false]]) {
  let disposed=false,fulfilled=false,calls=0;
  const route={fetch:async options=>{calls++;assert.equal(options.maxRedirects,0);return {status:()=>status,headers:()=>({location}),dispose:async()=>{disposed=true;}};},
   fulfill:async()=>{fulfilled=true;}};
  if(allowed)await continueX10Request(route,{kind:'login'});
  else await assert.rejects(continueX10Request(route,{kind:'login'}),{code:'LOGIN_POST_REDIRECT_POLICY'});
  assert.equal(calls,1);assert.equal(disposed,true);assert.equal(fulfilled,allowed);
 }
});

test('specific provider block feedback is structured without treating generic lists as diagnoses',()=>{
 const specific=diagnoseX10Error('Home\nBrowser Blocklisted\nThis browser is blocked.\nPlease wait 24 hours. Your error code is EDAD2D404A932AEB9.');
 assert.equal(specific.category,'X10_BROWSER_BLOCKLISTED');
 assert.equal(specific.supportCode,'EDAD2D404A932AEB9');
 assert.equal(specific.minimumWaitSeconds,86400);
 assert.equal(specific.requiresProviderReview,true);
 const generic=diagnoseX10Error('Unknown Error\ncommon error conditions\nBrowser Blocklisted\nIP Blocklisted\nYour error code is unknown.');
 assert.equal(generic.specific,false);assert.equal(generic.category,'X10_ERROR_PAGE');assert.equal(generic.supportCode,null);
 assert.equal(classifyX10Error({network:[],serverDiagnosis:specific}),'X10_BROWSER_BLOCKLISTED');
});


test('X10 server cooldown blocks fresh submissions but permits key recovery and session checks',async()=>{
 const root=mkdtempSync(join(tmpdir(),'patronus-cooldown-'));
 const engine=new Patronus(root);
 try {
  const args={account:'x10',idempotencyKey:'cooldown-original',timeoutSeconds:30};
  const job=engine.login(args),d=engine.status({jobId:job.jobId});
  d.state='failed';
  d.loginDiagnostic={credentialSubmissionObserved:true,submittedAt:new Date().toISOString(),
   errorMessage:'Browser Blocklisted\nAll issues must be resolved including waiting 24 hours for temporary blocks to expire.'};
  engine.save(d);
  assert.throws(()=>engine.login({...args,idempotencyKey:'cooldown-new-attempt'}),{code:'LOGIN_SERVER_COOLDOWN'});
  assert.equal(engine.login(args).jobId,job.jobId);
  assert.ok(engine.login({...args,sessionOnly:true,idempotencyKey:'cooldown-session-check'}).jobId);
  d.loginDiagnostic.submittedAt=new Date(Date.now()-86401000).toISOString();engine.save(d);
  assert.ok(engine.login({...args,idempotencyKey:'cooldown-after-expiry'}).jobId);
 }finally{await engine.close();rmSync(root,{recursive:true,force:true});}
});

test('stage screenshots mask editable secrets without changing the page',{skip:!process.env.PATRONUS_TEST_CHROMIUM},async()=>{
 const browser=await chromium.launch({executablePath:process.env.PATRONUS_TEST_CHROMIUM,headless:true,chromiumSandbox:false});
 try {
  const page=await browser.newPage();
  await page.setContent('<input type=email value="first@example.test"><input type=password value="first-secret"><textarea>first-token</textarea>');
  const first=await maskedLoginScreenshot(page);
  await page.locator('input[type=email]').fill('second@example.test');
  await page.locator('input[type=password]').fill('second-secret');
  await page.locator('textarea').fill('second-token');
  const second=await maskedLoginScreenshot(page);
  assert.deepEqual(first,second);
  assert.equal(await page.locator('input[type=password]').inputValue(),'second-secret');
 }finally{await browser.close();}
});


test('new login diagnostics defaults preserve historical idempotency inputs',async()=>{
 const root=mkdtempSync(join(tmpdir(),'patronus-login-defaults-'));
 const engine=new Patronus(root);
 try {
  const idempotencyKey='historical-login-key';
  const old=engine.start({urls:['https://x10hosting.com/login'],mode:'login',profile:'x10',
   timeoutSeconds:180,idempotencyKey,solveCaptchas:true,sessionOnly:false,maxBytes:52428800,maxPages:1});
  assert.equal(engine.login({account:'x10',idempotencyKey}).jobId,old.jobId);
 }finally{await engine.close();rmSync(root,{recursive:true,force:true});}
});
