import test from 'node:test';
import assert from 'node:assert/strict';
import {launchConfig,chromiumIdentity} from '../src/patronus/launch.js';
import {continueBrowserRequest,browserRequestPolicy} from '../src/patronus/browser-policy.js';
test('Chrome launch uses native automation control and fresh default permissions',()=>{
 for(const headed of [false,true]){
  const c=launchConfig({headed});
  assert.equal(c.channel,'chrome');
  assert.ok(c.args.includes('--disable-blink-features=AutomationControlled'));
  assert.ok(c.ignoreDefaultArgs.includes('--enable-automation'));
  assert.equal(c.permissions,undefined);assert.equal(c.userAgent,undefined);
 }
 const f=launchConfig({browser:'firefox'});
 assert.equal(f.channel,undefined);assert.equal(f.ignoreDefaultArgs,undefined);
});
test('Linux UA and high entropy metadata follow the running browser version',()=>{
 for(const n of [154,155]){
  const v={product:'Chrome/'+n+'.1.2.3',userAgent:'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/'+n+'.0.0.0 Safari/537.36'};
  const i=chromiumIdentity(v);
  assert.match(i.userAgent,new RegExp('Chrome/'+n));assert.doesNotMatch(i.userAgent,/Headless|Windows/);
  assert.equal(i.platform,'Linux x86_64');assert.equal(i.userAgentMetadata.platform,'Linux');
  assert.equal(i.userAgentMetadata.fullVersion,n+'.1.2.3');
  assert.equal(i.userAgentMetadata.bitness,'64');
  assert.equal(i.userAgentMetadata.brands,undefined);assert.equal(i.userAgentMetadata.fullVersionList,undefined);
 }
 assert.throws(()=>chromiumIdentity({product:'Chrome/154.0.0.0',userAgent:'Windows'}));
});
test('navigation preserves browser header order and routing while forms remain blocked',async()=>{
 let supplied='unset';
 const req={method:()=> 'GET',resourceType:()=> 'document'};
 await continueBrowserRequest({request:()=>req,continue:async options=>{supplied=options;}},browserRequestPolicy(req));
 assert.equal(supplied,undefined);
 req.method=()=> 'POST';assert.equal(browserRequestPolicy(req).reason,'FORM_SUBMISSION_POLICY');
});
