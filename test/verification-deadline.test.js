import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createVerificationSession} from '../src/patronus/verification-session.js';
import {patronusTools} from '../src/patronus/schema.js';

const hash=s=>createHash('sha256').update(s).digest('hex');
const WALL=1791950000000.625;
const guardedArgs=deadline=>({action:'drag',idempotencyKey:'guarded_payload_fixture',x:80,y:140,toX:170,toY:220,
 guard:{dispatchBefore:deadline,expectedDesktopStartedAt:'same',expectedOwnerEpoch:3,challengeEvidence:true,
 checks:[{crop:{x:50,y:100,width:200,height:200},sha256:hash('image')}]}});
const JOB='453edb5e-0a63-4509-b9a1-2ccc34e22860';

// Temporary caller-side compatibility option. The normalized wire request must
// be retained before transport because the adapter journals its args earlier.
// Never refresh a deadline, change a key, or retry an uncertain native input.
function deadlineCall(call,recordWire){
 return async(name,args)=>{
  let wire=args;
  if(name==='patronus_desktop'&&['solveCaptcha','click','drag'].includes(args?.action)&&
    Number.isFinite(args.guard?.dispatchBefore)){
   wire={...args,guard:{...args.guard,dispatchBefore:Math.floor(args.guard.dispatchBefore)}};
   patronusTools[name].schema.parse(wire);
   recordWire({name,args:structuredClone(wire)});
  }
  return call(name,wire);
 };
}

