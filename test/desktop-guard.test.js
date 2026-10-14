import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DesktopControl} from '../src/patronus/desktop-control.js';
import {Patronus} from '../src/patronus/engine.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
function native(){
 let time=0,session='first',held=true;const calls=[];
 const desktop={display:':fixture',healthy:()=>true,status:()=>({startedAt:session})};
 const c=new DesktopControl(desktop,{now:()=>time,pause:async ms=>{time+=ms;},runInput:async(_cmd,args)=>calls.push(args)});
 c.inputContext={session,display:desktop.display,deadline:30000,assertActive:()=>{if(!held)throw Object.assign(Error(),{code:'DESKTOP_LEASE_RELEASED'});}};
 return {c,calls,setSession:s=>session=s,setHeld:v=>held=v,setTime:v=>time=v};
}
test('deterministic native clicks pin session before final click',async()=>{
 const f=native();let pauses=0;f.c.pause=async()=>{if(++pauses===3)f.setSession('restarted');};
 await assert.rejects(f.c.click({x:10,y:20}),{code:'DESKTOP_SESSION_CHANGED'});
 assert.equal(f.calls.filter(a=>a[0]==='click').length,0);
});
test('deadline expiry during movement prevents final click',async()=>{
 const f=native();f.c.pause=async()=>f.setTime(30001);
 await assert.rejects(f.c.click({x:10,y:20}),{code:'DESKTOP_INPUT_EXPIRED'});
 assert.equal(f.calls.filter(a=>a[0]==='click').length,0);
});
test('lease release during movement prevents final click',async()=>{
 const f=native();f.c.pause=async()=>f.setHeld(false);
 await assert.rejects(f.c.click({x:10,y:20}),{code:'DESKTOP_LEASE_RELEASED'});
 assert.equal(f.calls.filter(a=>a[0]==='click').length,0);
});
test('native paths contain no random jitter and dispatch one click',async()=>{
 const a=native(),b=native();await a.c.click({x:10,y:20});await b.c.click({x:10,y:20});
 assert.deepEqual(a.calls,b.calls);assert.equal(a.calls.filter(v=>v[0]==='click').length,1);
});
function engine(t){
 const root=mkdtempSync(join(tmpdir(),'patronus-guard-test-'));const e=new Patronus(root);let clicks=0,session='fixture';
 const frame=Buffer.from('synthetic screenshot');
 e.desktop={display:':fixture',healthy:()=>true,status:()=>({startedAt:session})};
 e.desktopControl={desktop:e.desktop,view:{width:1280,height:720},screenshot:async()=>frame,click:async()=>{clicks++;return {clicked:true};}};
 e.cropDesktopFrame=async()=>Buffer.from('synthetic challenge crop');
 const args={action:'click',x:15,y:25,idempotencyKey:'guard-fixture-1',guard:{expectedDesktopStartedAt:session,dispatchBefore:Date.now()+20000,checks:[{crop:{x:10,y:20,width:100,height:100},sha256:hash(Buffer.from('synthetic challenge crop'))}]}};
 t.after(async()=>{await e.close();rmSync(root,{recursive:true,force:true});});
 return {e,args,root,setSession:s=>session=s,clicks:()=>clicks};
}
test('fresh guarded image check happens before click and same input key cannot replay',async t=>{
 const f=engine(t);await f.e.desktopAction(f.args);assert.equal(f.clicks(),1);
 await assert.rejects(f.e.desktopAction(f.args),{code:'DESKTOP_ACTION_REPLAY_BLOCKED'});assert.equal(f.clicks(),1);
});
test('image/session/deadline mismatch prevents guarded input',async t=>{
 for(const type of ['image','session','deadline']){
  const f=engine(t);if(type==='image')f.args.guard.checks[0].sha256='a'.repeat(64);
  if(type==='session')f.args.guard.expectedDesktopStartedAt='other';
  if(type==='deadline')f.args.guard.dispatchBefore=Date.now()-1;
  await assert.rejects(f.e.desktopAction(f.args));assert.equal(f.clicks(),0);
 }
});
test('session changing while cropping prevents input',async t=>{
 const f=engine(t);f.e.cropDesktopFrame=async()=>{f.setSession('new');return Buffer.from('synthetic challenge crop');};
 await assert.rejects(f.e.desktopAction(f.args),{code:'DESKTOP_SESSION_CHANGED'});assert.equal(f.clicks(),0);
});
test('screenshot failure after click remains nonreplayable',async t=>{
 const f=engine(t);let captures=0;f.e.desktopControl.screenshot=async()=>{if(++captures===2)throw Object.assign(Error(),{code:'DESKTOP_SCREENSHOT_FAILED'});return Buffer.from('frame');};
 await assert.rejects(f.e.desktopAction(f.args),{code:'DESKTOP_SCREENSHOT_FAILED'});assert.equal(f.clicks(),1);
 await assert.rejects(f.e.desktopAction(f.args),{code:'DESKTOP_ACTION_REPLAY_BLOCKED'});assert.equal(f.clicks(),1);
});

