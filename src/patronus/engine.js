import { computerLogin } from './computer-login.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, statfsSync, statSync, openSync, readSync, closeSync, createWriteStream, readdirSync, unlinkSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { defaultLaunch, launchConfig, profileDir, browserKind, BROWSERS } from './launch.js';
import { request, safeURL, displayURL, fault, startProxy, resolvePublic, agent } from './network.js';
import { extract } from './extract.js';
import { browserError } from './browser-errors.js';
import { addWarning, requestWarning, mainNavigation, networkReason } from './warnings.js';
import { browserRequestPolicy, blockedRequest, continueBrowserRequest } from './browser-policy.js';
import { trackRequests, waitForReadiness } from './readiness.js';
import { x10Login, X10_LOGIN, diagnoseX10Error } from './login.js';
import { captureWidgets, configuredSolver, solvePageChallenge, challengeRequestPolicy } from './challenges.js';
const terminal=new Set(['succeeded','partial','failed','cancelled']);
const now=()=>new Date().toISOString();
const digest=b=>createHash('sha256').update(b).digest('hex');
export class Patronus {
 constructor(root,{launch=defaultLaunch,requestFn=request}={}) {
  this.root=root;this.launch=launch;this.request=requestFn;this.active=null;this.computerSessions=new Map();this.computerLogin=computerLogin;
  for(const p of ['jobs','profiles','firefox-profiles'])mkdirSync(join(root,p),{recursive:true,mode:0o700});
  this.db=new DatabaseSync(join(root,'jobs.sqlite'));
  this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, key TEXT UNIQUE, input TEXT, data TEXT);");
  // A service restart cannot silently replay a navigation with unknown effects.
  for(const row of this.db.prepare('SELECT * FROM jobs').all()) {
   const d=JSON.parse(row.data);
   if(d.state==='running'){d.state=d.pages?.length?'partial':'failed';d.finishedAt=now();d.obstacles.push({code:'INTERRUPTED',message:'Service restarted during retrieval; a new explicit run may be submitted.'});this.save(d);}
  }
 }
 save(d){this.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(d),d.jobId);}
 get(id){const r=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);if(!r)throw fault('NOT_FOUND');return {args:JSON.parse(r.input),data:JSON.parse(r.data)};}
 status({jobId}){return this.get(jobId).data;}
 capabilities(){return {name:'Patronus',version:'0.5.0',home:'Alpha',loginAccounts:['x10'],modes:['read','download','explore','login'],rendering:['http','browser','auto'],browsers:[...BROWSERS],headed:'Optional per job on the service-local Xvfb display; no remote viewer.',inputPolicy:'Existing profiles only; no waiting for user state.',profiles:readdirSync(join(this.root,'profiles')).filter(n=>/^[a-z0-9_-]{1,40}$/.test(n)),limits:{activeJobs:1,queuedJobs:50,maxBytes:2147483648,maxPages:20,diskReserveBytes:2147483648,artifactQuotaBytes:10737418240},limitations:['Direct HTTP downloads; no Mega decryption adapter','No purchases, posting or interactive credential requests; optional SolveCaptcha supports reCAPTCHA v2, standalone Turnstile, hCaptcha and identified image CAPTCHAs','Retrieval permits GET/HEAD and parsed same-origin HTTPS GraphQL queries; explicit X10 login alone permits its credential submission and normal checkbox verification plus configured CAPTCHA solving','Interrupted navigation is reported, not replayed','No universal third-party access guarantee','Browser profiles must be provisioned outside runs'],security:{browserSandbox:true,publicNetworkOnly:true,identity:agent,artifactAccess:'authenticated tool bytes'}};}
 login({account,timeoutSeconds=180,idempotencyKey,solveCaptchas=true,sessionOnly=false,headed=false,screenshots=false,interaction='programmatic',browser}){
  if(account!=='x10')throw fault('ACCOUNT_UNSUPPORTED');
  if(!Number.isInteger(timeoutSeconds)||timeoutSeconds<30||timeoutSeconds>(interaction==='computer-use'?900:300))throw fault('LOGIN_TIMEOUT_POLICY');
  // Recovering an existing key is read-only; a fresh submission must respect X10's own cooldown.
  if(!sessionOnly&&!this.db.prepare('SELECT id FROM jobs WHERE key=?').get(idempotencyKey)) {
   for(const row of this.db.prepare('SELECT input,data FROM jobs').all()) {
    const input=JSON.parse(row.input),data=JSON.parse(row.data),evidence=data.loginDiagnostic;
    if(input.mode!=='login'||input.profile!=='x10'||!evidence?.credentialSubmissionObserved||!evidence.submittedAt)continue;
    const diagnosis=evidence.serverDiagnosis||diagnoseX10Error(evidence.errorMessage||'');
    const until=Date.parse(evidence.submittedAt)+(diagnosis.minimumWaitSeconds||0)*1000;
    if(diagnosis.minimumWaitSeconds&&until>Date.now())throw fault('LOGIN_SERVER_COOLDOWN','X10 explicitly requires waiting until '+new Date(until).toISOString()+'. Session-only checks remain available.');
   }
  }
  return this.start({urls:[X10_LOGIN],mode:'login',profile:'x10',timeoutSeconds,idempotencyKey,solveCaptchas,sessionOnly,...(browser==='firefox'?{browser}:{}),...(headed?{headed:true}:{}),...(screenshots||interaction==='computer-use'?{screenshots:true}:{}),...(interaction==='computer-use'?{interaction,headed:true}:{}),maxBytes:52428800,maxPages:1});
 }

 async computerAction(args) {
  const {jobId,idempotencyKey,...input}=args;
  const stored=this.get(jobId).data,session=this.computerSessions.get(jobId);
  const d=session?.data||stored,control=d.computerUse;
  if(!control)throw fault('COMPUTER_SESSION_NOT_READY');
  const payload=JSON.stringify(input),existing=control.commands.find(c=>c.key===idempotencyKey);
  if(existing) {
   if(existing.payload!==payload)throw fault('IDEMPOTENCY_CONFLICT');
   if(existing.state==='completed')return existing.result;
   throw fault(existing.code||'COMPUTER_ACTION_UNCERTAIN');
  }
  if(!session)throw fault('COMPUTER_SESSION_ENDED');
  if(session.busy)throw fault('COMPUTER_ACTION_BUSY');
  if(control.commands.length>=40)throw fault('COMPUTER_ACTION_LIMIT');
  const receipt={key:idempotencyKey,payload,state:'running',at:now()};
  control.commands.push(receipt);this.save(d);session.busy=true;
  try {
   const result=await session.handler(input);
   receipt.state='completed';receipt.result=result;this.save(d);return result;
  }catch(e) {
   receipt.state='failed';receipt.code=/^[A-Z][A-Z0-9_]+$/.test(e.code||'')?e.code:'COMPUTER_ACTION_FAILED';
   this.save(d);throw fault(receipt.code);
  }finally {session.busy=false;}
 }
 start(args){
  for(const u of args.urls)safeURL(u);
  // Browser selection only means something when a browser renders the page.
  if((args.browser==='firefox'||args.headed)&&args.rendering==='http')throw fault('RENDERING_CONFLICT','browser and headed require browser or auto rendering.');
  if(args.resumeJobId){
   const old=this.get(args.resumeJobId);
   if(args.mode!=='download'||args.urls.length!==1||old.args.urls.length!==1||old.args.urls[0]!==args.urls[0]||old.args.profile!==args.profile||!terminal.has(old.data.state))throw fault('RESUME_MISMATCH');
  }
  const input=JSON.stringify(args),existing=this.db.prepare('SELECT * FROM jobs WHERE key=?').get(args.idempotencyKey);
  if(existing){if(existing.input!==input)throw fault('IDEMPOTENCY_CONFLICT');return JSON.parse(existing.data);}
  const pending=this.db.prepare('SELECT data FROM jobs').all().filter(r=>!terminal.has(JSON.parse(r.data).state)).length;
  if(pending>=50)throw fault('QUEUE_FULL');
  const d={jobId:randomUUID(),state:'queued',createdAt:now(),startedAt:null,finishedAt:null,mode:args.mode,profile:args.profile,browser:browserKind(args),headed:Boolean(args.headed),urls:args.urls.map(displayURL),pages:[],artifacts:[],obstacles:[],warnings:[],trace:[],bytes:0};
  mkdirSync(join(this.root,'jobs',d.jobId),{mode:0o700});
  this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?)').run(d.jobId,args.idempotencyKey,input,JSON.stringify(d));return d;
 }
 list({cursor=0,limit=20}){const rows=this.db.prepare('SELECT data FROM jobs ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit+1,cursor);const more=rows.length>limit;return {jobs:rows.slice(0,limit).map(r=>JSON.parse(r.data)),nextCursor:more?cursor+limit:null};}
 cancel({jobId}){const {data:d}=this.get(jobId);if(terminal.has(d.state))return d;if(this.active?.id===jobId)this.active.controller.abort(fault('CANCELLED'));else{d.state='cancelled';d.finishedAt=now();this.save(d);}return this.status({jobId});}
 result({jobId,cursor=0,limit=16000}){this.get(jobId);const path=join(this.root,'jobs',jobId,'result.json');const content=existsSync(path)?readFileSync(path,'utf8'):'[]';return {content:content.slice(cursor,cursor+limit),nextCursor:cursor+limit<content.length?cursor+limit:null,untrustedContent:true};}
 artifact({jobId,artifactId,cursor=0,limit=16000}){
  const a=this.get(jobId).data.artifacts.find(a=>a.artifactId===artifactId);if(!a)throw fault('NOT_FOUND');
  const fd=openSync(join(this.root,'jobs',jobId,artifactId),'r');let b=Buffer.alloc(Math.min(limit,Math.max(0,a.bytes-cursor)));try{b=b.subarray(0,readSync(fd,b,0,b.length,cursor));}finally{closeSync(fd);}
  return {...a,encoding:'base64',content:b.toString('base64'),nextCursor:cursor+b.length<a.bytes?cursor+b.length:null};
 }
 budget(d,args,extra=0){
  const st=statfsSync(this.root);if(st.bavail*st.bsize<2147483648)throw fault('STORAGE_FULL');
  if(d.bytes+extra>args.maxBytes)throw fault('BYTE_LIMIT');
  const used=this.db.prepare('SELECT data FROM jobs').all().reduce((sum,r)=>sum+JSON.parse(r.data).artifacts.reduce((s,a)=>s+a.bytes,0),0);
  if(used+d.bytes+extra>10737418240)throw fault('STORAGE_QUOTA');
 }
 async bytes(raw,d,args,signal,{file=false,name='download',headers={},resume=null}={}){
  this.budget(d,args);
  let response,url;
  if(resume){if(!resume.etag||resume.etag.startsWith('W/'))throw fault('RESUME_UNAVAILABLE','A strong ETag is required for safe resume.');headers={...headers,range:'bytes='+resume.bytes+'-','if-range':resume.etag};}
  for(let attempt=0;;attempt++){
   ({response,url}=await this.request(raw,{signal,headers,trace:t=>{if(d.trace.length<200)d.trace.push({...t,at:now()});this.save(d);}}));
   if([429,502,503,504].includes(response.statusCode)&&attempt<2){
    const retry=response.headers['retry-after'];const delay=retry?(Number.isFinite(Number(retry))?Number(retry)*1000:Date.parse(retry)-Date.now()):1000*(2**attempt);
    response.resume();
    if(delay>30000)throw fault('RATE_LIMIT','Retry-After exceeds this bounded attempt.');
    await new Promise((resolve,reject)=>{const t=setTimeout(resolve,Math.max(1000,delay||1000));signal.addEventListener('abort',()=>{clearTimeout(t);reject(signal.reason);},{once:true});});continue;
   }break;
  }
  const code=response.statusCode;
  if(resume && (code!==206||response.headers.etag!==resume.etag||!String(response.headers['content-range']).startsWith('bytes '+resume.bytes+'-'))){response.destroy();throw fault('RESUME_UNAVAILABLE','The server did not confirm an unchanged ranged resource.');}
  if(code<200||code>=300){response.resume();throw fault(code===401?'AUTH_REQUIRED':code===402?'PAYMENT_REQUIRED':code===403?'ACCESS_DENIED':code===429?'RATE_LIMIT':'HTTP_ERROR','HTTP '+code);}
  const mime=String(response.headers['content-type']||'application/octet-stream').split(';')[0];
  const length=Number(response.headers['content-length']||0);this.budget(d,args,length);
  const artifactId=randomUUID(),path=join(this.root,'jobs',d.jobId,artifactId),hash=createHash('sha256');let count=0,lastSave=Date.now();const chunks=[];
  const meter=new Transform({transform:(chunk,_enc,cb)=>{try{this.budget(d,args,chunk.length);d.bytes+=chunk.length;count+=chunk.length;hash.update(chunk);if(Date.now()-lastSave>1000){this.save(d);lastSave=Date.now();}cb(null,chunk);}catch(e){cb(e);}}});
  if(file){
   if(resume){copyFileSync(resume.path,path+'.part');const fd=openSync(path+'.part','r');const chunk=Buffer.alloc(65536);try{let n;while((n=readSync(fd,chunk,0,chunk.length,null))>0)hash.update(chunk.subarray(0,n));}finally{closeSync(fd);}count=resume.bytes;}
   try{await pipeline(response,meter,createWriteStream(path+'.part',{mode:0o600,flags:resume?'a':'w'}),{signal});renameSync(path+'.part',path);}
   catch(e){if(existsSync(path+'.part')){
    renameSync(path+'.part',path);
    d.artifacts.push({artifactId,name,mimeType:mime,bytes:statSync(path).size,source:displayURL(url),complete:false,etag:response.headers.etag||null,resumable:Boolean(response.headers.etag&&!response.headers.etag.startsWith('W/'))});this.save(d);
   }throw e;}
   const a={artifactId,name:name.replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,120)||'download',mimeType:mime,bytes:count,sha256:hash.digest('hex'),source:displayURL(url),complete:true};
   d.artifacts.push(a);this.save(d);return {artifact:a,url};
  }
  await pipeline(response,meter,new Transform({transform:(b,_e,cb)=>{chunks.push(b);cb();}}),{signal});
  return {body:Buffer.concat(chunks),mime,url,status:code};
 }
 diagnosticArtifact(d,args,name,mimeType,body){
  const b=Buffer.isBuffer(body)?body:Buffer.from(body);
  this.budget(d,args,b.length);d.bytes+=b.length;
  const artifactId=randomUUID();writeFileSync(join(this.root,'jobs',d.jobId,artifactId),b,{mode:0o600});
  d.artifacts.push({artifactId,name,mimeType,bytes:b.length,sha256:digest(b),complete:true,untrustedContent:true,diagnostic:true});this.save(d);return artifactId;
 }
 async browserFailure(page,response,d,args,reason){
  const item={at:now(),url:displayURL(page.url()),status:response?.status()||null,reason,route:'browser',artifacts:{},captureErrors:[]};
  (d.diagnostics??=[]).push(item);this.save(d);
  const attempt=async(name,fn)=>{try{await fn();}catch(e){item.captureErrors.push({part:name,code:/^[A-Z_]+$/.test(e.code||'')?e.code:'CAPTURE_FAILED'});}this.save(d);};
  await attempt('headers',async()=>{
   const raw=await response?.allHeaders()||{},headers={},redactedHeaders=[];
   const allowed=/^(content-type|content-length|content-encoding|server|date|via|retry-after|cache-control|cf-ray|cf-mitigated|x-cache|x-served-by|x-request-id|x-transaction-id|x-response-time|x-amz-cf-id|x-amz-cf-pop|x-powered-by|strict-transport-security)$/i;
   for(const [key,value] of Object.entries(raw)){if(allowed.test(key))headers[key]=String(value).slice(0,4096);else if(key.toLowerCase()==='location')headers[key]=displayURL(new URL(value,page.url()).href);else redactedHeaders.push(key);}
   item.artifacts.headers=this.diagnosticArtifact(d,args,'denial-headers.json','application/json',JSON.stringify({status:item.status,url:item.url,headers,redactedHeaders}));
  });
  await attempt('content',async()=>{
   const html=Buffer.from(await page.content()),max=262144;
   item.contentTruncated=html.length>max;
   item.artifacts.content=this.diagnosticArtifact(d,args,'denial-page.html.txt','text/plain',html.subarray(0,max));
  });
  await attempt('text',async()=>{
   const text=await page.locator('body').innerText({timeout:2000});
   item.artifacts.text=this.diagnosticArtifact(d,args,'denial-page.txt','text/plain',Buffer.from(text).subarray(0,65536));
  });
  await attempt('screenshot',async()=>{
   const b=await page.screenshot({fullPage:false,timeout:3000});
   if(b.length>2097152)throw fault('DIAGNOSTIC_LIMIT');
   item.artifacts.screenshot=this.diagnosticArtifact(d,args,'denial-page.png','image/png',b);
  });
  return item;
 }
 async browser(url,d,args,signal){
  const provisioned=join(this.root,'profiles',args.profile),browser=browserKind(args),profile=profileDir(this.root,args.profile,browser);
  if(args.profile!=='public'&&!existsSync(provisioned))throw fault('PROFILE_MISSING');
  mkdirSync(profile,{recursive:true,mode:0o700});
  let observedBytes=0,context,page,response,tracker,stage='launch';
  const diagnosticStart=d.diagnostics?.length||0;
  const reportedRequests=new WeakSet();
  const challengeState={armed:false};
  const solver=configuredSolver(this,args);
  const proxy=await startProxy({signal,maxBytes:args.maxBytes-d.bytes,onBytes:n=>{d.bytes+=n-observedBytes;observedBytes=n;}});
  try{
   context=await this.launch({path:profile,browser,config:launchConfig({browser,headed:args.headed,proxy,permissions:[],userAgent:agent})});
   if(signal.aborted)throw signal.reason;
   signal.addEventListener('abort',()=>context.close().catch(()=>{}),{once:true});
   if(solver){solver.apiKey='';await context.addInitScript(captureWidgets);}
   const imported=join(provisioned,'access.json');
   if(existsSync(imported)){const state=JSON.parse(readFileSync(imported,'utf8'));await context.addCookies(state.cookies||[]);}
   await context.route('**/*',async route=>{
    const req=route.request();
    try{
     if(signal.aborted)throw fault('CANCELLED');
     const decision=challengeRequestPolicy(req,challengeState)||browserRequestPolicy(req);
     if(!decision.allowed)throw fault(decision.reason);
     if(!['http:','https:'].includes(new URL(req.url()).protocol))throw fault('URL_POLICY');
     await resolvePublic(req.url());
     this.budget(d,args);
     await continueBrowserRequest(route,decision);
    }catch(e){
     reportedRequests.add(req);
     if(mainNavigation(req,page)||['BYTE_LIMIT','STORAGE_FULL','STORAGE_QUOTA'].includes(e.code)){if(d.obstacles.length<50)d.obstacles.push(blockedRequest(req,e.code||'REQUEST_FAILED'));}
     else addWarning(d,requestWarning(req,'SUBREQUEST_BLOCKED',browserError(e,'subrequest',signal).code));
     await route.abort().catch(()=>{});
    }
   });
   await context.routeWebSocket('**/*',ws=>ws.close());
   page=context.pages()[0]||await context.newPage();
   tracker=trackRequests(page);
   page.on('dialog',dialog=>dialog.dismiss());
   page.on('response',r=>{
    if(d.trace.length<200)d.trace.push({at:now(),url:displayURL(r.url()),status:r.status(),client:agent,route:'browser'});
    if(r.status()>=400&&!mainNavigation(r.request(),page)&&!reportedRequests.has(r.request())){
     reportedRequests.add(r.request());addWarning(d,{...requestWarning(r.request(),'SUBREQUEST_HTTP_ERROR','HTTP_ERROR'),status:r.status()});
    }
   });
   page.on('requestfailed',req=>{
    if(!signal.aborted&&!mainNavigation(req,page)&&!reportedRequests.has(req)){
     reportedRequests.add(req);addWarning(d,requestWarning(req,'SUBREQUEST_FAILED',networkReason(req.failure()?.errorText)));
    }
   });
   page.on('download',download=>download.cancel());
   stage='navigation';
   page.on('response',r=>{if(r.request().isNavigationRequest()&&r.frame()===page.mainFrame())response=r;});
   response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:Math.min(60000,args.timeoutSeconds*1000)});
   for(let n=0;n<3;n++){await page.evaluate(()=>window.scrollBy(0,window.innerHeight));await page.waitForTimeout(200);}
   stage='readiness';
   let readiness=await waitForReadiness(page,tracker,{timeoutMs:(args.browserWaitSeconds??20)*1000,minWaitMs:5000,selector:args.waitForSelector,signal});
   if(await solvePageChallenge(this,page,d,args,signal,challengeState)) {
    readiness=await waitForReadiness(page,tracker,{timeoutMs:(args.browserWaitSeconds??20)*1000,minWaitMs:5000,selector:args.waitForSelector,signal});
   }
   tracker.close();
   if(readiness.outcome==='timeout'){
    const item={code:'PAGE_NOT_SETTLED',url:displayURL(page.url()),message:'Readiness budget expired; captured available content.',...readiness};
    if(args.waitForSelector&&!readiness.selectorMatched)d.obstacles.push({...item,code:'REQUESTED_SELECTOR_NOT_FOUND'});
    else addWarning(d,item);
   }
   const code=response?.status()||0;
   if(code>=400){await this.browserFailure(page,response,d,args,'HTTP_ERROR');throw fault(code===401?'AUTH_REQUIRED':code===403?'ACCESS_DENIED':code===402?'PAYMENT_REQUIRED':code===429?'RATE_LIMIT':'HTTP_ERROR','HTTP '+code);}
   stage='extraction';
   const html=await page.content(),final=page.url(),out=extract(html,final);
   if(/^(just a moment|access denied|verify you are human)/i.test(out.title.trim())){await this.browserFailure(page,response,d,args,'CHALLENGE');throw fault('CHALLENGE','The challenge remains unresolved; this widget may require unsupported verification.');}
   if(await page.locator('input[type=password]').count())out.coverage.possibleLoginPage=true;
   out.url=displayURL(final);out.route='browser';out.coverage.readiness=readiness;
   out.frames=[];
   const childFrames=page.frames().filter(f=>f!==page.mainFrame());
   for(const frame of childFrames.slice(0,10)){
    try{
     const frameUrl=frame.url();if(!/^https?:/.test(frameUrl))continue;
     const item=extract(await frame.content(),frameUrl);
     item.url=displayURL(frameUrl);
     item.links=item.links.map(l=>({...l,url:displayURL(l.url)}));
     item.images=item.images.map(i=>({...i,url:displayURL(i.url),retrievalError:'FRAME_IMAGE_NOT_FETCHED'}));
     out.frames.push(item);
    }catch{out.coverage.frameErrors=(out.coverage.frameErrors||0)+1;}
   }
   out.coverage.framesCaptured=out.frames.length;
   out.coverage.framesOmitted=childFrames.length-out.frames.length;
   out.coverage.scope='Rendered main document and captured frames; readiness is an observation, not proof of completeness.';

   if(args.screenshot){
    stage='screenshot';
    let b;
    try{b=await page.screenshot({fullPage:false,timeout:3000});}
    catch(e){d.obstacles.push({code:'SCREENSHOT_UNAVAILABLE',url:displayURL(final),reason:browserError(e,stage,signal).code,message:'Page content was preserved; the requested screenshot failed.'});}
    if(b){this.budget(d,args,b.length);d.bytes+=b.length;
    const id=randomUUID();writeFileSync(join(this.root,'jobs',d.jobId,id),b,{mode:0o600});
    d.artifacts.push({artifactId:id,name:'page.png',mimeType:'image/png',bytes:b.length,sha256:digest(b),complete:true});out.screenshotArtifactId=id;
    }
   }
   // Reuse browser cookies only for the matching image request.
   for(const im of out.images.slice(0,10)){
    try{const cookies=await context.cookies(im.url);const headers=cookies.length?{cookie:cookies.map(c=>c.name+'='+c.value).join('; ')}:{};
     const r=await this.bytes(im.url,d,args,signal,{file:true,name:im.id,headers});im.artifactId=r.artifact.artifactId;
    }catch(e){im.retrievalError=e.code||'IMAGE_UNAVAILABLE';}
   }
   return out;
  }catch(e){
   const error=browserError(e,stage,signal);
   if(page&&(d.diagnostics?.length||0)===diagnosticStart&&!signal.aborted) {
    const item=await this.browserFailure(page,response,d,args,error.code);
    item.stage=stage;
   }else if((d.diagnostics?.length||0)===diagnosticStart) {
    (d.diagnostics??=[]).push({at:now(),url:displayURL(url),route:'browser',reason:error.code,stage,artifacts:{},captureErrors:[]});
   }
   this.save(d);throw error;
  }finally{tracker?.close();await context?.close().catch(()=>{});proxy.close();}
 }
 async tick(){
  if(this.active)return;
  const row=this.db.prepare('SELECT id,data FROM jobs ORDER BY rowid').all().find(r=>JSON.parse(r.data).state==='queued');if(!row)return;
  const {args,data:d}=this.get(row.id),controller=new AbortController();this.active={id:d.jobId,controller};
  const timer=setTimeout(()=>controller.abort(fault('TIMEOUT')),args.timeoutSeconds*1000);
  d.state='running';d.startedAt=now();this.save(d);
  const output=[],pending=[...args.urls],seen=new Set();
  const persist=()=>{const path=join(this.root,'jobs',d.jobId,'result.json');writeFileSync(path+'.tmp',JSON.stringify(output),{mode:0o600});renameSync(path+'.tmp',path);this.save(d);};
  try{
   while(pending.length && seen.size<(args.mode==='explore'?args.maxPages:args.urls.length)){
    if(controller.signal.aborted)throw controller.signal.reason;
    const raw=pending.shift();if(seen.has(raw))continue;seen.add(raw);
    try{
     let out;
     if(args.mode==='login'){
      out=await x10Login(this,d,args,controller.signal);
     }else if(args.mode==='download'){
      let headers={};
      if(args.profile!=='public'){
       const provisioned=join(this.root,'profiles',args.profile),browser=browserKind(args),profile=profileDir(this.root,args.profile,browser);
       if(!existsSync(provisioned))throw fault('PROFILE_MISSING');
       mkdirSync(profile,{recursive:true,mode:0o700});
       const proxy=await startProxy({signal:controller.signal,maxBytes:0});let context;
       try{context=await this.launch({path:profile,browser,config:launchConfig({browser,proxy})});
        if(controller.signal.aborted)throw controller.signal.reason;
        await context.route('**/*',route=>route.abort());const imported=join(provisioned,'access.json');if(existsSync(imported))await context.addCookies(JSON.parse(readFileSync(imported,'utf8')).cookies||[]);
        const cookies=await context.cookies(raw);headers={cookie:cookies.map(c=>c.name+'='+c.value).join('; ')};
       }finally{await context?.close().catch(()=>{});proxy.close();}
      }
      let resume=null;
      if(args.resumeJobId){const old=this.get(args.resumeJobId).data;const a=old.artifacts.find(a=>!a.complete&&a.resumable);if(!a)throw fault('RESUME_UNAVAILABLE');resume={...a,path:join(this.root,'jobs',args.resumeJobId,a.artifactId)};}
      const name=decodeURIComponent(new URL(raw).pathname.split('/').pop()||'download');
      const r=await this.bytes(raw,d,args,controller.signal,{file:true,name,headers,resume});out={url:displayURL(r.url),artifactId:r.artifact.artifactId,route:'http',coverage:{complete:true}};
     }else{
      const useBrowser=args.rendering==='browser'||args.profile!=='public'||args.rendering==='auto';
      if(useBrowser)out=await this.browser(raw,d,args,controller.signal);
      else{
       const r=await this.bytes(raw,d,args,controller.signal);
       if(!r.mime.startsWith('text/')&&!['application/json','application/xml','application/xhtml+xml'].includes(r.mime))throw fault('BINARY_RESOURCE','Use download mode to retrieve this resource as a file.');
       out=r.mime.includes('html')?extract(r.body.toString('utf8'),r.url):{markdown:r.body.toString('utf8'),images:[],links:[],coverage:{scope:'HTTP response text'}};
       out.url=displayURL(r.url);out.route='http';
       for(const im of out.images.slice(0,10)){try{im.artifactId=(await this.bytes(im.url,d,args,controller.signal,{file:true,name:im.id})).artifact.artifactId;}catch(e){im.retrievalError=e.code||'IMAGE_UNAVAILABLE';}}
      }
      if(args.mode==='explore')for(const link of out.links||[])if(new URL(link.url).origin===new URL(raw).origin&&!seen.has(link.url)&&pending.length<args.maxPages)pending.push(link.url);
      out.links=(out.links||[]).map(l=>({...l,url:displayURL(l.url)}));out.images=(out.images||[]).map(i=>({...i,url:displayURL(i.url)}));
      if(out.coverage.textTruncated)d.obstacles.push({code:'COVERAGE_LIMIT',url:displayURL(raw),message:'Extracted text was truncated; inspect coverage.'});
      if(out.images.some(i=>!i.artifactId)||out.coverage.framesOmitted||out.coverage.frameErrors||out.coverage.possibleLoginPage)addWarning(d,{code:'COVERAGE_WARNING',url:displayURL(raw),message:'Some auxiliary coverage is missing or the page contains a password field. Inspect content and coverage before deciding whether the objective is blocked.'});
     }
     output.push(out);d.pages.push({url:out.url,title:out.title||'',route:out.route});
    }catch(e){d.obstacles.push({url:displayURL(raw),code:controller.signal.aborted?(controller.signal.reason.code||'CANCELLED'):(e.code||'RETRIEVAL_ERROR'),message:e.code&&/^[A-Z_]+$/.test(e.code)?e.message.slice(0,160):'Retrieval failed; no credentials or untrusted exception text exposed.'});}
    persist();
   }
   d.state=controller.signal.aborted?(controller.signal.reason.code==='CANCELLED'?'cancelled':output.length?'partial':'failed'):d.obstacles.length?(output.length?'partial':'failed'):'succeeded';
  }catch(e){d.state=e.code==='CANCELLED'?'cancelled':output.length?'partial':'failed';d.obstacles.push({code:e.code||'RETRIEVAL_ERROR',message:'Run ended before all requested content was retrieved.'});}
  finally{
   clearTimeout(timer);d.finishedAt=now();
   d.outcome={contentCaptured:output.length>0,capturedPages:output.length,attemptedPages:seen.size,blockingIssues:d.obstacles.length,warningCount:(d.warnings?.length||0)+(d.warningsOmitted||0),scope:'Document retrieval only; verify the requested objective against returned content. Background warnings do not establish task failure.'};
   persist();this.active=null;
  }
 }
 async close(){if(this.active){this.active.controller.abort(fault('INTERRUPTED'));while(this.active)await new Promise(r=>setTimeout(r,20));}this.db.close();}
}
