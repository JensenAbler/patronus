import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Patronus } from '../src/patronus/engine.js';
import { startDesktopCaptcha, validateCrop } from '../src/patronus/desktop-captcha.js';
import { patronusTools } from '../src/patronus/schema.js';
const hash = b => createHash('sha256').update(b).digest('hex');
function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),'desktop-captcha-test-')); const engine=new Patronus(root);
 const frame=Buffer.from('fake observed frame'), startedAt='fixture-session';
 engine.desktop={healthy:()=>true,status:()=>({state:'running',startedAt})};
 engine.desktopControl={view:{width:1280,height:720},screenshot:async()=>frame};
 engine.control=()=>engine.desktopControl;
 engine.desktopCapture={frame,sha256:hash(frame),at:Date.now(),desktopStartedAt:startedAt};
 t.after(async()=>{await engine.close();rmSync(root,{recursive:true,force:true});});
 const args={action:'solveCaptcha',idempotencyKey:'desktop-captcha-fixture',screenshotSha256:hash(frame),
   crop:{x:560,y:380,width:260,height:260},instructions:'Select all squares with bicycles',timeoutSeconds:30};
 return {engine,args,frame};
}
const config=()=>({apiKey:'fake-private-key',maxTasksPerJob:1});
test('crop validation forbids full-page and out-of-frame areas',()=>{
 for(const crop of [{x:0,y:0,width:1280,height:720},{x:-1,y:0,width:40,height:40},
 {x:1270,y:0,width:40,height:40},{x:0,y:0,width:1,height:40}])
 assert.throws(()=>validateCrop(crop),{code:'DESKTOP_CAPTCHA_CROP_POLICY'});
 assert.deepEqual(validateCrop({x:560,y:380,width:260,height:260}),{x:560,y:380,width:260,height:260});
});
test('schema exposes bounded solve action without accepting credential values',()=>{
 const input={action:'solveCaptcha',idempotencyKey:'schema-captcha-key',screenshotSha256:'a'.repeat(64),
 crop:{x:10,y:10,width:100,height:100},instructions:'Select bicycles'};
 assert.equal(patronusTools.patronus_desktop.schema.parse(input).action,'solveCaptcha');
 assert.equal(patronusTools.patronus_desktop.schema.safeParse({...input,password:'secret'}).success,false);
});
test('fresh observed crop starts one durable paid task; no keys or pixels are retained',async t=>{
 const {engine,args,frame}=fixture(t);let submits=0,finish;
 const pending=new Promise(r=>finish=r);
 const deps={readConfig:config,crop:async(b,r)=>{assert.equal(b,frame);assert.equal(r.x,560);return Buffer.from('cropped-only');},
 solve:async({image,record})=>{submits++;assert.equal(image.toString(),'cropped-only');await record({state:'submitting',type:'coordinates'});await pending;return [{x:5,y:10}];}};
 const job=await startDesktopCaptcha(engine,args,deps);
 assert.equal(job.state,'running');const handle=engine.desktopSolves.get(job.jobId);
 const duplicate=await startDesktopCaptcha(engine,args,{readConfig:()=>assert.fail()});
 assert.equal(duplicate.jobId,job.jobId);assert.equal(submits,1);
 finish();await handle.promise;
 const done=engine.status({jobId:job.jobId});assert.equal(done.state,'succeeded');
 assert.deepEqual(done.desktopCaptcha.points,[{x:565,y:390}]);
 assert.equal(done.outcome.websiteAccepted,false);
 assert.ok(!JSON.stringify(done).includes('cropped-only'));assert.ok(!JSON.stringify(done).includes('fake-private-key'));
 assert.equal((await startDesktopCaptcha(engine,args,deps)).jobId,job.jobId);assert.equal(submits,1);
 await assert.rejects(startDesktopCaptcha(engine,{...args,instructions:'Different'},deps),{code:'IDEMPOTENCY_CONFLICT'});
});
test('missing config, stale screenshots and oversized crops spend nothing',async t=>{
 const {engine,args}=fixture(t);const deps={readConfig:()=>null,solve:()=>assert.fail()};
 await assert.rejects(startDesktopCaptcha(engine,args,deps),{code:'SOLVER_NOT_CONFIGURED'});
 engine.desktopCapture.at-=31000;
 await assert.rejects(startDesktopCaptcha(engine,args,deps),{code:'DESKTOP_SCREENSHOT_STALE'});
 engine.desktopCapture.at=Date.now();
 await assert.rejects(startDesktopCaptcha(engine,{...args,crop:{x:0,y:0,width:1000,height:700}},deps),{code:'DESKTOP_CAPTCHA_CROP_POLICY'});
});
test('concurrent tasks refused, cancellation ends polling without another submission',async t=>{
 const {engine,args}=fixture(t);
 const deps={readConfig:config,crop:async()=>Buffer.from('crop'),solve:async({signal,record})=>{
 await record({state:'polling',taskId:'123',type:'coordinates'});
 return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 }};
 const job=await startDesktopCaptcha(engine,args,deps);const handle=engine.desktopSolves.get(job.jobId);
 await assert.rejects(startDesktopCaptcha(engine,{...args,idempotencyKey:'another-captcha-key'},deps),{code:'DESKTOP_SOLVER_BUSY'});
 engine.cancel({jobId:job.jobId});await handle.promise;
 assert.equal(engine.status({jobId:job.jobId}).state,'cancelled');
 assert.equal(engine.desktopSolves.size,0);
});
test('provider errors are sanitized and failed idempotency keys do not resubmit',async t=>{
 const {engine,args}=fixture(t);let calls=0;
 const deps={readConfig:config,crop:async()=>Buffer.from('crop'),solve:async({record})=>{
 calls++;await record({state:'submitting',type:'coordinates'});throw new Error('fake-private-key');
 }};
 const job=await startDesktopCaptcha(engine,args,deps);const handle=engine.desktopSolves.get(job.jobId);if(handle)await handle.promise;
 const result=await startDesktopCaptcha(engine,args,deps);assert.equal(calls,1);assert.equal(result.state,'failed');
 assert.ok(!JSON.stringify(result).includes('fake-private-key'));assert.equal(result.obstacles[0].code,'SOLVER_FAILED');
});

