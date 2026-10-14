import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDiagnostic, APPLICATION_URL, SESSION_MS, isApplicationPage, classifyRequest } from "../diagnostics/lever-verification/core.js";

const timestamp = "2026-10-13T22:00:00.000Z";
const token = "SYNTHETIC-VERIFICATION-VALUE";
const failure = () => { throw Error("forbidden access"); };
function entry(value = token) {
  return {request: {url: APPLICATION_URL, method: "POST", postData:{params:[{name:"h-captcha-response",value}]}}, response:{status:400}, startedDateTime:timestamp};
}
function armed(options) { const d=createDiagnostic({now:()=>Date.parse(timestamp),...options}); assert.equal(d.arm(APPLICATION_URL),true); return d; }

test("URL allowlist rejects wrong origin, posting, scheme and deceptive hosts", () => {
  for (const url of ["https://jobs.lever.co/Elsewhere/871ce846-02d4-43c5-b54c-426060fc08c4/apply","http://jobs.lever.co/Huckleberrylabs/871ce846-02d4-43c5-b54c-426060fc08c4/apply",APPLICATION_URL+"/other","https://u:p@jobs.lever.co/Huckleberrylabs/871ce846-02d4-43c5-b54c-426060fc08c4/apply","https://jobs.lever.co.evil.test/x"]) assert.equal(isApplicationPage(url),false);
  for (const url of ["https://evil-hcaptcha.com/x","https://hcaptcha.com.evil.test/x","http://api.hcaptcha.com/x","https://api.hcaptcha.com:444/x"]) assert.equal(classifyRequest(url,"POST"),null);
  assert.equal(classifyRequest(APPLICATION_URL,"GET"),null);
  assert.equal(classifyRequest(APPLICATION_URL,"POST"),"lever");
  assert.equal(classifyRequest("https://api.hcaptcha.com/checkcaptcha/fake","POST"),"hcaptcha");
});

test("no scope metadata/body/header/cookie access for other requests or unarmed sessions", async () => {
  const d=armed();
  const off={request:{url:"https://example.com/private",method:"POST", get postData(){failure();},get headers(){failure();}, get cookies(){failure();}},get response(){failure();},get startedDateTime(){failure();}};
  assert.equal(await d.observe(off,APPLICATION_URL),null);
  assert.equal(await d.observe({get request(){failure();}},"https://example.com"),null);
  d.clear(); assert.equal(await d.observe({get request(){failure();}},APPLICATION_URL),null);
  assert.deepEqual(d.snapshot(),{lever:[],hcaptcha:[]});
});

test("output has only approved fields; tokens and applicant values never enter output",async()=>{
  const d=armed(); const a=entry(); a.request.headers={get secret(){failure();}};
  a.request.cookies={get secret(){failure();}};
  a.request.postData.params.unshift({name:"applicantEmail",get value(){failure();}});
  const r=await d.observe(a,APPLICATION_URL);
  assert.deepEqual(r,{kind:"lever",row:{timestamp,status:400,tokenPresent:true,duplicateToken:false,tokenAge:"unknown"}});
  assert.equal(JSON.stringify(d.snapshot()).includes(token),false);
  assert.equal((await d.observe(entry(),APPLICATION_URL)).row.duplicateToken,true);
  assert.equal((await d.observe(entry("SYNTHETIC-NEW"),APPLICATION_URL)).row.duplicateToken,false);
});

test("hCaptcha reads timing/status only and never its body, headers or cookies",async()=>{
  const d=armed();
  const a={request:{url:"https://api.hcaptcha.com/checkcaptcha/fake",method:"POST",get postData(){failure();},get headers(){failure();},get cookies(){failure();}},response:{status:200,get content(){failure();},get headers(){failure();}},startedDateTime:timestamp,get getContent(){failure();}};
  assert.deepEqual((await d.observe(a,APPLICATION_URL)).row,{timestamp,status:200,tokenPresent:"unknown",duplicateToken:"unknown",tokenAge:"unknown"});
});