import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {runDesktopInput} from '../src/patronus/desktop-control.js';
function childFixture(){
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.killed=false;
 child.kill=()=>{child.killed=true;return true;};return child;
}
test('native spawn error waits for close before releasing control',async()=>{
 const child=childFixture();let settled=false;
 const operation=runDesktopInput('fixture',[],{display:':test',spawnInput:()=>child}).catch(e=>e).finally(()=>settled=true);
 child.emit('error',Error('synthetic spawn failure'));await Promise.resolve();assert.equal(settled,false);
 child.emit('close',-1);assert.equal((await operation).code,'DESKTOP_INPUT_FAILED');
});
test('native timeout and lease abort kill child and wait for close',async()=>{
 for(const abort of [false,true]){
  const child=childFixture(),controller=new AbortController();let settled=false;
  const operation=runDesktopInput('fixture',[],{display:':test',spawnInput:()=>child,timeout:abort?10000:1,signal:controller.signal}).catch(e=>e).finally(()=>settled=true);
  if(abort)controller.abort();else await new Promise(r=>setTimeout(r,5));
  assert.equal(child.killed,true);assert.equal(settled,false);child.emit('close',null);
  assert.ok(['DESKTOP_INPUT_TIMEOUT','DESKTOP_CONTROL_RELEASED'].includes((await operation).code));
 }
});
test('reader persists source and returned challenge crops before returning',async t=>{
 const f=engine(t);f.args.guard.challengeEvidence=true;f.args.guard.checks=[f.args.guard.checks[0],f.args.guard.checks[0],f.args.guard.checks[0]];
 await f.e.desktopAction(f.args);
 const directory=join(f.root,'desktop-evidence',hash(f.args.idempotencyKey));
 assert.equal(readdirSync(directory).filter(p=>p.endsWith('.jpg')).length,6);
 assert.equal(JSON.parse(readFileSync(join(directory,'returned.json'))).anchorMatched,true);
});
test('reader retains metadata only when panel disappears after click',async t=>{
 const f=engine(t);let phase=0;
 f.e.desktopControl.click=async()=>{phase++;return {clicked:true};};
 f.e.cropDesktopFrame=async()=>Buffer.from(phase?'absent panel':'synthetic challenge crop');
 f.args.guard.challengeEvidence=true;f.args.guard.checks=[f.args.guard.checks[0],f.args.guard.checks[0],f.args.guard.checks[0]];
 await f.e.desktopAction(f.args);
 const directory=join(f.root,'desktop-evidence',hash(f.args.idempotencyKey));
 assert.equal(readdirSync(directory).filter(p=>p.startsWith('returned-')).length,0);
 assert.equal(JSON.parse(readFileSync(join(directory,'returned.json'))).anchorMatched,false);
});
test('owner taking and releasing control invalidates old guarded epoch',async t=>{
 const f=engine(t);f.args.guard.expectedOwnerEpoch=0;
 const owner=f.e.desktopLease.acquire({kind:'owner'});f.e.desktopLease.release(owner);
 await assert.rejects(f.e.desktopAction(f.args),{code:'DESKTOP_OWNER_CHANGED'});assert.equal(f.clicks(),0);
});
