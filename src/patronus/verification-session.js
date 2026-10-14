import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { patronusCall } from './client.js';
import { cropFrame, validateCrop } from './desktop-captcha.js';
import { createRunner, Halt } from './verification-runner.js';
import { createEvidenceWriter } from './verification-evidence.js';

const hash = b => createHash('sha256').update(b).digest('hex');
const inside = (p,r) => Number.isInteger(p?.x) && Number.isInteger(p?.y) && p.x>=r.x && p.y>=r.y && p.x<r.x+r.width && p.y<r.y+r.height;
const contains = (outer,inner) => inner.x>=outer.x && inner.y>=outer.y && inner.x+inner.width<=outer.x+outer.width && inner.y+inner.height<=outer.y+outer.height;

export function validateVerificationSpec(spec) {
  if(spec?.reviewed!==true || !['select','drag'].includes(spec.type) ||
    typeof spec.session!=='string' || !spec.session ||
    !/^[a-f0-9]{64}$/.test(spec.anchorHash||'') ||
    !/^[a-f0-9]{64}$/.test(spec.observedImageHash||'') ||
    typeof spec.instructions!=='string' || !spec.instructions.trim() || [...spec.instructions].length>140)
    throw new Halt('REVIEWED_SPEC_REQUIRED');
  for(const r of [spec.image,spec.anchorRectangle,spec.controlRectangle,spec.panelRectangle])validateCrop(r);
  if(![spec.image,spec.anchorRectangle,spec.controlRectangle].every(r=>contains(spec.panelRectangle,r)))
    throw new Halt('CROP_OUTSIDE_REVIEWED_PANEL');
  if(spec.controlPoint && !inside(spec.controlPoint,spec.controlRectangle))throw new Halt('CONTROL_POINT_OUTSIDE_LABEL');
  return spec;
}

