import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createVerificationSession} from '../src/patronus/verification-session.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
function fixture(t,options={}){
 const directory=mkdtempSync(join(tmpdir(),'verification-session-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const image={x:50,y:100,width:200,height:200},anchorRectangle={x:50,y:50,width:100,height:20},controlRectangle={x:190,y:320,width:60,height:30};
 const spec={reviewed:true,...(options.comparisonOnly?{comparisonOnly:true}:{}),type:'select',session:'same',instructions:'Select the displayed objects',image,anchorRectangle,controlRectangle,
 panelRectangle:{x:40,y:40,width:220,height:320},anchorHash:hash('anchor'),observedImageHash:hash('image0')};
 let count=0,epoch=0;const calls=[];
 const screenshot=()=>({...((options.comparisonOnly&&!options.missingMarker)?{comparisonOnly:true}:{}),screenshot:Buffer.from(String(count)).toString('base64'),screenshotMimeType:'image/jpeg',screenshotSha256:hash('frame'+count),desktop:{startedAt:'same'}});
 const crop=async(bytes,r)=>Buffer.from(r.y===50?(options.disappear&&Number(bytes)>0?'absent':'anchor'):r.y===100?'image'+(options.dynamic?bytes:'0'):'control');
 const call=async(name,args)=>{
  calls.push({name,args});
  if(name==='patronus_capabilities')return {desktop:{startedAt:'same'},desktopControl:{nativeGuardVersion:options.old?0:1,readerOwnedLease:true,cursorNeutralComparison:!options.oldComparison},desktopControlLease:{held:!!options.owner,ownerEpoch:epoch}};
  if(name==='patronus_status'&&options.takeover)epoch++;
  if(name==='patronus_status')return {[options.wrongStatus?'solverState':'state']:'succeeded',desktopCaptcha:{...((options.comparisonOnly&&!options.missingStatus)||options.unexpectedStatus?{comparisonOnly:true}:{}),desktopStartedAt:'same',imageSha256:hash('image0'),points:[{x:80,y:140},{x:170,y:220}]}};
  if(args.action==='solveCaptcha')return {jobId:'fixture-job',solverState:'running',...screenshot()};
  if(args.action==='click')count++;
  return screenshot();
 };
 const create=()=>createVerificationSession({directory,attemptId:'fixture_attempt',call,crop,pollMs:1,comparisonOnly:!!options.comparisonOnly});
 return {directory,spec,calls,create};
}
test('production adapter reads status.state, uses native guards, retains each click and stops before advance',async t=>{
 const f=fixture(t);const out=await f.create().runRound(f.spec);
 assert.equal(out.awaitingControlReview,true);assert.equal(out.acceptance,'unverified');
 const clicks=f.calls.filter(c=>c.args.action==='click');assert.equal(clicks.length,2);
 assert.ok(clicks.every(c=>c.args.guard.checks.length===3));
 const files=readdirSync(f.directory);assert.equal(files.filter(s=>s.includes('returned-panel.jpg')).length,2);
 const journal=readFileSync(join(f.directory,'fixture_attempt.jsonl'),'utf8');
 assert.ok(journal.includes('solver-created'));assert.ok(journal.includes('input-request'));
});
test('wrong solverState wrapper fails closed before input',async t=>{
 const f=fixture(t,{wrongStatus:true});await assert.rejects(f.create().runRound(f.spec),{code:'UNKNOWN_SOLVER_STATE'});
 assert.equal(f.calls.filter(c=>c.args.action==='click').length,0);
});
test('panel disappearance after first native click stops second and saves metadata only',async t=>{
 const f=fixture(t,{disappear:true});await assert.rejects(f.create().runRound(f.spec),{code:'PANEL_CHANGED_OR_DISMISSED'});
 assert.equal(f.calls.filter(c=>c.args.action==='click').length,1);
 const files=readdirSync(f.directory);assert.equal(files.filter(s=>s.includes('returned-panel.jpg')).length,0);
 assert.ok(files.some(s=>s.includes('returned.json')));
});
for(const option of ['owner','old'])test('refuses '+option+' control before paid task',async t=>{
 const f=fixture(t,{[option]:true});await assert.rejects(f.create().runRound(f.spec));
 assert.equal(f.calls.filter(c=>c.args.action==='solveCaptcha').length,0);
});
test('a fresh process cannot replay an existing attempt journal',async t=>{
 const f=fixture(t);await f.create().runRound(f.spec);
 const before=f.calls.length;await assert.rejects(f.create().runRound(f.spec),{code:'EEXIST'});assert.equal(f.calls.length,before);
});
test('live automatic Next or Verify stays gated pending positive fixture validation',()=>{
 assert.throws(()=>createVerificationSession({directory:'/tmp/unused-verification-test',attemptId:'fixture_attempt',allowAdvance:true}),{code:'LIVE_ADVANCE_VALIDATION_REQUIRED'});
});

test('dynamic image replacement prevents remaining stale-coordinate clicks',async t=>{
 const f=fixture(t,{dynamic:true});await assert.rejects(f.create().runRound(f.spec),{code:'CHALLENGE_CHANGED_AFTER_INPUT'});
 assert.equal(f.calls.filter(c=>c.args.action==='click').length,1);
});

test('overlapping round cannot replace the active reviewed spec',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'verification-concurrent-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 let settle,capCalls=0;
 const call=async name=>{if(name==='patronus_capabilities'){capCalls++;await new Promise(r=>settle=r);throw Object.assign(Error(),{code:'STOP_FIXTURE'});}throw Error('unexpected');};
 const f=fixture(t);const session=createVerificationSession({directory,attemptId:'concurrent_fixture',call,crop:async()=>Buffer.from('x')});
 const spec=structuredClone(f.spec);const first=session.runRound(spec);
 while(!settle)await new Promise(r=>setTimeout(r,1));
 await assert.rejects(session.runRound({...spec,session:'other'}),{code:'RUNNER_BUSY'});
 spec.instructions='mutated by caller';settle();await assert.rejects(first,{code:'STOP_FIXTURE'});
 assert.equal(capCalls,1);
});

test('owner intervention during solver polling invalidates the attempt even after release',async t=>{
 const f=fixture(t,{takeover:true});await assert.rejects(f.create().runRound(f.spec),{code:'OWNER_TOOK_CONTROL'});
 assert.equal(f.calls.filter(c=>c.args.action==='click').length,0);
});

test('cursor-neutral adapter marks every source/guarded input and requires newly reviewed matching-mode baseline',async t=>{
 const f=fixture(t,{comparisonOnly:true});const out=await f.create().runRound(f.spec);
 assert.equal(out.awaitingControlReview,true);
 assert.ok(f.calls.filter(c=>c.name==='patronus_desktop').every(c=>c.args.comparisonOnly===true));
 for(const name of readdirSync(f.directory).filter(p=>p.endsWith('.json')))
  assert.equal(JSON.parse(readFileSync(join(f.directory,name))).comparisonOnly,true);
 const normal=fixture(t,{comparisonOnly:true});delete normal.spec.comparisonOnly;
 await assert.rejects(normal.create().runRound(normal.spec),{code:'COMPARISON_BASELINE_REQUIRED'});
 assert.equal(normal.calls.length,0);
});
for(const missing of ['oldComparison','missingMarker','missingStatus'])test('cursor-neutral adapter rejects '+missing+' before native input',async t=>{
 const f=fixture(t,{comparisonOnly:true,[missing]:true});
 await assert.rejects(f.create().runRound(f.spec));
 assert.equal(f.calls.filter(c=>c.args.action==='click').length,0);
});
test('normal adapter rejects a solver status captured in another mode',async t=>{
 const f=fixture(t,{unexpectedStatus:true});await assert.rejects(f.create().runRound(f.spec),{code:'COMPARISON_CAPTURE_UNAVAILABLE'});
 assert.equal(f.calls.filter(c=>c.args.action==='click').length,0);
});
test('cursor-neutral adapter still halts on page-painted selection changes and does not rebaseline',async t=>{
 const f=fixture(t,{comparisonOnly:true,dynamic:true});await assert.rejects(f.create().runRound(f.spec),{code:'CHALLENGE_CHANGED_AFTER_INPUT'});
 assert.equal(f.calls.filter(c=>c.args.action==='click').length,1);
});