test('expiry or desktop restart during cropping prevents a paid submission',async t=>{
 for(const kind of ['expiry','restart']){
  const {engine,args}=fixture(t);let now=Date.now();engine.desktopCapture.at=now;
  const deps={readConfig:config,clock:()=>now,solve:()=>assert.fail(),crop:async()=>{
   if(kind==='expiry')now+=31000;else engine.desktop.status=()=>({startedAt:'restarted-session'});
   return Buffer.from('crop');
  }};
  await assert.rejects(startDesktopCaptcha(engine,args,deps),{code:'DESKTOP_SCREENSHOT_STALE'});
  assert.equal(engine.db.prepare('SELECT count(*) AS n FROM jobs').get().n,0);
 }
});
test('persistence failure is contained and releases busy state without revealing result',async t=>{
 const {engine,args}=fixture(t);
 const job=await startDesktopCaptcha(engine,args,{readConfig:config,crop:async()=>Buffer.from('crop'),
 solve:async({record})=>{await record({state:'submitting',type:'coordinates'});return[{x:1,y:1}];},
 persistResult:()=>{throw new Error('private disk path');}});
 const handle=engine.desktopSolves.get(job.jobId);if(handle)await handle.promise;
 assert.equal(engine.desktopSolves.size,0);const result=engine.status({jobId:job.jobId});
 assert.equal(result.state,'failed');assert.equal(result.obstacles[0].code,'SOLVER_PERSISTENCE_ERROR');
 assert.deepEqual(result.desktopCaptcha.points,[]);assert.ok(!JSON.stringify(result).includes('private disk'));
});
test('partially performed input followed by screenshot failure invalidates old frame',async t=>{
 const {engine}=fixture(t);
 engine.desktopControl.click=async()=>({clicked:true});
 engine.desktopControl.screenshot=async()=>{throw new Error('capture failed');};
 await assert.rejects(engine.desktopAction({action:'click',x:20,y:20,idempotencyKey:'partial-input-test'}),{code:'DESKTOP_ACTION_FAILED'});
 assert.equal(engine.desktopCapture,null);
});
