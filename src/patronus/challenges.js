import { fault } from './network.js';
import { readSolverConfig, solveToken } from './solver.js';

// Installed only for configured jobs. Capture widget callbacks without replacing
// the page's rendering behavior; never inspect unrelated callbacks or submit forms.
export function captureWidgets() {
 const widgets=[];
 Object.defineProperty(window,'__patronusWidgets',{value:widgets,configurable:true});
 const wrapped=new WeakSet();
 const timer=setInterval(()=>{
  for(const [name,type] of [['grecaptcha','recaptcha-v2'],['turnstile','turnstile'],['hcaptcha','hcaptcha']]) {
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
  const element=document.querySelector('.g-recaptcha[data-sitekey],.cf-turnstile[data-sitekey],.h-captcha[data-sitekey]');
  let w=captured[0];
  if(!w&&element)w={type:element.classList.contains('cf-turnstile')?'turnstile':element.classList.contains('h-captcha')?'hcaptcha':'recaptcha-v2',
   sitekey:element.dataset.sitekey,invisible:element.dataset.size==='invisible',
   managed:!!element.dataset.chlPageData||element.dataset.action==='managed'};
  if(!w) {
   const anchor=[...document.querySelectorAll('iframe[src]')].find(e=>{
    try{const u=new URL(e.src);return ['www.google.com','www.recaptcha.net'].includes(u.hostname)&&u.pathname==='/recaptcha/api2/anchor';}catch{return false;}
   });
   if(anchor){const u=new URL(anchor.src);w={type:'recaptcha-v2',sitekey:u.searchParams.get('k'),invisible:u.searchParams.get('size')==='invisible'};}
  }
  if(!w) {
   const inputs=[...document.querySelectorAll('input')],images=[...document.querySelectorAll('img')],pairs=[];
   for(const input of inputs) {
    if(!['text',''].includes(input.getAttribute('type')||'')||input.disabled||input.readOnly||input.value||
       !/captcha/i.test((input.name||'')+' '+(input.id||'')))continue;
    let parent=input.parentElement;
    for(let depth=0;parent&&depth<3;depth++,parent=parent.parentElement) {
     const candidates=[...parent.querySelectorAll('img')].filter(img=>/captcha/i.test((img.alt||'')+' '+(img.id||'')+' '+new URL(img.currentSrc||img.src,location.href).pathname.split('/').pop())&&
      !/logo/i.test(img.alt||'')&&!/\.svg(?:[?#]|$)/i.test(img.currentSrc||img.src));
     if(candidates.length!==1)continue;
     const img=candidates[0];
     pairs.push({type:'image',pageurl:location.href,inputIndex:inputs.indexOf(input),imageIndex:images.indexOf(img),
      inputId:input.id||'',inputName:input.name||'',imageSrc:img.currentSrc||img.src});break;
    }
   }
   return pairs.length===1?pairs[0]:null;
  }
  const keys=new Set([...captured.map(c=>c.sitekey),...[...document.querySelectorAll('.g-recaptcha[data-sitekey],.cf-turnstile[data-sitekey],.h-captcha[data-sitekey]')].map(e=>e.dataset.sitekey)]);
  if(keys.size>1)return {...w,pageurl:location.href,managed:true};
  if(w.type==='turnstile'&&window._cf_chl_opt)w={...w,managed:true};
  const selector=w.type==='turnstile'?'[name="cf-turnstile-response"]':w.type==='hcaptcha'?'[name="h-captcha-response"], [name="g-recaptcha-response"]':'[name="g-recaptcha-response"]';
  if([...document.querySelectorAll(selector)].some(e=>e.value))return null;
  return {type:w.type,sitekey:w.sitekey,invisible:!!w.invisible,managed:!!w.managed,
   pageurl:location.href};
 });
}

export async function applyToken(page,challenge,token,{callbacks=true}={}) {
 return page.evaluate(({type,sitekey,pageurl,token,callbacks})=>{
  if(location.href!==pageurl)return false;
  const selector=type==='turnstile'?'[name="cf-turnstile-response"]':type==='hcaptcha'?'[name="h-captcha-response"], [name="g-recaptcha-response"]':'[name="g-recaptcha-response"]';
  const elements=[...document.querySelectorAll(selector)];
  // Never fill another widget's token field on a multi-widget page.
  const widgets=[...(window.__patronusWidgets||[])].filter(w=>w.type===type);
  const keys=new Set([...widgets.map(w=>w.sitekey),...[...document.querySelectorAll('.g-recaptcha[data-sitekey],.cf-turnstile[data-sitekey],.h-captcha[data-sitekey]')].map(e=>e.dataset.sitekey)]);
  if(keys.size>1||elements.length>(type==='hcaptcha'?2:1)||
     (type==='hcaptcha'&&['h-captcha-response','g-recaptcha-response'].some(name=>elements.filter(e=>e.name===name).length>1)))return false;
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
  if(challenge.type==='image') {
   const image=page.locator('img').nth(challenge.imageIndex);
   if(!await image.isVisible())throw fault('SOLVER_IMAGE_UNAVAILABLE');
   const box=await image.boundingBox();
   if(!box||box.width<1||box.height<1||box.width>2000||box.height>2000)throw fault('SOLVER_IMAGE_LIMIT');
   const bytes=await image.screenshot({type:'png',timeout:5000});
   if(bytes.length>1048576)throw fault('SOLVER_IMAGE_LIMIT');
   challenge.body=bytes.toString('base64');
  }
  const token=await solveToken({config,challenge,signal,record:update=>{Object.assign(receipt,update);engine.save(d);}});
  if(signal.aborted)throw signal.reason;
  state.armed=true;
  if(challenge.type==='image') {
   const unchanged=await page.evaluate(ch=>{
    const input=document.querySelectorAll('input')[ch.inputIndex],img=document.querySelectorAll('img')[ch.imageIndex];
    return location.href===ch.pageurl&&input&&img&&input.id===ch.inputId&&input.name===ch.inputName&&
     (img.currentSrc||img.src)===ch.imageSrc&&!input.value&&!input.disabled&&!input.readOnly;
   },challenge);
   if(!unchanged)throw fault('SOLVER_IMAGE_CHANGED');
   const current=await page.locator('img').nth(challenge.imageIndex).screenshot({type:'png',timeout:5000});
   if(current.toString('base64')!==challenge.body)throw fault('SOLVER_IMAGE_CHANGED');
   await page.locator('input').nth(challenge.inputIndex).fill(token);
  }else if(!(await applyToken(page,challenge,token,{callbacks})))throw fault('SOLVER_TOKEN_NOT_APPLIED');
  receipt.state='applied';engine.save(d);
  // Keep the narrow verification window open for asynchronous callbacks.
  await page.waitForTimeout?.(1000);
  if(signal.aborted)throw signal.reason;
  return true;
 }catch(e) {
  receipt.state=receipt.state==='submitting'?'submission-uncertain':'failed';
  receipt.code=/^[A-Z_]+$/.test(e.code||'')?e.code:'SOLVER_FAILED';engine.save(d);
  throw fault(receipt.code);
 }finally{state.armed=false;config.apiKey='';delete challenge.body;}
}