function fixture(t,{type='select',hook=false,loseInput=false,wallValue=WALL}={}){
 const directory=mkdtempSync(join(tmpdir(),'verification-deadline-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const image={x:50,y:100,width:200,height:200},anchorRectangle={x:50,y:50,width:100,height:20},
  controlRectangle={x:190,y:320,width:60,height:30};
 const spec={reviewed:true,type,session:'same',instructions:'Select the displayed objects',
  image,anchorRectangle,controlRectangle,panelRectangle:{x:40,y:40,width:220,height:320},
  anchorHash:hash('anchor'),observedImageHash:hash('image'),
  ...(type==='drag'?{source:{x:60,y:120,width:40,height:40,center:{x:80,y:140}}}:{})};
 let tick=100.125;const calls=[],wireRecords=[];
 const screenshot=()=>({screenshot:Buffer.from('frame').toString('base64'),screenshotMimeType:'image/jpeg',
  screenshotSha256:hash('frame'),desktop:{startedAt:'same'}});
 const crop=async(_bytes,r)=>Buffer.from(r.y===50?'anchor':r.y===100?'image':'control');
 const call=async(name,args)=>{
  // Same strict schema used by the real reader /call boundary, for every endpoint.
  patronusTools[name].schema.parse(args);
  calls.push({name,args:structuredClone(args)});
  if(name==='patronus_capabilities')return {desktop:{startedAt:'same'},
   desktopControl:{nativeGuardVersion:1,readerOwnedLease:true},desktopControlLease:{held:false,ownerEpoch:3}};
  if(name==='patronus_status')return {state:'succeeded',desktopCaptcha:{desktopStartedAt:'same',
   imageSha256:hash('image'),points:type==='drag'?[{x:170,y:220}]:[{x:80,y:140},{x:170,y:220}]}};
  if(args.action==='solveCaptcha')return {jobId:JOB,solverState:'running',...screenshot()};
  if(loseInput&&['click','drag'].includes(args.action))throw Object.assign(Error(),{code:'SIMULATED_LOST_RESPONSE'});
  return screenshot();
 };
 const session=createVerificationSession({directory,attemptId:'fractional_clock_fixture',
  call:hook?deadlineCall(call,e=>wireRecords.push(e)):call,crop,pollMs:0,
  now:()=>tick+=0.375,wall:()=>wallValue});
 return {spec,session,calls,wireRecords,journal:()=>readFileSync(join(directory,'fractional_clock_fixture.jsonl'),'utf8')
  .trim().split('\n').map(JSON.parse)};
}

for(const type of ['select','drag'])for(const wallValue of [WALL,Math.floor(WALL)])test('fractional monotonic clock with wall '+wallValue+' emits integer solve and '+type+' deadlines at the real schema boundary',async t=>{
 const f=fixture(t,{type,wallValue});const result=await f.session.runRound(f.spec);
 assert.equal(result.awaitingControlReview,true);
 const requests=f.calls.filter(c=>c.args.guard);
 assert.deepEqual(requests.map(c=>c.args.action),type==='drag'?['solveCaptcha','drag']:['solveCaptcha','click','click']);
 for(const {args} of requests){
  assert.equal(Number.isSafeInteger(args.guard.dispatchBefore),true);
  assert.ok(args.guard.dispatchBefore<=wallValue+20000);
  assert.ok(args.guard.dispatchBefore>wallValue+19995);
  assert.equal(args.guard.expectedDesktopStartedAt,'same');
  assert.equal(args.guard.expectedOwnerEpoch,3);
  assert.equal(args.guard.checks.length,3);
 }
 assert.equal(requests[0].args.guard.dispatchBefore,Math.floor(wallValue+20000));
 assert.ok(requests.slice(1).every(c=>c.args.guard.dispatchBefore<Math.floor(wallValue+20000)));
 const recorded=f.journal().filter(e=>['solver-request','input-request'].includes(e.stage)).map(e=>e.args);
 assert.deepEqual(recorded,requests.map(c=>c.args));
});

for(const action of ['solveCaptcha','click','drag'])test('real schema continues rejecting fractional '+action+' deadlines',()=>{
 const args={action,idempotencyKey:'fractional_reject_fixture',guard:{expectedDesktopStartedAt:'same',
  dispatchBefore:WALL+20000,checks:[{crop:{x:50,y:100,width:200,height:200},sha256:hash('image')}]}};
 assert.equal(patronusTools.patronus_desktop.schema.safeParse(args).success,false);
 assert.equal(patronusTools.patronus_desktop.schema.safeParse({...args,guard:{...args.guard,
  dispatchBefore:Math.floor(args.guard.dispatchBefore)}}).success,true);
});

for(const type of ['select','drag'])test('caller hook supports '+type+' through the real schema and retains exact wire requests',async t=>{
 const f=fixture(t,{type,hook:true});const result=await f.session.runRound(f.spec);
 assert.equal(result.awaitingControlReview,true);
 const sent=f.calls.filter(c=>c.args.guard);
 assert.deepEqual(f.wireRecords,sent);
 const recorded=f.journal().filter(e=>['solver-request','input-request'].includes(e.stage)).map(e=>e.args);
 assert.equal(recorded.length,sent.length);
 for(let i=0;i<sent.length;i++){
  const normalized=structuredClone(recorded[i]);
  normalized.guard.dispatchBefore=Math.floor(normalized.guard.dispatchBefore);
  assert.deepEqual(normalized,sent[i].args);
  assert.ok(sent[i].args.guard.dispatchBefore<=recorded[i].guard.dispatchBefore);
 }
 assert.deepEqual([...new Set(f.calls.map(c=>c.name))].sort(),
  ['patronus_capabilities','patronus_desktop','patronus_status']);
});

test('hook only floors the existing deadline and never mutates, refreshes, or changes recovery keys',async()=>{
 const sent=[],records=[];
 const call=deadlineCall(async(name,args)=>{sent.push({name,args});return 'result';},e=>records.push(e));
 for(const deadline of [WALL+20000,WALL-1000.375,42]){
  const args={action:'drag',idempotencyKey:'same_guarded_input_key',x:80,y:140,toX:170,toY:220,
   guard:{dispatchBefore:deadline,expectedDesktopStartedAt:'same',expectedOwnerEpoch:3,challengeEvidence:true,
    checks:[{crop:{x:50,y:100,width:200,height:200},sha256:hash('image')}]}};
  const original=structuredClone(args);
  await call('patronus_desktop',args);
  assert.deepEqual(args,original);
  assert.deepEqual(sent.at(-1).args,{...original,guard:{...original.guard,dispatchBefore:Math.floor(deadline)}});
  assert.ok(sent.at(-1).args.guard.dispatchBefore<=deadline);
  assert.deepEqual(records.at(-1),sent.at(-1));
 }
 // A paid request can be recovered with identical normalized args, without
 // consulting either clock again. This does not authorize replaying native input.
 const solve={...guardedArgs(WALL),action:'solveCaptcha',idempotencyKey:'same_paid_request_key'};
 await call('patronus_desktop',solve);const first=structuredClone(sent.at(-1));
 await call('patronus_desktop',solve);assert.deepEqual(sent.at(-1),first);
 await assert.rejects(call('patronus_desktop',guardedArgs(0.75))); // Flooring cannot extend it to 1.
 const ordinary={action:'screenshot',idempotencyKey:'unchanged_screenshot'};
 await call('patronus_desktop',ordinary);assert.equal(sent.at(-1).args,ordinary);
});

test('failed wire journaling prevents transport and malformed deadlines are not coerced',async()=>{
 let calls=0;
 const rejectRecord=deadlineCall(async()=>calls++,()=>{throw Error('disk full');});
 await assert.rejects(rejectRecord('patronus_desktop',guardedArgs(WALL)),/disk full/);
 assert.equal(calls,0);
 const passthrough=deadlineCall(async(_name,args)=>{calls++;assert.equal(args.guard.dispatchBefore,'123');},()=>{throw Error('unexpected record');});
 await passthrough('patronus_desktop',{action:'click',guard:{dispatchBefore:'123'}});
 assert.equal(calls,1); // The real schema, unchanged, rejects this value.
});

test('caller hook preserves halt after uncertain native input and never resumes the attempt',async t=>{
 const f=fixture(t,{hook:true,loseInput:true});
 await assert.rejects(f.session.runRound(f.spec),{code:'SIMULATED_LOST_RESPONSE'});
 assert.equal(f.calls.filter(c=>c.args.action==='click').length,1);
 const before=f.calls.length;
 await assert.rejects(f.session.runRound(f.spec),{code:'RUNNER_HALTED'});
 assert.equal(f.calls.length,before);
 assert.equal(f.wireRecords.filter(c=>c.args.action==='click').length,1);
});
