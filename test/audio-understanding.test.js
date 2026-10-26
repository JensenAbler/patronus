import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Patronus} from '../src/patronus/engine.js';
import {analyzeAudio} from '../src/patronus/audio-understanding.js';
import {patronusTools} from '../src/patronus/schema.js';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'audio-analysis-')),engine=new Patronus(root);
 t.after(()=>{engine.close();rmSync(root,{recursive:true,force:true});});
 const source=engine.start({urls:['https://example.org/a'],mode:'download',profile:'public',idempotencyKey:'source-download'});
 const original=randomUUID(),clip=randomUUID(),bytes=Buffer.from('fake audio bytes'),sha256=createHash('sha256').update(bytes).digest('hex');
 source.state='succeeded';source.artifacts=[{artifactId:original,complete:true,sha256:'original-hash'},{artifactId:clip,sourceArtifactId:original,audioSegment:true,complete:true,startSeconds:30,durationSeconds:30,bytes:bytes.length,sha256}];engine.save(source);
 writeFileSync(join(root,'jobs',source.jobId,clip),bytes);
 const args=patronusTools.patronus_start.schema.parse({urls:[],audioAnalysis:{sourceJobId:source.jobId,sourceArtifactId:original,question:'Describe the rhythm',startSeconds:35,endSeconds:40},idempotencyKey:'analyze-test-one'});
 return {engine,args,source,clip};
}
test('audio analysis sends actual bytes and offsets, records provenance and reuses durable result',async t=>{
 const {engine,args}=fixture(t);let calls=0;
 engine.audioAnalyzer=(e,d,a,s,on)=>analyzeAudio(e,d,a,s,on,{keyFn:()=> 'test-secret',fetchFn:async(url,options)=>{
  calls++;assert.match(url,/generativelanguage.googleapis.com/);assert.equal(options.redirect,'error');
  const body=JSON.parse(options.body);assert.equal(body.contents[0].parts[2].inlineData.data,Buffer.from('fake audio bytes').toString('base64'));
  assert.match(body.contents[0].parts[1].text,/30 seconds/);
  return {ok:true,json:async()=>({modelVersion:'test-model',candidates:[{finishReason:'STOP',content:{parts:[{text:'At 00:35 a pulse repeats.'}]}}]})};
 }});
 const job=engine.start(args);await engine.tick();
 assert.equal(engine.status({jobId:job.jobId}).state,'succeeded');
 const result=JSON.parse(engine.result({jobId:job.jobId}).content)[0];
 assert.equal(result.coverage.ranges[0].startSeconds,30);assert.equal(result.modelVersion,'test-model');
 assert.equal(engine.start(args).jobId,job.jobId);await engine.tick();assert.equal(calls,1);
 assert.ok(!engine.result({jobId:job.jobId}).content.includes('test-secret'));
});
test('unknown/incomplete source and empty selection fail without provider submission',async t=>{
 const {engine,args,source}=fixture(t);
 assert.throws(()=>engine.start({...args,idempotencyKey:'bad-range-1',audioAnalysis:{...args.audioAnalysis,startSeconds:80,endSeconds:90}}),/AUDIO_SEGMENTS_MISSING/);
 source.artifacts[0].complete=false;engine.save(source);
 assert.throws(()=>engine.start(args),/AUDIO_SOURCE_INCOMPLETE/);
 assert.equal(patronusTools.patronus_start.schema.safeParse({urls:[],idempotencyKey:'empty-normal-job'}).success,false);
});
test('failed provider response is terminal and the same key does not resubmit',async t=>{
 const {engine,args}=fixture(t);let calls=0;
 engine.audioAnalyzer=(e,d,a,s,on)=>analyzeAudio(e,d,a,s,on,{keyFn:()=> 'secret',fetchFn:async()=>{calls++;throw Error('secret upstream details');}});
 const job=engine.start(args);await engine.tick();assert.equal(engine.status({jobId:job.jobId}).state,'failed');
 engine.start(args);await engine.tick();assert.equal(calls,1);
 assert.ok(!JSON.stringify(engine.status({jobId:job.jobId})).includes('secret'));
});

test('follow-up reuses source audio with prior context and reports truncation as partial',async t=>{
 const {engine,args}=fixture(t);let count=0;
 engine.audioAnalyzer=(e,d,a,s,on)=>analyzeAudio(e,d,a,s,on,{keyFn:()=> 'secret',fetchFn:async(url,o)=>{
  const body=JSON.parse(o.body);count++;
  if(count===2)assert.match(body.contents[0].parts[0].text,/First observation/);
  return {ok:true,json:async()=>({candidates:[{finishReason:count===1?'STOP':'MAX_TOKENS',content:{parts:[{text:count===1?'First observation':'Incomplete follow-up'}]}}]})};
 }});
 const one=engine.start(args);await engine.tick();
 const two=engine.start({...args,idempotencyKey:'followup-analysis',audioAnalysis:{...args.audioAnalysis,previousJobId:one.jobId,question:'Verify the first observation'}});
 await engine.tick();assert.equal(engine.status({jobId:two.jobId}).state,'partial');
 assert.equal(JSON.parse(engine.result({jobId:two.jobId}).content)[0].coverage.completeResponse,false);
});
test('audio hash mismatch prevents any provider submission',async t=>{
 const {engine,args,source,clip}=fixture(t);writeFileSync(join(engine.root,'jobs',source.jobId,clip),'changed');
 let calls=0;engine.audioAnalyzer=(e,d,a,s,on)=>analyzeAudio(e,d,a,s,on,{keyFn:()=> 'secret',fetchFn:async()=>{calls++;}});
 const job=engine.start(args);await engine.tick();assert.equal(calls,0);
 assert.equal(engine.status({jobId:job.jobId}).obstacles[0].code,'AUDIO_INTEGRITY_FAILED');
});
