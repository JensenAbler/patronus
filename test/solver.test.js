import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,chmodSync,symlinkSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';
import vm from 'node:vm';
import { readSolverConfig,solveToken } from '../src/patronus/solver.js';
import { detectChallenge,applyToken,captureWidgets,challengeRequestPolicy,solvePageChallenge } from '../src/patronus/challenges.js';
import { Patronus } from '../src/patronus/engine.js';
import { patronusTools } from '../src/patronus/schema.js';
const key='a'.repeat(32),token='test-token-'.repeat(10);
const challenge={type:'recaptcha-v2',sitekey:'fixture-sitekey',pageurl:'https://example.com/page'};
const signal=new AbortController().signal;
const config={apiKey:key,maxTasksPerJob:1};

test('solver credentials are optional, private, nonsymlink regular files with a bounded task cap',()=>{
 const root=mkdtempSync(join(tmpdir(),'patronus-solver-')),path=join(root,'solvecaptcha.json');
 try {
  assert.equal(readSolverConfig(root),null);
  writeFileSync(path,JSON.stringify({enabled:true,...config}),{mode:0o600});
  assert.deepEqual(readSolverConfig(root),config);
  chmodSync(path,0o644);assert.throws(()=>readSolverConfig(root),{code:'SOLVER_CONFIG_POLICY'});
  chmodSync(path,0o600);writeFileSync(path,JSON.stringify({enabled:true,...config,maxTasksPerJob:50}));
  assert.throws(()=>readSolverConfig(root),{code:'SOLVER_CONFIG_INVALID'});
  writeFileSync(path,'{"enabled":false}');assert.equal(readSolverConfig(root),null);
  rmSync(path);symlinkSync('/dev/null',path);assert.throws(()=>readSolverConfig(root),{code:'SOLVER_CONFIG_POLICY'});
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('submit once, persist task before polling, honor provider waits, never persist the token or key',async()=>{
 const records=[],calls=[],delays=[];
 const results=[{status:1,request:'12345'},{status:0,request:'CAPCHA_NOT_READY'},{status:1,request:token}];
 assert.equal(await solveToken({config,challenge,signal,record:r=>records.push(r),
  wait:async ms=>delays.push(ms),transport:async(path,p)=>{calls.push({path,p});return results.shift();}}),token);
 assert.deepEqual(calls.map(c=>c.path),['/in.php','/res.php','/res.php']);
 assert.deepEqual(delays,[20000,5000]);
 assert.equal(calls[0].p.method,'userrecaptcha');assert.equal(calls[0].p.googlekey,challenge.sitekey);
 assert.equal(records[1].taskId,'12345');assert.equal(records[2].state,'solved');
 assert.ok(!JSON.stringify(records).includes(token));assert.ok(!JSON.stringify(records).includes(key));
});
test('ambiguous paid submission is not retried; untrusted provider failures are sanitized',async()=>{
 let calls=0;const records=[];
 await assert.rejects(solveToken({config,challenge,signal,record:r=>records.push(r),transport:async()=>{calls++;throw new Error(key);}}),{code:'SOLVER_NETWORK_ERROR',message:'SOLVER_NETWORK_ERROR'});
 assert.equal(calls,1);assert.equal(records[0].state,'submitting');
 for(const response of [{status:0,request:key},{status:1,request:'invalid-id'}])
  await assert.rejects(solveToken({config,challenge,signal,record:()=>{},transport:async()=>response}),e=>!e.message.includes(key));
});
test('zero balance, polling timeout, and cancellation terminate without a second paid task',async()=>{
 await assert.rejects(solveToken({config,challenge,signal,record:()=>{},transport:async()=>({status:0,request:'ERROR_ZERO_BALANCE'})}),{code:'SOLVER_ERROR_ZERO_BALANCE'});
 let submits=0;
 await assert.rejects(solveToken({config,challenge,signal,maxPolls:2,wait:async()=>{},record:()=>{},
  transport:async path=>path==='/in.php'?(submits++,{status:1,request:'123'}):({status:0,request:'CAPCHA_NOT_READY'})}),{code:'SOLVER_TIMEOUT'});
 assert.equal(submits,1);
 const controller=new AbortController();
 await assert.rejects(solveToken({config,challenge,signal:controller.signal,record:()=>{},wait:async()=>controller.abort(Object.assign(new Error('CANCELLED'),{code:'CANCELLED'})),
  transport:async()=>({status:1,request:'123'})}),{code:'CANCELLED'});
});
test('standalone Turnstile maps its site key; unsupported managed challenges submit nothing',async()=>{
 let calls=0;
 assert.equal(await solveToken({config,challenge:{...challenge,type:'turnstile'},signal,wait:async ms=>assert.equal(ms,5000),record:()=>{},
  transport:async(path,p)=>{calls++;if(path==='/in.php'){assert.equal(p.method,'turnstile');assert.equal(p.sitekey,challenge.sitekey);return {status:1,request:'123'};}return {status:1,request:token};}}),token);
 assert.equal(calls,2);
 await assert.rejects(solveToken({config,challenge:{...challenge,type:'turnstile',managed:true},signal,record:()=>{},transport:async()=>assert.fail()}),{code:'SOLVER_CHALLENGE_UNSUPPORTED'});
});

function pageFixture(html) {
 const {window}=parseHTML(html);
 window.location={href:challenge.pageurl};
 const context=vm.createContext({window,document:window.document,location:window.location,URL,Event:window.Event,Set});
 return {window,page:{evaluate:async(fn,arg)=>{context.arg=arg;return vm.runInContext('('+fn.toString()+')(arg)',context);}}};
}
test('widget tokens use matching fields; login does not run callbacks or submit a form',async()=>{
 const {page,window}=pageFixture('<div class="g-recaptcha" data-sitekey="fixture-sitekey" data-callback="done"></div><textarea name="g-recaptcha-response"></textarea><form></form>');
 let calls=0;window.done=()=>calls++;
 const detected=await detectChallenge(page);assert.equal(detected.type,'recaptcha-v2');
 assert.equal(await applyToken(page,detected,token,{callbacks:false}),true);
 assert.equal(window.document.querySelector('textarea').value,token);assert.equal(calls,0);
 assert.equal(await detectChallenge(page),null);
 window.document.querySelector('textarea').value='';
 assert.equal(await applyToken(page,detected,token),true);assert.equal(calls,1);
 window.location.href='https://example.com/other';assert.equal(await applyToken(page,detected,token),false);
});
test('render hooks capture Turnstile callbacks without replacing normal rendering',async()=>{
 const {page,window}=pageFixture('<input name="cf-turnstile-response">');
 let interval;let callbackToken;
 const context=vm.createContext({window,setInterval:fn=>(interval=fn,1),setTimeout:()=>1,clearInterval:()=>{},WeakSet,Object});
 vm.runInContext('('+captureWidgets.toString()+')()',context);
 window.turnstile={render:()=> 'widget-id'};interval();
 assert.equal(window.turnstile.render('container',{sitekey:challenge.sitekey,callback:t=>callbackToken=t}),'widget-id');
 const detected=await detectChallenge(page);assert.equal(detected.type,'turnstile');
 assert.equal(await applyToken(page,detected,token),true);assert.equal(callbackToken,token);
});
test('multiple widgets fail closed before tokens can cross widget boundaries',async()=>{
 const {page}=pageFixture('<div class="g-recaptcha" data-sitekey="fixture-sitekey"></div><div class="g-recaptcha" data-sitekey="different-sitekey"></div><textarea name="g-recaptcha-response"></textarea>');
 const detected=await detectChallenge(page);assert.equal(detected.managed,true);
 assert.equal(await applyToken(page,challenge,token),false);
});

test('challenge policy permits narrow armed verification only; other writes and redirected POSTs stay blocked',()=>{
 const req=(url,method='POST',redirect=false)=>({url:()=>url,method:()=>method,redirectedFrom:()=>redirect?{}:null});
 const state={armed:true,origin:'https://example.com'};
 for(const url of ['https://www.google.com/recaptcha/api2/reload','https://challenges.cloudflare.com/cdn-cgi/challenge-platform/widget','https://example.com/cdn-cgi/challenge-platform/verify'])
  assert.equal(challengeRequestPolicy(req(url),state).allowed,true);
 for(const url of ['https://example.com/login','https://evil.example/cdn-cgi/challenge-platform/verify','https://www.google.com/recaptcha/api2/other','http://example.com/cdn-cgi/challenge-platform/verify'])
  assert.equal(challengeRequestPolicy(req(url),state),null);
 assert.equal(challengeRequestPolicy(req('https://www.google.com/recaptcha/api2/reload'),{armed:false}),null);
 assert.equal(challengeRequestPolicy(req('https://www.google.com/recaptcha/api2/reload','POST',true),state),null);
});
test('per-job cap blocks a second paid solve and opt-out spends nothing',async()=>{
 const root=mkdtempSync(join(tmpdir(),'patronus-solver-cap-'));
 try {
  writeFileSync(join(root,'solvecaptcha.json'),JSON.stringify({enabled:true,...config}),{mode:0o600});
  const {page}=pageFixture('<div class="g-recaptcha" data-sitekey="fixture-sitekey"></div><textarea name="g-recaptcha-response"></textarea>');
  const engine={root,save:()=>{}},d={solverAttempts:[{state:'submission-uncertain'}]};
  await assert.rejects(solvePageChallenge(engine,page,d,{},signal,{}),{code:'SOLVER_TASK_LIMIT'});
  assert.equal(await solvePageChallenge(engine,page,d,{solveCaptchas:false},signal,{}),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('restart preserves solver receipts and job id; a repeated request does not replay the solve',async()=>{
 const root=mkdtempSync(join(tmpdir(),'patronus-solver-recover-'));let engine=new Patronus(root);
 try {
  const args=patronusTools.patronus_start.schema.parse({urls:[challenge.pageurl],idempotencyKey:'solver-recover-fixture'});
  const d=engine.start(args);d.state='running';d.solverAttempts=[{state:'polling',taskId:'123',type:'recaptcha-v2'}];engine.save(d);
  await engine.close();engine=new Patronus(root);
  assert.equal(engine.start(args).jobId,d.jobId);
  const status=engine.status({jobId:d.jobId});assert.equal(status.state,'failed');assert.equal(status.solverAttempts[0].taskId,'123');
 }finally{await engine.close();rmSync(root,{recursive:true,force:true});}
});
