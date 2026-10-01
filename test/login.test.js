import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Patronus } from '../src/patronus/engine.js';
import { readX10Credentials, loginRequestPolicy, loginEvidenceURL, redactLoginText, trackLoginResponses } from '../src/patronus/login.js';

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
