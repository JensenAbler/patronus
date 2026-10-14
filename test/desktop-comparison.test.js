import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DesktopControl,captureFrame} from '../src/patronus/desktop-control.js';
import {Patronus} from '../src/patronus/engine.js';
import {startDesktopCaptcha} from '../src/patronus/desktop-captcha.js';
import {patronusTools} from '../src/patronus/schema.js';
const hash=b=>createHash('sha256').update(b).digest('hex');

test('capture defaults retain native cursor; comparison option changes only draw_mouse',async()=>{
 const calls=[];
 const spawnCapture=(cmd,args,options)=>{
  calls.push({cmd,args,options});
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
  queueMicrotask(()=>{child.stdout.write(Buffer.from('fixture jpeg'));child.emit('close',0);});
  return child;
 };
 await captureFrame({display:':fixture',spawnCapture});
 await captureFrame({display:':fixture',spawnCapture,drawMouse:false});
 const normal=calls[0],neutral=calls[1],i=normal.args.indexOf('-draw_mouse')+1;
 assert.equal(normal.args[i],'1');assert.equal(neutral.args[i],'0');
 const expected=structuredClone(normal);expected.args[i]='0';assert.deepEqual(neutral,expected);
 assert.throws(()=>captureFrame({display:':fixture',spawnCapture,drawMouse:'false'}),{code:'DESKTOP_CAPTURE_MODE_POLICY'});
 assert.equal(calls.length,2);
});

test('comparison capture does not move pointer and pins lease/session/deadline before and after capture',async()=>{
 for(const change of ['none','session','display','lease','deadline']){
  let session='same',display=':fixture',active=true,time=1000,captures=0,inputs=0;
  const desktop={healthy:()=>true,status:()=>({startedAt:session}),get display(){return display;}};
  const c=new DesktopControl(desktop,{now:()=>time,runInput:async()=>inputs++,capture:async options=>{
   captures++;assert.equal(options.drawMouse,false);
   if(change==='session')session='changed';if(change==='display')display=':other';
   if(change==='lease')active=false;if(change==='deadline')time=2000;
   return Buffer.from('fixture');
  }});
  c.inputContext={session,display,deadline:2000,assertActive:()=>{if(!active)throw Object.assign(Error(),{code:'DESKTOP_CONTROL_RELEASED'});}};
  if(change==='none')assert.equal((await c.screenshot({comparisonOnly:true})).toString(),'fixture');
  else await assert.rejects(c.screenshot({comparisonOnly:true}),{code:change==='lease'?'DESKTOP_CONTROL_RELEASED':change==='deadline'?'DESKTOP_INPUT_EXPIRED':'DESKTOP_SESSION_CHANGED'});
  assert.equal(captures,1);assert.equal(inputs,0);
 }
});

function engine(t){
 const root=mkdtempSync(join(tmpdir(),'patronus-comparison-')),e=new Patronus(root);
 t.after(async()=>{await e.close();rmSync(root,{recursive:true,force:true});});
 const modes=[];let clicks=0,painted=false;
 e.desktop={display:':fixture',healthy:()=>true,status:()=>({startedAt:'same'})};
 const neutral=()=>Buffer.from(painted?'page ring remains visible':'unchanged page');
 e.desktopControl={desktop:e.desktop,view:{width:1280,height:720},
  screenshot:async({comparisonOnly}={})=>{modes.push(!!comparisonOnly);return comparisonOnly?neutral():Buffer.from('page plus native pointer');},
  click:async()=>{clicks++;return {clicked:true};},drag:async()=>{clicks++;return {dragged:true};}};
 e.cropDesktopFrame=async b=>b;
 const args=action=>({action,x:100,y:120,...(action==='drag'?{toX:200,toY:220}:{}),
  comparisonOnly:true,idempotencyKey:'comparison_fixture_'+action,
  guard:{expectedDesktopStartedAt:'same',expectedOwnerEpoch:0,dispatchBefore:Date.now()+20000,
   checks:[{crop:{x:50,y:100,width:200,height:200},sha256:hash(neutral())}]}});
 return {e,root,modes,args,clicks:()=>clicks,paint:()=>painted=true};
}

test('normal screenshot behavior stays unchanged; neutral screenshot is explicit and marked',async t=>{
 const f=engine(t);
 const normal=await f.e.desktopAction({action:'screenshot',idempotencyKey:'normal_screenshot'});
 const neutral=await f.e.desktopAction({action:'screenshot',comparisonOnly:true,idempotencyKey:'neutral_screenshot'});
 assert.equal(normal.comparisonOnly,undefined);assert.equal(neutral.comparisonOnly,true);
 assert.deepEqual(f.modes,[false,true]);assert.notEqual(normal.screenshotSha256,neutral.screenshotSha256);
 assert.equal(f.e.desktopCapture.comparisonOnly,true);assert.equal(f.clicks(),0);
});

