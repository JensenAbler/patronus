import { readFileSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startProxy, resolvePublic, fault, agent } from './network.js';
import { browserRequestPolicy, continueBrowserRequest, blockedRequest } from './browser-policy.js';

import { captureWidgets, configuredSolver, solvePageChallenge, challengeRequestPolicy } from './challenges.js';

// Diagnostic URLs never contain query values, cookie values, or form bodies.
export function loginEvidenceURL(raw) {
 try {const u=new URL(raw);return {origin:u.origin,path:u.pathname,queryNames:[...new Set(u.searchParams.keys())]};}
 catch{return {origin:'[invalid URL]',path:'',queryNames:[]};}
}
export function redactLoginText(raw,secrets=[]) {
 let text=String(raw);
 for(const secret of secrets.filter(v=>typeof v==='string'&&v.length))text=text.split(secret).join('[redacted]');
 return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted email]')
  .replace(/[A-Za-z0-9._~+\/-]{64,}/g,'[redacted token]').slice(0,5000);
}
export function trackLoginResponses(page,record) {
 const response=r=>{
  try {
   const req=r.request(),navigation=req.isNavigationRequest()&&r.frame()===page.mainFrame();
   const url=loginEvidenceURL(r.url());
   if(!navigation&&url.origin!=='https://x10hosting.com')return;
   const h=r.headers();
   record({kind:'response',at:new Date().toISOString(),method:req.method(),status:r.status(),navigation,url,
    ...(h.location?{redirect:loginEvidenceURL(new URL(h.location,r.url()).href)}:{}),
    headers:Object.fromEntries(['server','content-type','cf-mitigated','retry-after'].filter(k=>h[k]).map(k=>[k,h[k].slice(0,200)]))});
  }catch{}
 };
 page.on('response',response);
 return ()=>page.off('response',response);
}

export const X10_LOGIN = 'https://x10hosting.com/login';
const origin = new URL(X10_LOGIN).origin;

// Login is explicitly authorized for this account, not a general write permission.
export function loginRequestPolicy(req, state) {
 const u = new URL(req.url());
 if (u.protocol !== 'https:') return {allowed:false,reason:'LOGIN_HTTPS_REQUIRED'};
 if (req.method() === 'POST') {
  if (u.origin === origin && u.pathname === '/login' && !u.search &&
      state.submitArmed && !state.submitted && !req.redirectedFrom() &&
      req.frame().url().startsWith(origin + '/')) {
   state.submitted = true;
   return {allowed:true,kind:'login'};
  }
  const challengeDecision=challengeRequestPolicy(req,state.solverState);
  if(challengeDecision)return challengeDecision;
  if (state.challengeArmed && u.origin === 'https://www.google.com' &&
      /^\/recaptcha\/api2\/(reload|userverify|clear)$/.test(u.pathname)) {
   return {allowed:true,kind:'challenge'};
  }
  return {allowed:false,reason:'LOGIN_METHOD_POLICY'};
 }
 if (state.credentialsFilled && u.origin !== origin) return {allowed:false,reason:'LOGIN_ORIGIN_POLICY'};
 if (state.credentialsFilled && ['/logout','/reset'].includes(u.pathname)) return {allowed:false,reason:'LOGIN_ACTION_POLICY'};
 return browserRequestPolicy(req);
}

export function readX10Credentials(root) {
 const path = join(root,'accounts','x10.json');
 let st, value;
 try { st=lstatSync(path); } catch { throw fault('ACCOUNT_MISSING'); }
 if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) || st.size > 16384)
  throw fault('ACCOUNT_FILE_POLICY');
 try { value=JSON.parse(readFileSync(path,'utf8')); } catch { throw fault('ACCOUNT_INVALID'); }
 if (typeof value.email !== 'string' || !value.email.trim() ||
     typeof value.password !== 'string' || !value.password) throw fault('ACCOUNT_INVALID');
 return value;
}

export async function setX10Remember(form) {
 const checkbox=form.locator('input[type=checkbox]');
 if(await checkbox.count()!==1||await checkbox.isChecked())return;
 if(await checkbox.isVisible())await checkbox.check({timeout:5000});
 else {
  const label=form.locator('label[for="remember"]');
  if(await checkbox.getAttribute('id')!=='remember'||await label.count()!==1||!(await label.isVisible()))
   throw fault('LOGIN_REMEMBER_UNAVAILABLE');
  // A solved reCAPTCHA panel may still intercept physical pointer events.
  await label.evaluate(el=>el.click());
 }
 if(!(await checkbox.isChecked()))throw fault('LOGIN_REMEMBER_UNAVAILABLE');
}

