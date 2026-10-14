import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {cropFrame} from './desktop-captcha.js';
const hash=b=>createHash('sha256').update(b).digest('hex');

// Checks are ordered anchor, challenge image, control. Retain only reviewed
// crops, and metadata alone when the anchor disappears. Persistence completes
// reader-side before replying, so a lost response does not lose click evidence.
export async function retainGuardedEvidence(engine,args,frame,phase){
 if(args.guard?.challengeEvidence!==true)return;
 if(args.guard.checks.length!==3)throw Object.assign(Error(),{code:'DESKTOP_EVIDENCE_POLICY'});
 const crop=engine.cropDesktopFrame||cropFrame,checks=args.guard.checks;
 const anchor=await crop(frame,checks[0].crop),matched=hash(anchor)===checks[0].sha256;
 const directory=join(engine.root,'desktop-evidence',hash(args.idempotencyKey));
 mkdirSync(directory,{recursive:true,mode:0o700});
 const metadata={phase,at:new Date().toISOString(),session:engine.desktop.status().startedAt,anchorMatched:matched,crops:[]};
 if(matched){
  for(let i=0;i<checks.length;i++){
   const bytes=i===0?anchor:await crop(frame,checks[i].crop),name=phase+'-'+['anchor','image','control'][i]+'.jpg';
   writeFileSync(join(directory,name),bytes,{mode:0o600,flag:'wx'});
   metadata.crops.push({name,sha256:hash(bytes),crop:checks[i].crop});
  }
 }
 writeFileSync(join(directory,phase+'.json'),JSON.stringify(metadata)+'\n',{mode:0o600,flag:'wx'});
 return metadata;
}
