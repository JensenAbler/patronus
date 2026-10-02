import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Patronus} from '../src/patronus/engine.js';
import {patronusTools} from '../src/patronus/schema.js';
import {addWarning,requestWarning} from '../src/patronus/warnings.js';

function fixture({missingSelector=false,status=200,background=false}={}){
 const root=mkdtempSync(join(tmpdir(),'patronus-warning-test-')),page=new EventEmitter();let routeHandler;
 const nav={isNavigationRequest:()=>true,frame:()=>page};
 const request={url:()=> 'https://example.com/analytics?token=private',method:()=> 'POST',resourceType:()=> 'xhr',frame:()=>page,isNavigationRequest:()=>false};
 const response={status:()=>status,request:()=>nav,allHeaders:async()=>({})};
 Object.assign(page,{
 url:()=> 'https://example.com/',mainFrame:()=>page,frames:()=>[page],
 goto:async()=>{
 if(background){
 await routeHandler({request:()=>request,abort:async()=>{request.failure=()=>({errorText:'net::ERR_ABORTED'});page.emit('requestfailed',request);}});
 const failed={...request,url:()=> 'https://example.com/gateway/graphql?token=private',failure:()=>({errorText:'net::ERR_HTTP2_PROTOCOL_ERROR'})};page.emit('requestfailed',failed);
 const http={...request,url:()=> 'https://example.com/background?token=private'};page.emit('response',{status:()=>503,url:http.url,request:()=>http});
 }
 return response;},
 evaluate:async()=>({ready:true,length:42,hash:1,matched:!missingSelector}),
 waitForTimeout:ms=>new Promise(r=>setTimeout(r,ms)),
 content:async()=>'<html><head><title>Order details</title></head><body>Ready for Pickup</body></html>',
 locator:()=>({count:async()=>0,innerText:async()=> 'Ready for Pickup'}),
 screenshot:async()=>Buffer.from('fixture'),
 });
 const context={pages:()=>[page],route:async(_pattern,fn)=>{routeHandler=fn;},routeWebSocket:async()=>{},close:async()=>{}};
 const engine=new Patronus(root,{launch:async()=>context});
 return {engine,root,cleanup:async()=>{await engine.close();rmSync(root,{recursive:true,force:true});}};
}
test('background policy, network and HTTP failures do not falsely fail captured page content',async()=>{
 const f=fixture({background:true});
 try{
 const args=patronusTools.patronus_start.schema.parse({urls:['https://example.com'],rendering:'browser',idempotencyKey:'background-lookup'});
 const job=f.engine.start(args);await f.engine.tick();
 const s=f.engine.status({jobId:job.jobId}),out=JSON.parse(f.engine.result({jobId:job.jobId}).content)[0];
 assert.equal(s.state,'succeeded');assert.equal(s.obstacles.length,0);assert.equal(s.warnings.length,3);
 assert.equal(s.outcome.contentCaptured,true);assert.equal(s.outcome.blockingIssues,0);assert.equal(s.outcome.warningCount,3);
 assert.match(out.markdown,/Ready for Pickup/);
 assert.ok(s.warnings.every(w=>w.blocking===false&&w.impact==='unknown'));
 assert.doesNotMatch(JSON.stringify(s.warnings),/token=private/);
 }finally{await f.cleanup();}
});
test('an explicitly requested missing selector remains incomplete even when text is captured',async()=>{
 const f=fixture({missingSelector:true});
 try{
 const args=patronusTools.patronus_start.schema.parse({urls:['https://example.com'],rendering:'browser',waitForSelector:'#order-status',browserWaitSeconds:5,idempotencyKey:'missing-order-status'});
 const job=f.engine.start(args);await f.engine.tick();const s=f.engine.status({jobId:job.jobId});
 assert.equal(s.state,'partial');assert.equal(s.obstacles[0].code,'REQUESTED_SELECTOR_NOT_FOUND');
 assert.equal(s.outcome.contentCaptured,true);assert.equal(s.outcome.blockingIssues,1);
 }finally{await f.cleanup();}
});
test('main-document denial remains a retrieval failure',async()=>{
 const f=fixture({status:403});
 try{
 const args=patronusTools.patronus_start.schema.parse({urls:['https://example.com'],rendering:'browser',idempotencyKey:'main-denial'});
 const job=f.engine.start(args);await f.engine.tick();const s=f.engine.status({jobId:job.jobId});
 assert.equal(s.state,'failed');assert.equal(s.obstacles[0].code,'ACCESS_DENIED');assert.equal(s.outcome.contentCaptured,false);
 }finally{await f.cleanup();}
});
test('warnings are bounded, redacted and cannot silently become evidence of objective failure',()=>{
 const d={};const req={url:()=> 'https://example.com/path?token=private',method:()=> 'POST',resourceType:()=> 'xhr'};
 for(let i=0;i<60;i++)addWarning(d,requestWarning(req,'SUBREQUEST_FAILED','BROWSER_TIMEOUT'));
 assert.equal(d.warnings.length,50);assert.equal(d.warningsOmitted,10);assert.equal(d.warnings[0].url,'https://example.com/path');
 assert.equal(d.warnings[0].blocking,false);assert.equal(d.warnings[0].impact,'unknown');
});
