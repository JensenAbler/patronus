import { fault } from './network.js';
import { readSolverConfig, solveToken } from './solver.js';

// Installed only for configured jobs. Capture widget callbacks without replacing
// the page's rendering behavior; never inspect unrelated callbacks or submit forms.
export function captureWidgets() {
 const widgets=[];
 Object.defineProperty(window,'__patronusWidgets',{value:widgets,configurable:true});
 const wrapped=new WeakSet();
 const timer=setInterval(()=>{
  for(const [name,type] of [['grecaptcha','recaptcha-v2'],['turnstile','turnstile']]) {
   const api=window[name];
   if(!api||typeof api.render!=='function'||wrapped.has(api.render))continue;
   const original=api.render;
   const render=function(container,options={}) {
    const item={type,sitekey:options.sitekey,invisible:options.size==='invisible',
     managed:!!options.chlPageData||options.action==='managed',callback:options.callback,container};
    widgets.push(item);
    if(widgets.length>20)widgets.shift();
    return original.apply(this,arguments);
   };
   wrapped.add(render);api.render=render;
  }
 },25);
 setTimeout(()=>clearInterval(timer),120000);
}

export async function detectChallenge(page) {
 // Only main-document widgets; arbitrary third-party frames are not authorized
 // to spend the owner's balance or receive a token.
 return page.evaluate(()=>{
  const captured=(window.__patronusWidgets||[]).filter(w=>w.sitekey);
  const element=document.querySelector('.g-recaptcha[data-sitekey],.cf-turnstile[data-sitekey]');
  let w=captured[0];
  if(!w&&element)w={type:element.classList.contains('cf-turnstile')?'turnstile':'recaptcha-v2',
   sitekey:element.dataset.sitekey,invisible:element.dataset.size==='invisible',
   managed:!!element.dataset.chlPageData||element.dataset.action==='managed'};
  if(!w) {
   const anchor=[...document.querySelectorAll('iframe[src]')].find(e=>{
    try{const u=new URL(e.src);return ['www.google.com','www.recaptcha.net'].includes(u.hostname)&&u.pathname==='/recaptcha/api2/anchor';}catch{return false;}
   });
   if(anchor){const u=new URL(anchor.src);w={type:'recaptcha-v2',sitekey:u.searchParams.get('k'),invisible:u.searchParams.get('size')==='invisible'};}
  }
  if(!w)return null;
  const keys=new Set([...captured.map(c=>c.sitekey),...[...document.querySelectorAll('.g-recaptcha[data-sitekey],.cf-turnstile[data-sitekey]')].map(e=>e.dataset.sitekey)]);
  if(keys.size>1)return {...w,pageurl:location.href,managed:true};
  if(w.type==='turnstile'&&window._cf_chl_opt)w={...w,managed:true};
  const selector=w.type==='turnstile'?'[name="cf-turnstile-response"]':'[name="g-recaptcha-response"]';
  if([...document.querySelectorAll(selector)].some(e=>e.value))return null;
  return {type:w.type,sitekey:w.sitekey,invisible:!!w.invisible,managed:!!w.managed,
   pageurl:location.href};
 });
}

export async function applyToken(page,challenge,token,{callbacks=true}={}) {
 return page.evaluate(({type,sitekey,pageurl,token,callbacks})=>{
  if(location.href!==pageurl)return false;
  const selector=type==='turnstile'?'[name="cf-turnstile-response"]':'[name="g-recaptcha-response"]';
  const elements=[...document.querySelectorAll(selector)];
  // Never fill another widget's token field on a multi-widget page.
  const widgets=[...(window.__patronusWidgets||[])].filter(w=>w.type===type);
  const keys=new Set([...widgets.map(w=>w.sitekey),...[...document.querySelectorAll('.g-recaptcha[data-sitekey],.cf-turnstile[data-sitekey]')].map(e=>e.dataset.sitekey)]);
  if(keys.size>1||elements.length>1)return false;
  for(const el of elements){el.value=token;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
  let callback;
  if(callbacks) {
   callback=widgets.find(w=>w.sitekey===sitekey)?.callback;
   if(!callback) {
    const el=[...document.querySelectorAll('[data-sitekey]')].find(e=>e.dataset.sitekey===sitekey);
    const name=el?.dataset.callback;
    if(name&&/^[A-Za-z_$][\w$]*$/.test(name))callback=window[name];
   }
   if(typeof callback==='string'&&/^[A-Za-z_$][\w$]*$/.test(callback))callback=window[callback];
   if(typeof callback==='function')callback(token);
  }
  return elements.length>0||typeof callback==='function';
 },{...challenge,token,callbacks});
}

export function challengeRequestPolicy(req,state) {
 if(!state?.armed||req.method()!=='POST'||req.redirectedFrom())return null;
 const u=new URL(req.url());
 if(u.protocol!=='https:')return null;
 if(['https://www.google.com','https://www.recaptcha.net'].includes(u.origin)&&
    /^\/recaptcha\/api2\/(reload|userverify|clear)$/.test(u.pathname))return {allowed:true,kind:'captcha-verification'};
 if((u.origin==='https://challenges.cloudflare.com'||u.origin===state.origin)&&
    u.pathname.startsWith('/cdn-cgi/challenge-platform/'))return {allowed:true,kind:'captcha-verification'};
 return null;
}

export function configuredSolver(engine,args) {
 return args.solveCaptchas===false?null:readSolverConfig(engine.root);
}

export async function solvePageChallenge(engine,page,d,args,signal,state,{callbacks=true}={}) {
 const config=configuredSolver(engine,args);
 if(!config)return false;
 const challenge=await detectChallenge(page);
 if(!challenge)return false;
 const attempts=d.solverAttempts??=[];
 if(attempts.length>=config.maxTasksPerJob)throw fault('SOLVER_TASK_LIMIT');
 const receipt={type:challenge.type,state:'detected',startedAt:new Date().toISOString()};
 attempts.push(receipt);engine.save(d);
 try {
  state.origin=new URL(challenge.pageurl).origin;
  const token=await solveToken({config,challenge,signal,record:update=>{Object.assign(receipt,update);engine.save(d);}});
  if(signal.aborted)throw signal.reason;
  state.armed=true;
  if(!(await applyToken(page,challenge,token,{callbacks})))throw fault('SOLVER_TOKEN_NOT_APPLIED');
  receipt.state='applied';engine.save(d);
  // Keep the narrow verification window open for asynchronous callbacks.
  await page.waitForTimeout?.(1000);
  if(signal.aborted)throw signal.reason;
  return true;
 }catch(e) {
  receipt.state=receipt.state==='submitting'?'submission-uncertain':'failed';
  receipt.code=/^[A-Z_]+$/.test(e.code||'')?e.code:'SOLVER_FAILED';engine.save(d);
  throw fault(receipt.code);
 }finally{state.armed=false;config.apiKey='';}
}
