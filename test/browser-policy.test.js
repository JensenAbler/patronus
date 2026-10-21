import test from 'node:test';
import assert from 'node:assert/strict';
import { browserRequestPolicy,blockedRequest,continueBrowserRequest } from '../src/patronus/browser-policy.js';
import { waitForReadiness } from '../src/patronus/readiness.js';
import { extract } from '../src/patronus/extract.js';
import { patronusTools } from '../src/patronus/schema.js';
const request=(body={query:'query Calendar { events { title } }'},overrides={})=>({
 method:()=> 'POST',url:()=> 'https://calendar.example/graphql-public',
 resourceType:()=> 'fetch',frame:()=>({url:()=> 'https://calendar.example/calendar'}),
 headers:()=>({'content-type':'application/json; charset=utf-8'}),postData:()=>JSON.stringify(body),...overrides
});
test('Page-issued requests load; only body-carrying navigations (form submissions) are blocked',()=>{
 for(const overrides of [{},{method:()=> 'PUT'},{resourceType:()=> 'xhr'},{resourceType:()=> 'ping'},
  {url:()=> 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/flow'},
  {headers:()=>({'content-type':'application/x-www-form-urlencoded'})},{resourceType:()=>{throw Error('gone');}}
 ])assert.equal(browserRequestPolicy(request(undefined,overrides)).allowed,true,JSON.stringify(Object.keys(overrides)));
 for(const method of ['POST','PUT','DELETE'])assert.deepEqual(
  browserRequestPolicy(request(undefined,{method:()=>method,resourceType:()=> 'document'})),{allowed:false,reason:'FORM_SUBMISSION_POLICY'});
 assert.equal(browserRequestPolicy(request(undefined,{method:()=> 'GET',resourceType:()=> 'document'})).allowed,true);
});
test('Request diagnostics omit all bodies, headers, and query-string values',()=>{
 const d=blockedRequest(request({password:'DO-NOT-LOG'},{
  url:()=> 'https://user:password@calendar.example/graphql?token=SECRET&q=PRIVATE#FRAGMENT'
 }),'METHOD_POLICY');
 assert.equal(d.url,'https://calendar.example/graphql');
 assert.doesNotMatch(JSON.stringify(d),/SECRET|PRIVATE|FRAGMENT|password|DO-NOT-LOG/);
});
function fixture({pendingUntil=0,changeAt=0,matchAt=0,child=false}={}){
 let t=0,lastActivity=0;const pending=new Set();const frame={evaluate:async()=>({url:'https://example.com',length:t>=changeAt?20:10,hash:t>=changeAt?2:1,matched:t>=matchAt,ready:true})};
 const page={frames:()=>child?[{evaluate:async()=>({url:'https://parent.example',length:5,hash:1,matched:false,ready:true})},frame]:[frame]};
 return {page,tracker:{pending,changedAt:()=>lastActivity},options:{clock:()=>t,sleep:async ms=>{t+=ms;if(t<pendingUntil)pending.add(1);else if(pending.size){pending.clear();lastActivity=t;}}}};
}
test('Readiness waits for delayed API completion and changing child-frame content',async()=>{
 const f=fixture({pendingUntil:6500,changeAt:7000,child:true});
 const r=await waitForReadiness(f.page,f.tracker,{...f.options,selector:'.event'});
 assert.equal(r.outcome,'settled');assert.ok(r.elapsedMs>=8000);
});
test('A missing selector or unfinished request reports incomplete capture',async()=>{
 const f=fixture({matchAt:Infinity});
 const r=await waitForReadiness(f.page,f.tracker,{...f.options,timeoutMs:6000,selector:'.event'});
 assert.equal(r.outcome,'timeout');assert.equal(r.selectorMatched,false);
 const g=fixture({pendingUntil:Infinity});
 const p=await waitForReadiness(g.page,g.tracker,{...g.options,timeoutMs:6000});
 assert.equal(p.outcome,'timeout');assert.equal(p.pendingRequests,1);
});
test('Readiness cancellation and explicit wait options are honored',async()=>{
 const f=fixture(),c=new AbortController();c.abort(new Error('cancelled'));
 await assert.rejects(waitForReadiness(f.page,f.tracker,{...f.options,signal:c.signal}),/cancelled/);
 const a=patronusTools.patronus_start.schema.parse({urls:['https://example.com'],idempotencyKey:'wait-options',browserWaitSeconds:30,waitForSelector:'.event'});
 assert.equal(a.browserWaitSeconds,30);assert.equal(a.waitForSelector,'.event');
});
test('Empty embedded bodies never fall back to unsanitized script HTML',()=>{
 const r=extract('<html><head><title>Blank</title></head><body><script>secretExecutable()</script></body></html>','https://example.com');
 assert.doesNotMatch(r.markdown,/secretExecutable/);
});

test('Permitted query POSTs do not follow redirects or replay requests',async()=>{
 let fulfilled=false,disposed=false;
 const route={fetch:async options=>{assert.equal(options.maxRedirects,0);return {status:()=>307,dispose:async()=>{disposed=true;}};},fulfill:async()=>{fulfilled=true;}};
 await assert.rejects(continueBrowserRequest(route,{kind:'graphql-query'}),{code:'POST_REDIRECT_POLICY'});
 assert.equal(fulfilled,false);assert.equal(disposed,true);
 const response={status:()=>200,dispose:async()=>{}};
 route.fetch=async()=>response;
 route.fulfill=async options=>{assert.equal(options.response,response);fulfilled=true;};
 await continueBrowserRequest(route,{kind:'graphql-query'});assert.equal(fulfilled,true);
});
test('New wait defaults do not change normalized historical idempotency inputs',()=>{
 const a=patronusTools.patronus_start.schema.parse({urls:['https://example.com'],idempotencyKey:'historical-input'});
 assert.equal(Object.hasOwn(a,'browserWaitSeconds'),false);
});
