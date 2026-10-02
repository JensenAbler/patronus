import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Patronus } from '../src/patronus/engine.js';
import { patronusTools } from '../src/patronus/schema.js';
import { browserError } from '../src/patronus/browser-errors.js';
import { extract } from '../src/patronus/extract.js';

test('browser errors expose stable codes without exception text',()=>{
 for(const [message,stage,code] of [
 ['page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://example.com/?token=secret','navigation','BROWSER_HTTP2_ERROR'],
 ['net::ERR_NAME_NOT_RESOLVED secret','navigation','BROWSER_DNS_ERROR'],
 ['net::ERR_CERT_AUTHORITY_INVALID secret','navigation','BROWSER_TLS_ERROR'],
 ['net::ERR_CONNECTION_RESET secret','navigation','BROWSER_NETWORK_ERROR'],
 ['Timeout 3000ms exceeded secret','readiness','BROWSER_TIMEOUT'],
 ['Chromium sandboxing failed! secret','launch','BROWSER_LAUNCH_FAILED'],
 ['Target page, context or browser has been closed secret','extraction','BROWSER_CLOSED'],
 ['secret','extraction','BROWSER_RETRIEVAL_ERROR']
 ]){const r=browserError(new Error(message),stage);assert.equal(r.code,code);assert.equal(r.message,code);}
 assert.equal(browserError(Object.assign(new Error('secret'),{code:'BYTE_LIMIT'}),'extraction').code,'BYTE_LIMIT');
 const c=new AbortController();c.abort(Object.assign(new Error('secret'),{code:'TIMEOUT'}));
 assert.equal(browserError(new Error('closed'),'navigation',c.signal).code,'TIMEOUT');
});

test('navigation failure saves evidence before closing and never replays',async()=>{
 const root=mkdtempSync(join(tmpdir(),'patronus-navigation-test-'));
 const page=new EventEmitter();let closed=false,gotos=0;
 Object.assign(page,{url:()=> 'https://example.com/?token=secret',
 goto:async()=>{gotos++;throw new Error('page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://example.com/?token=secret');},
 content:async()=>{assert.equal(closed,false);return '<html><body>Connection failed</body></html>';},
 locator:()=>({innerText:async()=> 'Connection failed'}),
 screenshot:async()=>{throw new Error('renderer secret');}});
 const context={pages:()=>[page],route:async()=>{},routeWebSocket:async()=>{},close:async()=>{closed=true;}};
 const engine=new Patronus(root,{launch:async()=>context});
 try{
 const args=patronusTools.patronus_start.schema.parse({urls:['https://example.com'],rendering:'browser',idempotencyKey:'navigation-evidence'});
 const job=engine.start(args);await engine.tick();await engine.tick();
 const s=engine.status({jobId:job.jobId});
 assert.equal(s.state,'failed');assert.equal(gotos,1);assert.equal(closed,true);
 assert.equal(s.obstacles[0].code,'BROWSER_HTTP2_ERROR');assert.equal(s.diagnostics[0].stage,'navigation');
 assert.equal(s.diagnostics[0].captureErrors[0].part,'screenshot');
 assert.ok(s.diagnostics[0].artifacts.content);assert.ok(s.diagnostics[0].artifacts.text);
 assert.doesNotMatch(JSON.stringify(s),/token=secret|renderer secret/);assert.equal(page.listenerCount('request'),0);
 }finally{await engine.close();rmSync(root,{recursive:true,force:true});}
});

test('launch failures and global timeouts persist a diagnosis without replay',async()=>{
 for(const cancelled of [false,true]){
 const root=mkdtempSync(join(tmpdir(),'patronus-launch-test-'));let calls=0;
 const engine=new Patronus(root,{launch:async()=>{calls++;if(cancelled)engine.active.controller.abort(Object.assign(new Error('secret'),{code:'TIMEOUT'}));throw new Error('browser secret');}});
 try{
 const args=patronusTools.patronus_start.schema.parse({urls:['https://example.com'],rendering:'browser',idempotencyKey:'launch-evidence'});
 const job=engine.start(args);await engine.tick();await engine.tick();
 const s=engine.status({jobId:job.jobId}),code=cancelled?'TIMEOUT':'BROWSER_LAUNCH_FAILED';
 assert.equal(s.state,'failed');assert.equal(calls,1);assert.equal(s.obstacles[0].code,code);
 assert.equal(s.diagnostics[0].reason,code);assert.equal(s.diagnostics[0].stage,'launch');
 assert.doesNotMatch(JSON.stringify(s),/browser secret/);
 }finally{await engine.close();rmSync(root,{recursive:true,force:true});}
 }
});

test('form metadata reveals requirements without values, tokens or passwords',()=>{
 const r=extract('<form method="post" action="/lookup?token=secret"><label for="order">Order number</label><input id="order" name="order" value="private-order" required><input type="hidden" name="csrf" value="private-token"><input type="password" name="password" value="private-password"><textarea name="notes">private-notes</textarea><button>Lookup</button></form>','https://example.com/');
 assert.equal(r.forms[0].method,'POST');assert.equal(r.forms[0].fields[0].label,'Order number');
 assert.equal(r.forms[0].fields[0].required,true);assert.equal(r.forms[0].hasPassword,true);
 assert.equal(r.forms[0].fieldsOmitted,2);assert.equal(r.forms[0].submissionSupported,false);
 assert.doesNotMatch(JSON.stringify(r),/private-order|private-token|private-password|private-notes|token=secret/);
 const b=extract('<form>'+('<input name="f">'.repeat(60))+'</form>'+('<form></form>'.repeat(22)),'https://example.com');
 assert.equal(b.forms.length,20);assert.equal(b.coverage.formsOmitted,3);assert.equal(b.forms[0].fields.length,50);
 assert.equal(extract('<form action="javascript:alert(1)"></form>','https://example.com').forms[0].action,null);
});

test('a screenshot error keeps extracted content and marks the job partial',async()=>{
 const root=mkdtempSync(join(tmpdir(),'patronus-screenshot-test-'));
 const page=new EventEmitter();let closed=false;
 Object.assign(page,{url:()=> 'https://example.com/',goto:async()=>null,
 evaluate:async()=>{},waitForTimeout:ms=>new Promise(r=>setTimeout(r,ms)),frames:()=>[],
 content:async()=>'<html><head><title>Lookup</title></head><body>Order status available<form><input name="order"></form></body></html>',
 locator:()=>({count:async()=>0}),screenshot:async()=>{throw new Error('private screenshot failure');}});
 const context={pages:()=>[page],route:async()=>{},routeWebSocket:async()=>{},close:async()=>{closed=true;}};
 const engine=new Patronus(root,{launch:async()=>context});
 try{
 const args=patronusTools.patronus_start.schema.parse({urls:['https://example.com'],rendering:'browser',screenshot:true,idempotencyKey:'screenshot-content'});
 const job=engine.start(args);await engine.tick();
 const s=engine.status({jobId:job.jobId}),result=JSON.parse(engine.result({jobId:job.jobId}).content)[0];
 assert.equal(s.state,'partial');assert.equal(s.obstacles[0].code,'SCREENSHOT_UNAVAILABLE');
 assert.match(result.markdown,/Order status available/);assert.equal(result.forms.length,1);assert.equal(closed,true);
 assert.doesNotMatch(JSON.stringify(s),/private screenshot failure/);
 }finally{await engine.close();rmSync(root,{recursive:true,force:true});}
});
