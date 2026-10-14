import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { createDiagnostic, isApplicationPage, APPLICATION_URL } from "../diagnostics/lever-verification/core.js";

async function fixture(diagnosticFactory) {
  const elements = new Map();
  const callbacks = {};
  const state = { url:APPLICATION_URL, deferred:false, evals:[], interval:null };
  function element(id) {
    if (!elements.has(id)) elements.set(id,{textContent:"", addEventListener:(name,fn)=>{callbacks[id+":"+name]=fn;}});
    return elements.get(id);
  }
  const network={onNavigated:{addListener:fn=>{callbacks.navigate=fn;}},onRequestFinished:{addListener:fn=>{callbacks.request=fn;}}};
  const source=(await readFile(new URL("../diagnostics/lever-verification/panel.js",import.meta.url),"utf8")).replace(/^import .*;\n/,"");
  vm.runInNewContext(source,{
    createDiagnostic:diagnosticFactory || (()=>createDiagnostic({now:()=>Date.parse("2026-10-13T22:00:00Z")})),isApplicationPage,URL,JSON,Promise,
    document:{getElementById:element},window:{addEventListener:(name,fn)=>{callbacks[name]=fn;}},
    chrome:{devtools:{network,inspectedWindow:{eval:(expression,callback)=>{
      assert.equal(expression,"location.href");
      if(state.deferred) state.evals.push(callback);else callback(state.url);
    }}}},
    setInterval:fn=>{state.interval=fn;},setTimeout:()=>1,clearTimeout:()=>{}
  });
  return {elements,callbacks,state};
}
function request() {
  return {request:{url:APPLICATION_URL,method:"POST",postData:{params:[{name:"h-captcha-response",value:"SYNTHETIC-TOKEN"}]}},response:{status:400},startedDateTime:"2026-10-13T22:00:00Z"};
}
test("panel is inert until manual arm and renders only redacted synthetic output",async()=>{
  const f=await fixture();
  await f.callbacks.request({get request(){throw Error("must not read");}});
  await f.callbacks["arm:click"]();
  await f.callbacks.request(request());
  const result=JSON.parse(f.elements.get("lever").textContent);
  assert.equal(result[0].tokenPresent,true);
  assert.equal(JSON.stringify(result).includes("SYNTHETIC"),false);
  assert.equal(Object.keys(result[0]).join(","),"timestamp,status,tokenPresent,duplicateToken,tokenAge");
  f.callbacks["stop:click"]();
  assert.equal(f.elements.get("lever").textContent,"[]");
});
test("panel rejects off-scope request before metadata access or async lookup",async()=>{
  const f=await fixture();await f.callbacks["arm:click"]();f.state.deferred=true;
  await f.callbacks.request({request:{url:"https://example.com/other",get method(){throw Error("method must not be read");},get postData(){throw Error("must not read");}},get response(){throw Error("must not read");}});
  assert.equal(f.state.evals.length,0);
});
test("navigation or stop while page check is pending cannot read request body",async()=>{
  for(const action of ["navigate","stop:click"]) {
    const f=await fixture();await f.callbacks["arm:click"]();f.state.deferred=true;
    let reads=0;const r=request();Object.defineProperty(r.request,"postData",{get(){reads++;throw Error("must not read");}});
    const pending=f.callbacks.request(r);
    if(action==="navigate")f.callbacks.navigate("https://example.com");else f.callbacks[action]();
    f.state.evals.shift()(APPLICATION_URL);await pending;
    assert.equal(reads,0);
    assert.equal(f.elements.get("lever").textContent,"[]");
  }
});
test("concurrent hCaptcha event cannot silently suppress the application event",async()=>{
  const f=await fixture();await f.callbacks["arm:click"]();f.state.deferred=true;
  const h={request:{url:"https://api.hcaptcha.com/checkcaptcha/SYNTHETIC",method:"POST"},response:{status:200},startedDateTime:"2026-10-13T22:00:00Z"};
  const hp=f.callbacks.request(h);const lp=f.callbacks.request(request());
  while(f.state.evals.length)f.state.evals.shift()(APPLICATION_URL);
  await Promise.all([hp,lp]);
  assert.equal(JSON.parse(f.elements.get("lever").textContent).length,1);
  assert.equal(JSON.parse(f.elements.get("hcaptcha").textContent).length,1);
});
test("wrong inspected page fails closed without reading request body",async()=>{
  const f=await fixture();await f.callbacks["arm:click"]();f.state.url="https://example.com";
  let reads=0;const r=request();Object.defineProperty(r.request,"postData",{get(){reads++;throw Error("must not read");}});
  await f.callbacks.request(r);
  assert.equal(reads,0);
  assert.equal(f.elements.get("lever").textContent,"[]");
  assert.match(f.elements.get("state").textContent,/could not be confirmed/);
});
test("at most eight scoped requests transiently in flight; overflow clears the result",async()=>{
  const f=await fixture();await f.callbacks["arm:click"]();f.state.deferred=true;
  const promises=[];
  for(let i=0;i<9;i++)promises.push(f.callbacks.request(request()));
  while(f.state.evals.length)f.state.evals.shift()(APPLICATION_URL);
  await Promise.all(promises);
  assert.equal(f.elements.get("lever").textContent,"[]");
  assert.match(f.elements.get("state").textContent,/limit reached/);
});

test("stale asynchronous diagnostic error cannot clear a new armed session",async()=>{
 let rejectOld;
 const f=await fixture(()=>{
  const base=createDiagnostic({now:()=>Date.parse("2026-10-13T22:00:00Z")});
  return {...base,observe:()=>new Promise((resolve,reject)=>{rejectOld=reject;})};
 });
 await f.callbacks["arm:click"]();
 const old=f.callbacks.request(request());
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(typeof rejectOld,"function");
 f.callbacks["stop:click"]();await f.callbacks["arm:click"]();
 rejectOld(new Error("synthetic failure"));
 await old;
 assert.match(f.elements.get("state").textContent,/^Armed/);
});
