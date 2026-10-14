import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '../src/patronus/server.js';
import { patronusCall,patronusLease } from '../src/patronus/client.js';

async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'desktop-lease-reader-')),socket=join(root,'reader.sock');
 const service=await serve({root,socket});
 const desktop={healthy:()=>true,display:':77',status:()=>({state:'running',startedAt:'fixture-desktop',display:':77'}),stop:async()=>{}};
 const control={view:{width:1280,height:720},screenshot:async()=>Buffer.from('fixture pixels')};
 service.engine.desktop=desktop;service.engine.desktopControl=control;service.engine.control=()=>control;
 t.after(async()=>{await service.close();rmSync(root,{recursive:true,force:true});});
 return {...service,control,socket,call:(action,args,options)=>patronusCall(action,args,{...options,socket}),lease:(action,args)=>patronusLease(action,args,{socket})};
}
const shot=key=>({action:'screenshot',idempotencyKey:key});
test('private Unix lease blocks raw desktop calls and does not enter the public tool schema',async t=>{
 const f=await fixture(t),owner=await f.lease('acquire',{kind:'owner'});
 await assert.rejects(f.call('patronus_desktop',shot('raw-blocked-fixture')),{code:'DESKTOP_HUMAN_CONTROL'});
 await assert.rejects(f.call('patronus_desktop',{...shot('envelope-not-args'),leaseId:owner.leaseId}),{code:'INVALID_ARGUMENT'});
 const result=await f.call('patronus_desktop',shot('owner-frame-fixture'),{leaseId:owner.leaseId});
 assert.equal(result.screenshot,Buffer.from('fixture pixels').toString('base64'));
 assert.equal(JSON.stringify(result).includes(owner.leaseId),false);
 assert.equal(JSON.stringify(await f.lease('status')).includes(owner.leaseId),false);
 await assert.rejects(f.lease('acquire',{kind:'agent'}),{code:'DESKTOP_HUMAN_CONTROL'});
 await f.lease('release',{leaseId:owner.leaseId});
 assert.equal((await f.call('patronus_desktop',shot('raw-unlocked-fixture'))).action,'screenshot');
});
test('release and timeout cannot hand over a native action still running in reader',async t=>{
 const f=await fixture(t),agent=await f.lease('acquire',{kind:'agent'});
 let started,finish;const entered=new Promise(r=>started=r);
 f.control.screenshot=async()=>{started();await new Promise(r=>finish=r);return Buffer.from('delayed frame');};
 const pending=f.call('patronus_desktop',shot('uncertain-frame-fixture'),{leaseId:agent.leaseId,timeout:30});
 const rejected=assert.rejects(pending,{code:'BACKEND_UNAVAILABLE'});
 await entered;await rejected;
 assert.equal((await f.lease('status')).inFlight,true);
 const release=await f.lease('release',{leaseId:agent.leaseId});assert.equal(release.draining,true);
 await assert.rejects(f.lease('acquire',{kind:'owner'}),{code:'DESKTOP_BUSY'});
 await assert.rejects(f.call('patronus_desktop',shot('raw-draining-fixture')),{code:'DESKTOP_BUSY'});
 finish();
 for(let n=0;n<100&&(await f.lease('status')).held;n++)await new Promise(r=>setTimeout(r,2));
 assert.equal((await f.lease('status')).held,false);
 const owner=await f.lease('acquire',{kind:'owner'});await f.lease('release',{leaseId:owner.leaseId});
});
test('raw reader action prevents lease acquisition until actual promise settles',async t=>{
 const f=await fixture(t);let started,finish;const entered=new Promise(r=>started=r);
 f.control.screenshot=async()=>{started();await new Promise(r=>finish=r);return Buffer.from('raw frame');};
 const pending=f.call('patronus_desktop',shot('raw-in-flight-fixture'));await entered;
 await assert.rejects(f.lease('acquire',{kind:'owner'}),{code:'DESKTOP_BUSY'});
 finish();await pending;
 const agent=await f.lease('acquire',{kind:'agent'});await f.lease('release',{leaseId:agent.leaseId});
});
test('private owner text requires a current owner lease before native helper execution',async t=>{
 const f=await fixture(t),agent=await f.lease('acquire',{kind:'agent'});
 await assert.rejects(f.call('patronus_desktop',{action:'type',text:'fixture only',idempotencyKey:'private-text-agent-fixture'},{leaseId:agent.leaseId,ownerText:true}),{code:'DESKTOP_OWNER_TEXT_POLICY'});
 await assert.rejects(f.call('patronus_desktop',{action:'type',text:'fixture only',idempotencyKey:'private-text-raw-fixture'},{ownerText:true}),{code:'INVALID_ARGUMENT'});
 await assert.rejects(f.call('patronus_capabilities',{}, {leaseId:agent.leaseId}),{code:'INVALID_ARGUMENT'});
 await f.lease('release',{leaseId:agent.leaseId});
});
test('transport accepts engine-sized frames above old two-million-character limit',async t=>{
 const f=await fixture(t);f.control.screenshot=async()=>Buffer.alloc(2400000,65);
 const result=await f.call('patronus_desktop',shot('large-frame-fixture'));
 assert.equal(Buffer.from(result.screenshot,'base64').length,2400000);
});
test('transport rejects malformed, aborted and oversized responses without replay',async t=>{
 const root=mkdtempSync(join(tmpdir(),'desktop-client-test-')),socket=join(root,'transport.sock');
 let requests=0,mode='malformed';
 const server=http.createServer(async(req,res)=>{
  requests++;for await(const _ of req){}
  if(mode==='malformed'){res.end('{broken');return;}
  if(mode==='abort'){res.writeHead(200,{'content-type':'application/json'});res.write('{"ok":true,"data":"');setImmediate(()=>res.destroy());return;}
  if(mode==='oversize'){res.end(JSON.stringify({ok:true,data:'x'.repeat(10000)}));return;}
  res.end(JSON.stringify({ok:false,error:{code:'DESKTOP_BUSY',message:'must not expose fixture path'}}));
 });
 await new Promise(r=>server.listen(socket,r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true});});
 for(mode of ['malformed','abort','oversize']){
  await assert.rejects(patronusCall('patronus_capabilities',{}, {socket,maxResponseBytes:1000,timeout:1000}),{code:'BACKEND_UNAVAILABLE'});
 }
 mode='known';
 await assert.rejects(patronusCall('patronus_capabilities',{}, {socket}),e=>e.code==='DESKTOP_BUSY'&&!e.message.includes('fixture path'));
 assert.equal(requests,4);
});

