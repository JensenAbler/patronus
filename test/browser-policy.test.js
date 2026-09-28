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
test('GraphQL queries are allowed only with inspectable same-origin HTTPS bodies',()=>{
 for(const body of [
  {query:'{ events { title } }'},
  {query:'query Calendar($id: ID!) { event(id:$id) { ...Fields } } fragment Fields on Event { title }',variables:{id:'1'},operationName:'Calendar'},
  {query:'query A { one } query B { two }',operationName:'B'}
 ])assert.equal(browserRequestPolicy(request(body)).kind,'graphql-query');
 for(const body of [
  {query:'mutation { buyTicket }'}, {query:'subscription { messages }'},
  {query:'query A { title } mutation B { deleteAccount }',operationName:'A'},
  {query:'query A { title }',operationName:'Wrong'},
  {query:'query A { title } query B { title }'},
  {query:'mutation { x } # query { safe }'}, {query:'not valid'},
  [{query:'{ title }'}],{extensions:{persistedQuery:{sha256Hash:'opaque'}}},
  {query:'{title}',extensions:{}},{query:'{title}',variables:[]},
  {query:'{title}',operationName:3},{query:'{title}',unexpected:'action'}
 ])assert.equal(browserRequestPolicy(request(body)).allowed,false,JSON.stringify(body));
 for(const overrides of [
  {method:()=> 'PUT'},{method:()=> 'DELETE'},{resourceType:()=> 'document'},
  {url:()=> 'https://evil.example/graphql-public'},
  {url:()=> 'https://calendar.example/checkout'},
  {url:()=> 'http://calendar.example/graphql-public'},
  {headers:()=>({'content-type':'application/x-www-form-urlencoded'})},
  {postData:()=>'{bad'}, {postData:()=>JSON.stringify({query:' '.repeat(262144)+'{title}'})},
  {frame:()=>{throw Error('no frame');}}
 ])assert.equal(browserRequestPolicy(request(undefined,overrides)).allowed,false);
 assert.equal(browserRequestPolicy(request(undefined,{method:()=> 'GET'})).allowed,true);
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