// No browser or solver call happens at import or construction. Callers prepare a
// reviewed prompt/geometry first, then invoke runRound. This adapter deliberately
// uses only the existing reader protocol and configured solver, never extensions.
export function createVerificationSession({directory,attemptId,call=patronusCall,
  crop=cropFrame,readControl=async()=>[],now=()=>performance.now(),wall=Date.now,
  maxRounds=2,timeoutMs=100000,pollMs=1200,allowAdvance=false,comparisonOnly=false}){
  if(typeof comparisonOnly!=='boolean')throw new Halt('COMPARISON_CAPTURE_POLICY');
  const captureOptions=comparisonOnly?{comparisonOnly:true}:{};
  if(!/^[A-Za-z0-9_-]{8,80}$/.test(attemptId))throw new Halt('INVALID_ATTEMPT_ID');
  if(allowAdvance)throw new Halt('LIVE_ADVANCE_VALIDATION_REQUIRED');
  // Real Next/Verify positive fixtures have not been validated. The production
  // adapter stops after answer selection for explicit control review.
  let spec,sequence=0,round=0,started=false,ownerEpoch;
  const utc=()=>new Date(wall()).toISOString();
  const key=kind=>attemptId+':'+kind+':'+(++sequence);
  const journalPath=join(directory,attemptId+'.jsonl');
  const record=event=>appendFileSync(journalPath,JSON.stringify(event)+'\n',{mode:0o600});
  // The reader requires integer epoch milliseconds. Floor the final bound so
  // fractional monotonic time never extends validity or fails the wire schema.
  const guard=frame=>({challengeEvidence:true,expectedOwnerEpoch:ownerEpoch,expectedDesktopStartedAt:spec.session,dispatchBefore:Math.floor(wall()+20000),
    checks:[{crop:spec.anchorRectangle,sha256:frame.anchorHash},{crop:spec.image,sha256:frame.imageHash},{crop:spec.controlRectangle,sha256:frame.controlHash}]});
  async function inspect(raw){
    if((raw?.comparisonOnly===true)!==comparisonOnly)throw new Halt('COMPARISON_CAPTURE_UNAVAILABLE');
    if(typeof raw?.screenshot!=='string'||raw.screenshotMimeType!=='image/jpeg')throw new Halt('INVALID_READER_FRAME');
    const bytes=Buffer.from(raw.screenshot,'base64');
    const anchorHash=hash(await crop(bytes,spec.anchorRectangle));
    const frame={bytes,session:raw.desktop?.startedAt,screenshotSha256:raw.screenshotSha256,...captureOptions,
      panelPresent:anchorHash===spec.anchorHash,anchorVerified:anchorHash===spec.anchorHash,anchorHash,
      panelRectangle:spec.panelRectangle,controlRectangle:spec.controlRectangle};
    if(frame.panelPresent){
      frame.imageHash=hash(await crop(bytes,spec.image));
      frame.controlHash=hash(await crop(bytes,spec.controlRectangle));
      frame.controlTexts=await readControl(await crop(bytes,spec.controlRectangle));
    }
    return frame;
  }
  const preserve=createEvidenceWriter({directory,attemptId,utc,encodeCrop:(frame,r)=>crop(frame.bytes,r)});
  const io={
    atomicOwnerGuard:true,now,utc,record,preserve,
    lease:async()=>{
      const state=await call('patronus_capabilities',{});
      if(state.desktopControl?.nativeGuardVersion!==1||state.desktopControl?.readerOwnedLease!==true||
        (comparisonOnly&&state.desktopControl?.cursorNeutralComparison!==true))
        throw new Halt('NATIVE_CONTROL_GUARD_UNAVAILABLE');
      const observedEpoch=state.desktopControlLease?.ownerEpoch;
      if(!Number.isSafeInteger(observedEpoch)||observedEpoch<0)throw new Halt('NATIVE_CONTROL_GUARD_UNAVAILABLE');
      if(ownerEpoch===undefined)ownerEpoch=observedEpoch;
      if(ownerEpoch!==observedEpoch)throw new Halt('OWNER_TOOK_CONTROL');
      return {active:state.desktopControlLease?.held!==false,session:state.desktop?.startedAt,observedAtMs:now()};
    },
    capture:async()=>inspect(await call('patronus_desktop',{action:'screenshot',...captureOptions,idempotencyKey:key('capture')})),
    startSolve:async source=>{
      const args={action:'solveCaptcha',...captureOptions,crop:spec.image,instructions:spec.instructions,
        screenshotSha256:source.screenshotSha256,timeoutSeconds:Math.max(30,Math.min(300,Math.ceil(timeoutMs/1000))),
        guard:guard(source),idempotencyKey:attemptId+':solve:'+round};
      // Exact immutable request is persisted before spending; use it for recovery.
      record({stage:'solver-request',utc:utc(),args});
      const result=await call('patronus_desktop',args);
      record({stage:'solver-created',utc:utc(),jobId:result.jobId,solverState:result.solverState});
      return result;
    },
    status:async jobId=>{
      const result=await call('patronus_status',{jobId});
      // Status returns state, unlike desktop solve-start's solverState.
      if((result.desktopCaptcha?.comparisonOnly===true)!==comparisonOnly)throw new Halt('COMPARISON_CAPTURE_UNAVAILABLE');
      return {state:result.state,session:result.desktopCaptcha?.desktopStartedAt,
        imageHash:result.desktopCaptcha?.imageSha256,points:result.desktopCaptcha?.points};
    },
    sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
    input:async(action,expected)=>{
      const args={action:action.type==='drag'?'drag':'click',...captureOptions,idempotencyKey:key('input'),
        guard:{challengeEvidence:true,expectedOwnerEpoch:ownerEpoch,expectedDesktopStartedAt:expected.session,dispatchBefore:Math.floor(wall()+Math.min(20000,Math.max(0,expected.dispatchBeforeMs-now()))),
          checks:[{crop:spec.anchorRectangle,sha256:expected.anchorHash},{crop:spec.image,sha256:expected.imageHash},{crop:spec.controlRectangle,sha256:expected.controlHash}]}};
      if(action.type==='drag')Object.assign(args,{x:action.from.x,y:action.from.y,toX:action.to.x,toY:action.to.y});
      else if(action.type==='click')Object.assign(args,action.point);
      else throw new Halt('ADVANCE_REQUIRES_REVIEW');
      record({stage:'input-request',utc:utc(),args});
      return inspect(await call('patronus_desktop',args));
    }
  };
  const runner=createRunner(io,{maxRounds,timeoutMs,pollMs,allowAdvance:false});
  return {state:runner.state,async runRound(reviewedSpec){
    if(runner.state().inFlight)throw new Halt('RUNNER_BUSY');
    if(runner.state().halted)throw new Halt('RUNNER_HALTED');
    validateVerificationSpec(reviewedSpec);
    if((reviewedSpec.comparisonOnly===true)!==comparisonOnly)throw new Halt('COMPARISON_BASELINE_REQUIRED');
    if(!started){
      mkdirSync(directory,{recursive:true,mode:0o700});
      // Existing attempts, including unknown/lost responses, cannot be restarted.
      writeFileSync(journalPath,JSON.stringify({stage:'attempt-created',utc:utc()})+'\n',{mode:0o600,flag:'wx'});
      started=true;
    }
    spec=structuredClone(reviewedSpec);round++;
    return runner.runRound(spec);
  }};
}