export async function locateX10Fields(form) {
 const candidates=form.locator('input[type=email], input[name=email], input[type=text][name^="x10_username_"]');
 const visible=[];
 for(let n=0;n<await candidates.count();n++) {
  const field=candidates.nth(n);if(await field.isVisible())visible.push(field);
 }
 const passwords=form.locator('input[type=password]');
 if(visible.length!==1||await passwords.count()!==1||!(await passwords.isVisible()))
  throw fault('LOGIN_FORM_CHANGED');
 return {identifier:visible[0],password:passwords};
}

export async function x10Login(engine,d,args,signal) {
 const credentials=readX10Credentials(engine.root);
 const profile=join(engine.root,'profiles','x10');
 mkdirSync(profile,{recursive:true,mode:0o700});
 let context, page, stopTracking, observedBytes=0, stage='BROWSER_START';
 const diagnostic={stage,timeline:[{stage,at:new Date().toISOString()}],network:[],blocked:[]};
 d.loginDiagnostic=diagnostic;
 const mark=value=>{stage=value;diagnostic.stage=value;if(diagnostic.timeline.length<30)diagnostic.timeline.push({stage:value,at:new Date().toISOString()});engine.save(d);};
 const record=item=>{if(diagnostic.network.length<100)diagnostic.network.push(item);engine.save(d);};
 const blocked={};
 const state={submitArmed:false,submitted:false,challengeArmed:false,solverState:{armed:false}};
 const solver=configuredSolver(engine,args);
 const proxy=await startProxy({signal,maxBytes:args.maxBytes-d.bytes,onBytes:n=>{d.bytes+=n-observedBytes;observedBytes=n;}});
 try {
  context=await engine.launch({path:profile,config:{channel:'chromium',headless:true,chromiumSandbox:true,
   proxy:{server:proxy.url,bypass:'<-loopback>'},serviceWorkers:'block',acceptDownloads:false,
   permissions:[],userAgent:agent,args:['--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--disable-background-networking']}});
  if(signal.aborted)throw signal.reason;
  signal.addEventListener('abort',()=>context.close().catch(()=>{}),{once:true});
  if(solver){solver.apiKey='';await context.addInitScript(captureWidgets);}
  await context.route('**/*',async route=>{
   try {
    if(signal.aborted)throw fault('CANCELLED');
    const req=route.request(),decision=loginRequestPolicy(req,state);
    if(!decision.allowed)throw fault(decision.reason);
    await resolvePublic(req.url());
    engine.budget(d,args);
    await continueBrowserRequest(route,decision);
   } catch(e) { const code=/^[A-Z_]+$/.test(e.code||'')?e.code:'REQUEST_FAILED';blocked[code]=(blocked[code]||0)+1;
    if(diagnostic.blocked.length<50)diagnostic.blocked.push({...blockedRequest(route.request(),code),at:new Date().toISOString(),stage});
    engine.save(d);await route.abort().catch(()=>{}); }
  });
  await context.routeWebSocket('**/*',ws=>ws.close());
  page=context.pages()[0]||await context.newPage();
  stopTracking=trackLoginResponses(page,record);
  page.on('dialog',dialog=>dialog.dismiss());
  page.on('download',download=>download.cancel());
  mark('NAVIGATION');
  const response=await page.goto(X10_LOGIN,{waitUntil:'commit',timeout:30000});
  mark('PAGE_READY');
  await page.waitForTimeout(5000);
  if(response?.status()>=400)throw fault(response.status()===403?'ACCESS_DENIED':'HTTP_ERROR');
  const authenticated=async()=>{
   const u=new URL(page.url());
   return u.origin===origin && !['/login','/error','/reset'].includes(u.pathname.replace(/\/$/,''))
    && !(await page.locator('input[type=password]').count())
    && await page.locator('a[href*="/logout"], form[action*="/logout"]').count()>0;
  };
  if(await authenticated())return {url:X10_LOGIN,route:'browser',title:'X10 account access',
   login:{authenticated:true,freshLogin:false,outcome:'EXISTING_SESSION',verifiedAt:new Date().toISOString()},
   coverage:{scope:'Authenticated portal marker verified; a fresh credential login was not performed.'}};

  mark('LOGIN_FORM');
  await page.locator('input[type=password]').waitFor({state:'visible',timeout:15000});
  if(new URL(page.url()).origin!==origin)throw fault('LOGIN_ORIGIN_MISMATCH');
  const form=page.locator('form').filter({has:page.locator('input[type=password]')});
  if(await form.count()!==1)throw fault('LOGIN_FORM_CHANGED');
  const action=await form.getAttribute('action');
  const target=new URL(action||page.url(),page.url());
  if(target.href!==X10_LOGIN)throw fault('LOGIN_FORM_CHANGED');
  const fields=await locateX10Fields(form);

  // A normal checkbox interaction can succeed without an image challenge.
  // If normal verification needs help, use the privately configured solver.
  const challenge=page.frames().find(f=>f.url().startsWith('https://www.google.com/recaptcha/api2/anchor'));
  if(challenge) {
   mark('CHALLENGE');
   state.challengeArmed=true;
   const verification={clickOutcome:'pending'};
   await challenge.locator('#recaptcha-anchor').click({timeout:5000})
    .then(()=>verification.clickOutcome='clicked',e=>verification.clickOutcome=e.name==='TimeoutError'?'timeout':'failed');
   const deadline=Date.now()+15000;
   let ready=false;
   while(Date.now()<deadline&&!signal.aborted) {
    ready=await page.locator('textarea[name="g-recaptcha-response"]').evaluateAll(els=>els.some(e=>e.value.length>0));
    if(ready)break;
    if(await page.frames().find(f=>f.url().includes('/recaptcha/api2/bframe'))?.locator('.rc-imageselect').isVisible().catch(()=>false))
     break;
    await page.waitForTimeout(500);
   }
   state.challengeArmed=false;
   if(!ready&&solver) {
    ready=await solvePageChallenge(engine,page,d,args,signal,state.solverState,{callbacks:false});
   }
   if(!ready) {
    verification.anchorChecked=await challenge.locator('#recaptcha-anchor').getAttribute('aria-checked').catch(()=>null);
    verification.frameText=[];
    for(const frame of page.frames().filter(f=>/^https:\/\/www\.google\.com\/recaptcha\/api2\/(anchor|bframe)/.test(f.url()))) {
     const text=await frame.locator('body').innerText({timeout:2000}).catch(()=>'');
     const imageVisible=await frame.locator('.rc-imageselect').isVisible().catch(()=>false);
     verification.frameText.push({kind:frame.url().includes('/bframe')?'challenge':'checkbox',text:text.slice(0,1600),imageVisible});
    }
    d.verificationDiagnostic=verification;engine.save(d);
    throw fault(verification.frameText.some(f=>f.imageVisible)?'INTERACTIVE_CHALLENGE_PRESENT':verification.clickOutcome==='timeout'?'VERIFICATION_CHECKBOX_UNAVAILABLE':'VERIFICATION_NOT_COMPLETED');
   }
  }
  mark('IDENTIFIER_FILL');
  state.credentialsFilled=true;
  await fields.identifier.fill(credentials.email);
  mark('PASSWORD_FILL');
  await fields.password.fill(credentials.password);
  mark('REMEMBER_ME');
  await setX10Remember(form);
  mark('SUBMIT');
  state.submitArmed=true;
  // requestSubmit retains native validation and submit handlers even when an
  // already-solved CAPTCHA popup obscures the submit button.
  await form.evaluate(f=>{
   if(f.action!=='https://x10hosting.com/login'||f.method.toLowerCase()!=='post')throw new Error('LOGIN_FORM_CHANGED');
   f.requestSubmit();
  });
  await page.waitForTimeout(500);
  const deadline=Date.now()+15000;
  while(Date.now()<deadline&&!signal.aborted) {
   if(await authenticated())return {url:X10_LOGIN,route:'browser',title:'X10 login',
    login:{authenticated:true,freshLogin:state.submitted,outcome:'AUTHENTICATED',verifiedAt:new Date().toISOString()},
    coverage:{scope:'Same-origin authenticated account portal and logout marker verified.'}};
   if(new URL(page.url()).pathname==='/error')throw fault('ACCESS_DENIED');
   await page.waitForTimeout(500);
  }
  throw fault(state.submitted?'LOGIN_NOT_VERIFIED':'LOGIN_SUBMISSION_BLOCKED');
 } catch(e) {
  Object.assign(diagnostic,{stage,credentialSubmissionObserved:state.submitted,blockedRequests:blocked,finishedAt:new Date().toISOString()});
  if(page) {
   try {
    diagnostic.finalURL=loginEvidenceURL(page.url());
    diagnostic.title=redactLoginText(await page.title(),[credentials.email,credentials.password]);
    const tokens=await page.locator('[name="g-recaptcha-response"],[name="h-captcha-response"],[name="cf-turnstile-response"]').evaluateAll(els=>els.map(e=>e.value).filter(Boolean));
    const selector=new URL(page.url()).pathname==='/error'?'body':'[role="alert"],.alert,.invalid-feedback';
    diagnostic.visibleMessage=redactLoginText(await page.locator(selector).allTextContents().then(t=>t.join('\n')),[credentials.email,credentials.password,...tokens]);
   }catch{diagnostic.pageCapture='unavailable';}
  }
  engine.save(d);
  if(/^[A-Z_]+$/.test(e.code||''))throw e;
  throw fault(e.name==='TimeoutError'?'LOGIN_TIMEOUT_'+stage:'LOGIN_FAILED_'+stage);
 } finally {
  stopTracking?.();
  credentials.email='';credentials.password='';
  await context?.close().catch(()=>{});
  proxy.close();
 }
}