test("empty token is false; omitted or unsupported fields remain unknown",async()=>{
  const d=armed();
  assert.equal((await d.observe(entry(""),APPLICATION_URL)).row.tokenPresent,false);
  for (const postData of [undefined,{params:[]},{params:[{name:"unknownField",get value(){failure();}}]},{mimeType:"application/json",text:'{"name":"SYNTHETIC-PERSON"}'},{mimeType:"multipart/form-data",text:"truncated"}]) {
    const a=entry();a.request.postData=postData;
    assert.equal((await d.observe(a,APPLICATION_URL)).row.tokenPresent,"unknown");
  }
});

test("bounded multipart and URL-encoded exact verification field extraction",async()=>{
  const d=armed();
  for(const postData of [
    {mimeType:"application/x-www-form-urlencoded",text:"name=SYNTHETIC-PERSON&h-captcha-response=SYNTHETIC%2DTOKEN"},
    {mimeType:"multipart/form-data; boundary=SYNTH",text:'--SYNTH\r\nContent-Disposition: form-data; name="name"\r\n\r\nSYNTHETIC-PERSON\r\n--SYNTH\r\nContent-Disposition: form-data; name="h-captcha-response"\r\n\r\nSYNTHETIC-TOKEN\r\n--SYNTH--\r\n'}
  ]) {
    const a=entry();a.request.postData=postData;
    assert.equal((await d.observe(a,APPLICATION_URL)).row.tokenPresent,true);
  }
  const a=entry(); a.request.postData={mimeType:"application/x-www-form-urlencoded",text:"x".repeat(2*1024*1024+1)};
  assert.equal((await d.observe(a,APPLICATION_URL)).row.tokenPresent,"unknown");
});

test("state clears on off-scope navigation, disarm and timeout; hashes are bounded",async()=>{
  let time=1000;const d=armed({now:()=>time});
  await d.observe(entry(),APPLICATION_URL);
  for(let n=0;n<9;n++) await d.observe(entry("SYNTHETIC-"+n),APPLICATION_URL);
  assert.equal((await d.observe(entry(),APPLICATION_URL)).row.duplicateToken,false);
  d.navigate("https://example.com");assert.equal(d.isArmed(),false);assert.deepEqual(d.snapshot(),{lever:[],hcaptcha:[]});
  d.arm(APPLICATION_URL);assert.equal((await d.observe(entry(),APPLICATION_URL)).row.duplicateToken,false);
  time+=SESSION_MS;assert.equal(d.isArmed(),false);assert.deepEqual(d.snapshot(),{lever:[],hcaptcha:[]});
});

test("async digest cannot repopulate cleared state",async()=>{
  let finish;const native=globalThis.crypto;
  const d=armed({cryptoApi:{getRandomValues:a=>native.getRandomValues(a),subtle:{digest:()=>new Promise(r=>{finish=r;})}}});
  const pending=d.observe(entry(),APPLICATION_URL);d.clear();finish(new Uint8Array(32).buffer);
  assert.equal(await pending,null);assert.deepEqual(d.snapshot(),{lever:[],hcaptcha:[]});
});

test("bad timestamp is rejected and status normalized; row buffers are bounded",async()=>{
  const d=armed();const a=entry();a.startedDateTime="SYNTHETIC-UNTRUSTED";a.response.status="SYNTHETIC-UNTRUSTED";
  assert.equal(await d.observe(a,APPLICATION_URL),null);
  a.startedDateTime=timestamp;
  assert.equal((await d.observe(a,APPLICATION_URL)).row.status,"unknown");
  for(let i=0;i<70;i++) await d.observe(entry(""),APPLICATION_URL);
  assert.equal(d.snapshot().lever.length,64);
});