test('private owner session expectation is bounded and kept out of public tool arguments',async t=>{
 const f=await fixture(t),owner=await f.lease('acquire',{kind:'owner'});
 const input={action:'click',x:5,y:5,idempotencyKey:'owner-session-fixture'};
 for(const expectedDesktopStartedAt of ['', 'x'.repeat(101),42]){
  await assert.rejects(f.call('patronus_desktop',input,{leaseId:owner.leaseId,expectedDesktopStartedAt}),{code:'INVALID_ARGUMENT'});
 }
 await assert.rejects(f.call('patronus_desktop',shot('owner-session-snapshot'),{leaseId:owner.leaseId,expectedDesktopStartedAt:'fixture-desktop'}),{code:'INVALID_ARGUMENT'});
 await assert.rejects(f.call('patronus_desktop',{...input,expectedDesktopStartedAt:'fixture-desktop'},{leaseId:owner.leaseId}),{code:'INVALID_ARGUMENT'});
 await assert.rejects(f.call('patronus_desktop',input,{expectedDesktopStartedAt:'fixture-desktop'}),{code:'INVALID_ARGUMENT'});
 f.control.click=async()=>assert.fail('a stale owner session must not click');
 await assert.rejects(f.call('patronus_desktop',input,{leaseId:owner.leaseId,expectedDesktopStartedAt:'old-desktop'}),{code:'DESKTOP_SESSION_CHANGED'});
 await f.lease('release',{leaseId:owner.leaseId});
});
