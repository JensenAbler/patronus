#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createVerificationSession} from '../src/patronus/verification-session.js';

export async function main(argv=process.argv.slice(2)){
 if(argv.length!==3)throw Object.assign(Error('Usage: node scripts/verification-round.js REVIEWED_SPEC.json PRIVATE_EVIDENCE_DIRECTORY ATTEMPT_ID'),{code:'USAGE'});
 const [source,directory,attemptId]=argv;
 const spec=JSON.parse(readFileSync(source,'utf8'));
 const session=createVerificationSession({directory:resolve(directory),attemptId,maxRounds:1,comparisonOnly:spec.comparisonOnly===true});
 try{
  const result=await session.runRound(spec);
  process.stdout.write(JSON.stringify({acceptance:result.acceptance,awaitingControlReview:result.awaitingControlReview,state:session.state()})+'\n');
 }catch(error){
  process.stderr.write(JSON.stringify({code:error.code||'VERIFICATION_FAILED',state:session.state(),message:'Stopped. Inspect retained evidence and reconcile any running job; do not replay native input.'})+'\n');
  throw error;
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main().catch(error=>{if(error.code==='USAGE')process.stderr.write(error.message+'\n');process.exitCode=1;});
}
