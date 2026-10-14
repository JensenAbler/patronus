import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createHandoff} from '../src/handoff.js';
import {createDesktopLease} from '../src/patronus/desktop-lease.js';

async function fixture(t,{call,typeText,https=false,leaseControl}={}) {
 const app=express(), server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const origin='http://127.0.0.1:'+server.address().port;
 let time=1700000000000;
 const calls=[];
 const handoff=createHandoff({baseUrl:(https?'https://example.test':origin)+'/patronus',now:()=>time,
   typeText,leaseControl,
   verifyPassword:async password=>password==='fixture-only-password',
   call:call|| (async(name,args)=>{calls.push({name,args});return {screenshot:'/9j/AA==',screenshotMimeType:'image/jpeg',desktop:{startedAt:'unchanged-desktop',state:'running',display:':77'}};})});
 app.use('/patronus/handoff',handoff.router);
 t.after(async()=>{handoff.close();await new Promise(r=>server.close(r));});
 const browsers=[];
 function browser() {
   const jar=new Map();let csrf;
   async function request(route='',{method='GET',body,headers={},raw}={}) {
     const response=await fetch(origin+'/patronus/handoff'+route,{method,redirect:'manual',headers:{
       cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),...(method==='POST'?{origin:https?'https://example.test':origin,'content-type':'application/json','x-handoff-csrf':csrf||''}:{}),...headers},
       ...(body===undefined?{}:{body:raw?body:JSON.stringify(body)})});
     for(const cookie of response.headers.getSetCookie()) {const [pair]=cookie.split(';'), at=pair.indexOf('=');jar.set(pair.slice(0,at),pair.slice(at+1));}
     return response;
   }
   async function login(password='fixture-only-password') {
     const landing=await request(),html=await landing.text(),token=html.match(/name="csrf" value="([^"]+)"/)?.[1];assert.ok(token);
     const result=await request('/login',{method:'POST',body:{csrf:token,password}});
     if(result.status!==303)return result;
     const signed=await request();const text=await signed.text();csrf=text.match(/"csrf":"([^"]+)"/)?.[1];assert.ok(csrf);return signed;
   }
   const b={request,login,jar,get csrf(){return csrf;},post:(route,body={},headers)=>request(route,{method:'POST',body,headers})};browsers.push(b);return b;
 }
 return {browser,handoff,calls,origin,advance:ms=>time+=ms};
}
async function take(b){assert.equal((await b.post('/take')).status,200);const r=await b.post('/frame');assert.equal(r.status,200);return r.json();}
test('no desktop pixels before owner login; login is CSRF/origin protected',async t=>{
 const f=await fixture(t),b=f.browser();
 assert.equal((await b.post('/frame')).status,401);
 assert.equal((await b.post('/login',{password:'fixture-only-password'},{origin:'https://evil.test'})).status,403);
 assert.equal((await b.post('/login',{password:'fixture-only-password'})).status,403);
 const wrong=await b.login('wrong');assert.equal(wrong.status,401);
 assert.equal(f.calls.length,0);
 const good=await b.login();assert.equal(good.status,200);assert.equal(good.headers.get('cache-control'),'no-store, max-age=0');
 assert.match(good.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 assert.equal((await b.post('/frame')).status,409);assert.equal(f.calls.length,0);
});
test('secure cookie scope, strict SameSite, HttpOnly and no bearer URL',async t=>{
 const f=await fixture(t,{https:true}),b=f.browser();
 const r=await b.request();assert.match(r.headers.get('set-cookie'),/Secure/);assert.match(r.headers.get('set-cookie'),/HttpOnly/);assert.match(r.headers.get('set-cookie'),/SameSite=Strict/);assert.match(r.headers.get('set-cookie'),/Path=\/patronus\/handoff/);
 const html=await r.text();assert.doesNotMatch(html,/\?(token|password)=/);
});
test('one owner lease; agent desktop calls locked including screenshots',async t=>{
 const f=await fixture(t),a=f.browser(),b=f.browser();await a.login();await b.login();
 await take(a);assert.equal((await b.post('/take')).status,409);
 await assert.rejects(f.handoff.guard('patronus_desktop',async()=>assert.fail('must not execute')),e=>e.code==='DESKTOP_HUMAN_CONTROL');
 assert.equal(await f.handoff.guard('patronus_status',async()=>42),42);
 assert.equal((await a.post('/finish')).status,200);
 assert.equal((await a.post('/frame')).status,401);
 assert.equal((await b.post('/take')).status,200);
});
test('CSRF and exact origin required for every input and screenshot',async t=>{
 const f=await fixture(t),b=f.browser();await b.login();await take(b);
 const before=f.calls.length;
 assert.equal((await b.post('/frame',{}, {'x-handoff-csrf':'wrong'})).status,403);
 assert.equal((await b.post('/action',{}, {origin:'null'})).status,403);
 assert.equal((await b.post('/finish',{}, {origin:'https://evil.test'})).status,403);
 assert.equal(f.calls.length,before);
});
test('click sequences and frames consumed once; no credential or arbitrary API input',async t=>{
 const f=await fixture(t),b=f.browser();await b.login();const frame=await take(b);
 const args={action:'click',x:300,y:400,frameId:frame.frameId,sequence:frame.nextSequence};
 assert.equal((await b.post('/action',{...args,credential:'x10-password'})).status,400);
 assert.equal((await b.post('/action',{...args,action:'navigate',url:'https://example.test'})).status,400);
 assert.equal((await b.post('/action',{...args,x:1280})).status,400);
 assert.equal((await b.post('/action',args)).status,200);
 assert.equal((await b.post('/action',args)).status,409);
 assert.equal(f.calls.filter(x=>x.args.action==='click').length,1);
 assert.equal(f.calls.find(x=>x.args.action==='click').args.x,300);
});
test('idle release, absolute expiry and stale frames are enforced',async t=>{
 const f=await fixture(t),b=f.browser();await b.login();let frame=await take(b);
 f.advance(16000);
 assert.equal((await b.post('/action',{action:'key',key:'Enter',sequence:frame.nextSequence,frameId:frame.frameId})).status,409);
 f.advance(61000);
 assert.equal((await b.post('/frame')).status,409);
 assert.equal(await f.handoff.guard('patronus_desktop',async()=>42),42);
 frame=await take(b);assert.ok(frame.frameId);
 f.advance(900001);
 assert.equal((await b.post('/frame')).status,401);
});
test('agent action already running prevents human take until settled',async t=>{
 const f=await fixture(t),b=f.browser();await b.login();
 let done;const running=f.handoff.guard('patronus_desktop',()=>new Promise(r=>done=r));
 assert.equal((await b.post('/take')).status,409);
 done();await running;assert.equal((await b.post('/take')).status,200);
});
test('in-flight frame finishing after revoke cannot leak pixels or race agent',async t=>{
 let settle;const f=await fixture(t,{call:()=>new Promise(r=>settle=r)}),b=f.browser();await b.login();assert.equal((await b.post('/take')).status,200);
 const pending=b.post('/frame');while(!settle)await new Promise(r=>setTimeout(r,2));
 await b.post('/finish');
 await assert.rejects(f.handoff.guard('patronus_desktop',async()=>true),e=>e.code==='DESKTOP_BUSY');
 settle({screenshot:'private-pixels',screenshotMimeType:'image/jpeg',desktop:{startedAt:'same'}});
 const response=await pending;assert.equal(response.status,409);assert.doesNotMatch(await response.text(),/private-pixels/);
});
test('private text uses the dedicated stdin helper with one-use action checks',async t=>{
 const typed=[];const f=await fixture(t,{typeText:async args=>typed.push(args)}),b=f.browser();
 await b.login();let frame=await take(b);
 const secret='synthetic-private-value';
 const args={action:'type',text:secret,sequence:frame.nextSequence,frameId:frame.frameId};
 const r=await b.post('/action',args);assert.equal(r.status,200);assert.equal((await r.text()).includes(secret),false);
 assert.equal(typed.length,1);assert.equal(typed[0].text,secret);assert.equal(typed[0].display,':77');
 assert.equal(f.calls.some(x=>JSON.stringify(x).includes(secret)),false,'text must not reach reader/MCP calls');
 assert.equal((await b.post('/action',args)).status,409);assert.equal(typed.length,1);
 frame=await (await b.post('/frame')).json();
 assert.equal((await b.post('/action',{...args,text:'secret\nsubmit',frameId:frame.frameId,sequence:frame.nextSequence})).status,400);
 assert.equal(typed.length,1);
});
test('Done aborts active typing and no screenshot follows revocation',async t=>{
 let signal,complete;const f=await fixture(t,{typeText:args=>{signal=args.signal;return new Promise(r=>complete=r);}}),b=f.browser();
 await b.login();const frame=await take(b);
 const pending=b.post('/action',{action:'type',text:'synthetic-only',sequence:frame.nextSequence,frameId:frame.frameId});
 while(!signal)await new Promise(r=>setTimeout(r,2));
 await b.post('/finish');assert.equal(signal.aborted,true);complete();
 assert.equal((await pending).status,409);assert.equal(f.calls.filter(x=>x.name==='patronus_desktop').length,1);
});
test('changed desktop identity is detected before any click is sent',async t=>{
 const calls=[];const f=await fixture(t,{call:async(name,args)=>{calls.push({name,args});return {screenshot:'a',screenshotMimeType:'image/jpeg',desktop:{startedAt:name==='patronus_capabilities'?'restarted':'original'}};}}),b=f.browser();
 await b.login();const frame=await take(b);
 const r=await b.post('/action',{action:'click',x:10,y:10,sequence:frame.nextSequence,frameId:frame.frameId});
 assert.equal(r.status,409);assert.equal((await r.json()).error,'DESKTOP_SESSION_CHANGED');
 assert.equal(calls.some(x=>x.args.action==='click'),false);
});

test('restarted desktop refuses continuing the old control session',async t=>{
 let n=0;const f=await fixture(t,{call:async()=>({screenshot:'a',screenshotMimeType:'image/jpeg',desktop:{startedAt:++n===1?'first':'second'}})}),b=f.browser();
 await b.login();await take(b);const r=await b.post('/frame');assert.equal(r.status,409);assert.equal((await r.json()).error,'DESKTOP_SESSION_CHANGED');
});

test('concurrent agent guards are exclusive across a compound operation',async t=>{
 const f=await fixture(t);let finish;
 const pending=f.handoff.guard('patronus_desktop',()=>new Promise(r=>finish=r));
 await assert.rejects(f.handoff.guard('patronus_desktop',()=>assert.fail()),{code:'DESKTOP_BUSY'});
 finish();await pending;
 assert.equal(await f.handoff.guard('patronus_desktop',()=>42),42);
});
test('reader lease is private; Done drains native input before another owner or raw call',async t=>{
 const reader=createDesktopLease();t.after(()=>reader.close());let finish,started;const entered=new Promise(r=>started=r);
 const f=await fixture(t,{leaseControl:async(action,args)=>reader[action](args),call:async(name,args,options)=>{
   if(name!=='patronus_desktop')return {desktop:{startedAt:'reader-session'}};
   return reader.run(options?.leaseId,async()=>{started();await new Promise(r=>finish=r);return {screenshot:'private-pixels',screenshotMimeType:'image/jpeg',desktop:{startedAt:'reader-session'}};});
 }}),a=f.browser(),b=f.browser();
 await a.login();await b.login();const takeResponse=await a.post('/take');
 assert.equal(takeResponse.status,200);assert.doesNotMatch(await takeResponse.text(),/leaseId/);
 await assert.rejects(reader.run(undefined,()=>assert.fail()),{code:'DESKTOP_HUMAN_CONTROL'});
 const pending=a.post('/frame');await entered;
 assert.equal((await a.post('/finish')).status,200);
 for(let n=0;n<100&&!reader.status().draining;n++)await new Promise(r=>setTimeout(r,2));
 assert.equal(reader.status().draining,true);
 assert.equal((await b.post('/take')).status,409);
 await assert.rejects(reader.run(undefined,()=>assert.fail()),{code:'DESKTOP_HUMAN_CONTROL'});
 finish();const response=await pending;assert.equal(response.status,409);
 assert.doesNotMatch(await response.text(),/private-pixels/);
 assert.equal((await b.post('/take')).status,200);
});
test('reader-routed owner text uses private envelope and never the gateway native helper',async t=>{
 const reader=createDesktopLease();t.after(()=>reader.close());let typed;
 const f=await fixture(t,{leaseControl:async(action,args)=>reader[action](args),typeText:()=>assert.fail('gateway must not inject text'),
   call:async(name,args,options)=>{
    if(name!=='patronus_desktop')return {desktop:{startedAt:'reader-session',state:'running'}};
    return reader.run(options?.leaseId,async context=>{
     if(args.action==='type'){assert.equal(context.kind,'owner');assert.equal(options.ownerText,true);typed=args.text;}
     return {screenshot:'synthetic-frame',screenshotMimeType:'image/jpeg',desktop:{startedAt:'reader-session'}};
    });
   }}),b=f.browser();
 await b.login();const frame=await take(b),text='synthetic private value';
 const response=await b.post('/action',{action:'type',text,frameId:frame.frameId,sequence:frame.nextSequence});
 assert.equal(response.status,200);assert.equal(typed,text);
 const body=await response.text();assert.equal(body.includes(text),false);assert.equal(body.includes('leaseId'),false);
});
test('Done while a reader lease acquisition is pending releases it without granting control',async t=>{
 const reader=createDesktopLease();t.after(()=>reader.close());let finish,started;const entered=new Promise(r=>started=r);
 const f=await fixture(t,{leaseControl:async(action,args)=>{
  if(action==='acquire'){started();await new Promise(r=>finish=r);}
  return reader[action](args);
 }}),b=f.browser();await b.login();
 const pending=b.post('/take');await entered;
 assert.equal((await b.post('/take')).status,409);
 assert.equal((await b.post('/finish')).status,200);
 finish();const response=await pending;assert.equal(response.status,409);
 assert.equal(reader.status().held,false);
 assert.equal(f.handoff.status().controlActive,false);
});
test('unknown call and release responses keep the native reader gate until settlement',async t=>{
 const reader=createDesktopLease();t.after(()=>reader.close());let finish,native;
 const f=await fixture(t,{leaseControl:async(action,args)=>{
  const result=reader[action](args);
  if(action==='release')throw Object.assign(Error('fixture release response lost'),{code:'BACKEND_UNAVAILABLE'});
  return result;
 }});
 await assert.rejects(f.handoff.guard('patronus_desktop',leaseId=>{
  native=reader.run(leaseId,()=>new Promise(r=>finish=r));
  throw Object.assign(Error('fixture desktop response lost'),{code:'BACKEND_UNAVAILABLE'});
 }),{code:'BACKEND_UNAVAILABLE'});
 assert.equal(reader.status().draining,true);
 assert.equal(reader.status().inFlight,true);
 await assert.rejects(reader.run(undefined,()=>assert.fail()),{code:'DESKTOP_BUSY'});
 await assert.rejects(f.handoff.guard('patronus_desktop',()=>assert.fail()),{code:'DESKTOP_BUSY'});
 finish();await native;
 assert.equal(reader.status().held,false);
 assert.equal(await f.handoff.guard('patronus_desktop',leaseId=>reader.run(leaseId,()=>42)),42);
});

test('owner actions pin the observed desktop session in the private envelope',async t=>{
 const reader=createDesktopLease();t.after(()=>reader.close());const seen=[];
 const f=await fixture(t,{leaseControl:async(action,args)=>reader[action](args),call:async(name,args,options)=>{
  if(name!=='patronus_desktop')return {desktop:{startedAt:'owner-observed-session',state:'running'}};
  return reader.run(options.leaseId,()=>{seen.push({action:args.action,expected:options.expectedDesktopStartedAt});
   return {screenshot:'synthetic-frame',screenshotMimeType:'image/jpeg',desktop:{startedAt:'owner-observed-session'}};});
 }}),b=f.browser();await b.login();const frame=await take(b);
 const response=await b.post('/action',{action:'click',x:25,y:25,frameId:frame.frameId,sequence:frame.nextSequence});
 assert.equal(response.status,200);
 assert.deepEqual(seen,[{action:'screenshot',expected:undefined},{action:'click',expected:'owner-observed-session'}]);
 assert.doesNotMatch(await response.text(),/expectedDesktopStartedAt|leaseId/);
});