for(const action of ['click','drag'])test('neutral '+action+' guard and returned frame use the same policy without weakening hashes',async t=>{
 const f=engine(t),args=f.args(action);
 patronusTools.patronus_desktop.schema.parse(args);
 const out=await f.e.desktopAction(args);assert.equal(out.comparisonOnly,true);
 assert.deepEqual(f.modes,[true,true]);assert.equal(f.clicks(),1);
 await assert.rejects(f.e.desktopAction(args),{code:'DESKTOP_ACTION_REPLAY_BLOCKED'});
 const stale={...args,idempotencyKey:'stale_'+action,guard:{...args.guard,checks:[{...args.guard.checks[0],sha256:hash('page plus native pointer')}]}};
 await assert.rejects(f.e.desktopAction(stale),{code:'DESKTOP_IMAGE_CHANGED'});
 assert.equal(f.clicks(),1);
});

test('reader evidence records its comparison capture mode',async t=>{
 const f=engine(t),args=f.args('click');
 args.guard.challengeEvidence=true;args.guard.checks=Array(3).fill(args.guard.checks[0]);
 await f.e.desktopAction(args);
 for(const phase of ['source','returned']){
  const record=JSON.parse(readFileSync(join(f.root,'desktop-evidence',hash(args.idempotencyKey),phase+'.json')));
  assert.equal(record.comparisonOnly,true);assert.equal(record.crops.length,3);
 }
});

test('a page-painted circle remains a guarded mismatch with cursor exclusion',async t=>{
 const f=engine(t),args=f.args('click');f.paint();
 await assert.rejects(f.e.desktopAction(args),{code:'DESKTOP_IMAGE_CHANGED'});assert.equal(f.clicks(),0);
});

test('comparison-only option never expands supported native actions or bypasses ownership',async t=>{
 const f=engine(t);
 for(const action of ['click','drag','solveCaptcha','navigate','type','scroll','key','wait'])
  await assert.rejects(f.e.desktopAction({action,comparisonOnly:true,idempotencyKey:'bad_mode_'+action}),{code:'DESKTOP_CAPTURE_MODE_POLICY'});
 assert.deepEqual(f.modes,[]);assert.equal(f.clicks(),0);
 const owner=f.e.desktopLease.acquire({kind:'owner'});
 await assert.rejects(f.e.desktopAction({action:'screenshot',comparisonOnly:true,idempotencyKey:'owner_blocks_capture'}));
 f.e.desktopLease.release(owner);assert.deepEqual(f.modes,[]);
});

test('comparison screenshot mode survives paid solver source/status and cannot mix with normal source',async t=>{
 const f=engine(t);
 const frame=await f.e.desktopAction({action:'screenshot',comparisonOnly:true,idempotencyKey:'solver_comparison_source'});
 const args={action:'solveCaptcha',comparisonOnly:true,idempotencyKey:'solver_comparison_fixture',screenshotSha256:frame.screenshotSha256,
  crop:{x:50,y:100,width:200,height:200},instructions:'Select displayed test shapes',timeoutSeconds:30,
  guard:{...f.args('click').guard,dispatchBefore:Date.now()-1}};
 let providerCalls=0;
 const opts={crop:async b=>b,readConfig:()=>({fixture:true}),solve:async()=>{providerCalls++;return [{x:10,y:20}];}};
 await assert.rejects(startDesktopCaptcha(f.e,{...args,comparisonOnly:false},opts),{code:'DESKTOP_CAPTURE_MODE_CHANGED'});
 const job=await startDesktopCaptcha(f.e,args,opts);
 await f.e.desktopSolves.get(job.jobId)?.promise;
 assert.equal(f.e.status({jobId:job.jobId}).desktopCaptcha.comparisonOnly,true);
 f.e.desktopCapture=null;const captures=f.modes.length;
 const recovered=await f.e.desktopAction(args);assert.equal(recovered.jobId,job.jobId);
 assert.equal(recovered.recovered,true);assert.equal(recovered.comparisonOnly,true);
 assert.equal(f.modes.length,captures);assert.equal(providerCalls,1);
 await assert.rejects(startDesktopCaptcha(f.e,{...args,comparisonOnly:false},opts),{code:'IDEMPOTENCY_CONFLICT'});
});