test("manifest and production source have no broad permissions, persistence, network sends or historical/response-body reads",async()=>{
  const root=new URL("../diagnostics/lever-verification/",import.meta.url);
  const manifest=JSON.parse(await readFile(new URL("manifest.json",root),"utf8"));
  for(const key of ["permissions","host_permissions","optional_permissions","optional_host_permissions","background","content_scripts","externally_connectable"]) assert.equal(manifest[key],undefined);
  assert.match(manifest.content_security_policy.extension_pages,/connect-src 'none'/);
  for(const file of ["core.js","panel.js","devtools.js"]) {
    const source=await readFile(new URL(file,root),"utf8");
    for(const forbidden of [/getHAR\s*\(/,/getContent\s*\(/,/console\./,/localStorage/,/sessionStorage/,/indexedDB/,/chrome\.storage/,/fetch\s*\(/,/XMLHttpRequest/,/WebSocket/,/sendBeacon/,/chrome\.debugger/,/\.request\.headers/,/\.request\.cookies/]) assert.doesNotMatch(source,forbidden,file);
  }
});

test("pre-arm and invalid timestamps never access verification data",async()=>{
 const d=armed();let reads=0;
 for(const startedDateTime of ["2026-10-13T21:59:59.999Z",undefined,"invalid"]){
  const a=entry();a.startedDateTime=startedDateTime;
  Object.defineProperty(a.request,"postData",{get(){reads++;return null;}});
  assert.equal(await d.observe(a,APPLICATION_URL),null);
 }
 assert.equal(reads,0);
});
test("duplicate fields and malformed multipart bodies stay unknown",async()=>{
 const d=armed();
 const prefix='--SYNTH\r\nContent-Disposition: form-data; name="h-captcha-response"\r\n\r\nSYNTHETIC-TOKEN\r\n--SYNTH';
 for(const postData of [
  {params:[{name:"h-captcha-response",value:""},{name:"h-captcha-response",value:"SYNTHETIC"}]},
  {mimeType:"application/x-www-form-urlencoded",text:"h-captcha-response=&h-captcha-response=SYNTHETIC"},
  {mimeType:"application/x-www-form-urlencoded",text:"h-captcha-response=SYNTHETIC&h-captcha-response"},
  {mimeType:"application/x-www-form-urlencoded",text:"h-captcha-response&h-captcha-response=SYNTHETIC"},
  {mimeType:"multipart/form-data",text:prefix},
  {mimeType:"multipart/form-data",text:prefix+'\r\nContent-Disposition: form-data; name="h-captcha-response"\r\nContent-Type: text/plain\r\n\r\nOTHER\r\n--SYNTH--\r\n'},
  {mimeType:"multipart/form-data",text:prefix+'\r\ncontent-disposition: form-data; name="h-captcha-response"\r\n\r\nOTHER\r\n--SYNTH--\r\n'},
  {mimeType:"multipart/form-data",text:prefix+"prefix--\r\n"},
  {mimeType:"multipart/form-data; boundary=OTHER",text:prefix+"--\r\n"},
  {mimeType:"multipart/form-data",text:prefix+'\r\nContent-Disposition: form-data; name="h-captcha-response"\r\n\r\nOTHER\r\n--SYNTH--\r\n'}
 ]){
  const a=entry();a.request.postData=postData;
  const row=(await d.observe(a,APPLICATION_URL)).row;
  assert.equal(row.tokenPresent,"unknown");assert.equal(row.duplicateToken,"unknown");
 }
});
test("repeat result follows event order when digests complete in reverse",async()=>{
 const completions=[];const native=globalThis.crypto;
 const d=armed({cryptoApi:{getRandomValues:a=>native.getRandomValues(a),subtle:{digest:()=>new Promise(resolve=>completions.push(resolve))}}});
 const a=d.observe(entry(),APPLICATION_URL);const b=d.observe(entry(),APPLICATION_URL);
 completions[1](new Uint8Array(32).buffer);await Promise.resolve();
 assert.equal(d.snapshot().lever.length,0);
 completions[0](new Uint8Array(32).buffer);
 assert.equal((await a).row.duplicateToken,false);assert.equal((await b).row.duplicateToken,true);
});
