import express from 'express';
import {typeDesktopText,validHandoffText} from './handoff-input.js';
import { createHash, randomBytes } from 'node:crypto';

const token = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fail = (code, status = 409) => Object.assign(new Error(code), {code, status});
const KEYS = new Set(['Enter','Tab','Shift+Tab','Escape','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown']);
const exact = (body, keys) => body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every(key => keys.includes(key));

/** Ephemeral owner-only control of the existing X11 session. No browser is created. */
export function createHandoff({baseUrl, call, verifyPassword, typeText = typeDesktopText, now = Date.now, sessionMs = 900000, idleMs = 60000}) {
  const base = new URL(baseUrl), path = base.pathname.replace(/\/$/,'') + '/handoff';
  const secure = base.protocol === 'https:';
  const cookieName = secure ? '__Secure-patronus_handoff' : 'patronus_handoff';
  const loginName = cookieName + '_login';
  const sessions = new Map(), logins = new Map();
  let lease = null, inFlight = false, agentInFlight = 0;
  const router = express.Router();
  const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=')));
  const cookie = (res, name, value, maxAge) => res.cookie(name, value, {httpOnly:true, secure, sameSite:'strict', path, maxAge});
  const clearCookie = res => cookie(res, cookieName, '', 0);
  const release = () => { if (lease) { lease.inputController?.abort(); lease.frame = null; lease = null; } };
  const sweep = () => {
    const time = now();
    if (lease && (lease.expiresAt <= time || lease.lastSeen + idleMs <= time)) release();
    for (const [key, s] of sessions) if (s.expiresAt <= time) sessions.delete(key);
    for (const [key, s] of logins) if (s.expiresAt <= time) logins.delete(key);
  };
  const session = req => { sweep(); const raw = cookies(req)[cookieName]; return raw && /^[\w-]{43}$/.test(raw) ? sessions.get(hash(raw)) : undefined; };
  const origin = (req,res,next) => req.get('origin') === base.origin ? next() : res.status(403).json({error:'INVALID_ORIGIN'});
  const authorize = (req,res,next) => {
    const s = session(req);
    if (!s) { clearCookie(res); return res.status(401).json({error:'SESSION_EXPIRED'}); }
    if (req.get('x-handoff-csrf') !== s.csrf && req.body?.csrf !== s.csrf) return res.status(403).json({error:'INVALID_CSRF'});
    req.handoff = s; next();
  };
  const owns = s => { sweep(); if (lease !== s) throw fail('CONTROL_NOT_HELD'); s.lastSeen = now(); };
  const state = s => ({expiresAt:new Date(s.expiresAt).toISOString(), active:lease === s, nextSequence:s.nextSequence, viewport:{width:1280,height:720}});
  router.use((_req,res,next) => {
    res.set({'Cache-Control':'no-store, max-age=0','Pragma':'no-cache','Referrer-Policy':'strict-origin',
      'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});
    next();
  });
  router.use(express.json({limit:'8kb'}));
  router.use(express.urlencoded({extended:false,limit:'8kb'}));
  function loginPage(req,res,error = '') {
    sweep();
    // A bounded anonymous pool prevents an unauthenticated memory leak.
    if (logins.size >= 200) logins.delete(logins.keys().next().value);
    const raw = token(), csrf = token();
    logins.set(hash(raw), {csrf,expiresAt:now()+300000});
    cookie(res, loginName, raw, 300000);
    res.type('html').send(page('Sign in to Patronus', '<p>Use your existing Patronus owner password. This page can show and control the same browser on Alpha, including logged-in pages.</p>' +
      (error ? '<p role="alert">'+escape(error)+'</p>' : '') +
      '<form method="post" action="'+path+'/login"><input type="hidden" name="csrf" value="'+csrf+'"><label>Patronus password<input name="password" type="password" maxlength="1024" autocomplete="current-password" required></label><button>Sign in</button></form><p>Control expires 15 minutes after sign-in. The Done button ends it immediately.</p>'));
  }
  router.get(['','/'],(req,res) => {
    const s = session(req);
    if (!s) return loginPage(req,res);
    const nonce = token();
    res.set('Content-Security-Policy',res.get('Content-Security-Policy') + "; script-src 'nonce-"+nonce+"'");
    const config = JSON.stringify({path,csrf:s.csrf,...state(s)}).replace(/</g,'\\u003c');
    res.type('html').send(page('Patronus handoff', '<p id="status" role="status">Ready to take control of the same browser on Alpha</p><p id="clock"></p>' +
      '<div class="controls"><button id="take">Take control</button><button id="refresh" disabled>Refresh</button><button id="keyboard" class="input" disabled>Keyboard</button><button id="done">Done</button></div>' +
      '<p>Tap the screen to click. Pinch to zoom, or use Full size and pan for small targets. Scroll buttons move the remote page.</p>' +
      '<div class="controls"><button id="zoom">Full size</button><button class="input" data-scroll="-3" disabled>Scroll up</button><button class="input" data-scroll="3" disabled>Scroll down</button></div>' +
      '<div id="screen-wrap"><img id="screen" width="1280" height="720" alt="The private Patronus desktop appears after you take control" draggable="false"></div>' +
      '<div class="controls"><button class="input" data-key="Tab" disabled>Tab</button><button class="input" data-key="Enter" disabled>Enter</button><button class="input" data-key="Backspace" disabled>Backspace</button><button class="input" data-key="Escape" disabled>Escape</button></div>' +
      '<div id="typing" hidden><p>First tap the field in the remote browser. Then type here and tap Send text. Text stays hidden and is cleared after sending.</p><label>Text for the selected remote field<input id="remote-text" type="password" inputmode="text" enterkeyhint="done" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="1000" data-lpignore="true" data-1p-ignore></label><button id="send-text" class="input" disabled>Send text</button></div>' +
      '<p>Keyboard opens your phone’s keyboard. Send text types into the selected remote field; Enter submits only when you press it separately. Close this page or tap Done when finished.</p>' +
      '<script nonce="'+nonce+'">('+handoffClient.toString()+')('+config+')</script>'));
  });
  router.post('/login',origin,async(req,res,next) => {
    try {
      sweep();
      const raw = cookies(req)[loginName], key = raw && hash(raw), pre = key && logins.get(key);
      if (key) logins.delete(key);
      cookie(res,loginName,'',0);
      if (!pre || pre.expiresAt <= now() || req.body.csrf !== pre.csrf) return res.status(403).send('Sign-in expired. Reload this page.');
      const password = req.body.password;
      if (typeof password !== 'string' || password.length > 1024 || !await verifyPassword(password,req.ip)) return loginPage(req,res.status(401),'Incorrect Patronus password');
      if (sessions.size >= 20) return res.status(429).send('Too many active sessions. Try again shortly.');
      const id = token(), s = {csrf:token(),expiresAt:now()+sessionMs,lastSeen:now(),nextSequence:1,frame:null,desktopStartedAt:null};
      sessions.set(hash(id),s);
      cookie(res,cookieName,id,sessionMs);
      res.redirect(303,path);
    } catch(e) { next(e); }
  });
  router.post('/take',origin,authorize,(req,res,next) => {
    try {
      const s = req.handoff;
      if (lease && lease !== s) throw fail('ANOTHER_SESSION_CONTROLS_DESKTOP');
      if (inFlight || agentInFlight) throw fail('DESKTOP_BUSY');
      lease = s; s.lastSeen = now();
      res.json(state(s));
    } catch(e) { next(e); }
  });
  async function capture(s,args) {
    owns(s);
    if (inFlight) throw fail('DESKTOP_BUSY');
    inFlight = true;
    try {
      if (args.action !== 'screenshot') {
        const current = await call('patronus_capabilities',{});
        owns(s);
        if (!s.desktopStartedAt || current.desktop?.startedAt !== s.desktopStartedAt) { release(); s.expiresAt=now(); throw fail('DESKTOP_SESSION_CHANGED'); }
        if (args.action === 'type') {
          if(current.desktop?.state!=='running')throw fail('DESKTOP_NOT_RUNNING');
          s.inputController = new AbortController();
          try { await typeText({text:args.text,display:current.desktop.display,signal:s.inputController.signal}); }
          finally { delete args.text; s.inputController=null; }
          owns(s);args.action='screenshot';
        }
      }
      const result = await call('patronus_desktop',{...args,idempotencyKey:'human-'+token()});
      owns(s);
      if (s.desktopStartedAt && result.desktop?.startedAt !== s.desktopStartedAt) { release(); throw fail('DESKTOP_SESSION_CHANGED'); }
      if (!result.desktop?.startedAt || typeof result.screenshot !== 'string' || result.screenshot.length > 6000000 || result.screenshotMimeType !== 'image/jpeg') throw fail('INVALID_DESKTOP_FRAME',502);
      s.desktopStartedAt = result.desktop.startedAt;
      s.frame = {id:token(),at:now()};
      return {...state(s),frameId:s.frame.id,image:result.screenshot,mimeType:'image/jpeg'};
    } finally { inFlight = false; }
  }
  router.post('/frame',origin,authorize,async(req,res,next) => {
    try { res.json(await capture(req.handoff,{action:'screenshot'})); } catch(e) { next(e); }
  });
  router.post('/action',origin,authorize,async(req,res,next) => {
    try {
      const s = req.handoff, b = req.body; owns(s);
      if (inFlight) throw fail('DESKTOP_BUSY');
      if (!exact(b,['csrf','action','x','y','dy','key','text','frameId','sequence']) || ('text' in b && b.action !== 'type')) throw fail('INVALID_ACTION',400);
      if (!Number.isSafeInteger(b.sequence) || b.sequence !== s.nextSequence) throw fail('STALE_SEQUENCE');
      if (!s.frame || b.frameId !== s.frame.id || s.frame.at+15000 < now()) throw fail('STALE_FRAME');
      const args = {action:b.action};
      if (b.action === 'click') {
        if (!Number.isInteger(b.x) || b.x < 0 || b.x > 1279 || !Number.isInteger(b.y) || b.y < 0 || b.y > 719) throw fail('INVALID_COORDINATE',400);
        Object.assign(args,{x:b.x,y:b.y});
      } else if (b.action === 'scroll') {
        if (!Number.isInteger(b.dy) || b.dy === 0 || Math.abs(b.dy)>10) throw fail('INVALID_SCROLL',400);
        Object.assign(args,{x:640,y:360,dy:b.dy});
      } else if (b.action === 'type') {
        if (!validHandoffText(b.text)) throw fail('INVALID_TEXT_INPUT',400);
        args.text=b.text;delete b.text;
      } else if (b.action === 'key') {
        if (!KEYS.has(b.key)) throw fail('INVALID_KEY',400);
        args.key=b.key;
      } else throw fail('INVALID_ACTION',400);
      // Consume BEFORE calling: errors or lost responses cannot replay a click.
      s.nextSequence++; s.frame=null;
      res.json(await capture(s,args));
    } catch(e) { next(e); }
  });
  router.post('/heartbeat',origin,authorize,(req,res,next) => {
    try { owns(req.handoff); res.json(state(req.handoff)); } catch(e) { next(e); }
  });
  router.post('/finish',origin,authorize,(req,res) => {
    const s = req.handoff;
    if (lease === s) release();
    for (const [key,value] of sessions) if (value === s) sessions.delete(key);
    clearCookie(res); res.json({ended:true});
  });
  router.use((e,_req,res,_next) => {
    if (res.headersSent) return res.end();
    const known = /^[A-Z_]+$/.test(e.code || '');
    res.status(e.status || (e.type === 'entity.too.large' ? 413 : 500)).json({error:known?e.code:'HANDOFF_REQUEST_FAILED'});
  });
  const timer=setInterval(sweep,1000); timer.unref();
  return {router,
    status(){sweep();return {enabled:true,url:base.origin+path,ownerPasswordRequired:true,sessionSeconds:900,controlActive:!!lease,...(lease?{expiresAt:new Date(lease.expiresAt).toISOString()}:{})};},
    async guard(name,operation) {
      if (name !== 'patronus_desktop') return operation();
      sweep();
      if (lease) throw fail('DESKTOP_HUMAN_CONTROL');
      if (inFlight) throw fail('DESKTOP_BUSY');
      agentInFlight++;
      try { return await operation(); } finally { agentInFlight--; }
    },
    close(){clearInterval(timer);release();sessions.clear();logins.clear();},
  };
}

function page(title,body) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+title+'</title><style>' +
    'body{font:16px system-ui;margin:0 auto;padding:16px;max-width:1100px;background:#101820;color:#f5f7fa;line-height:1.4}h1{font-size:24px}p{max-width:70ch}input,button{font:inherit;padding:12px;border-radius:9px;border:1px solid #81909d}input{display:block;max-width:90%;margin:8px 0}button{background:#e6f1fc;color:#10202c;min-height:44px}button:disabled{opacity:.45}.controls{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}#screen-wrap{overflow:auto;border:1px solid #627080;border-radius:8px;background:#000;min-height:160px}#screen{display:block;width:100%;height:auto;max-width:none;user-select:none;-webkit-user-select:none;touch-action:pan-x pan-y pinch-zoom}#screen-wrap.full #screen{width:1280px}#status{font-weight:600}a{color:#a9d5ff}</style></head><body><h1>'+title+'</h1>'+body+'</body></html>';
}

function handoffClient(config) {
  const byId=id=>document.getElementById(id);
  const status=byId('status'),screen=byId('screen'),take=byId('take'),refresh=byId('refresh'),done=byId('done');
  const textInput=byId('remote-text'),typing=byId('typing');
  const clearText=()=>{textInput.value='';textInput.blur();typing.hidden=true;};
  let active=config.active,busy=false,ended=false,frameId=null,nextSequence=config.nextSequence,renderedAt=0,pointer=null;
  const deadline=Date.parse(config.expiresAt);
  const update=()=>{take.disabled=busy||active||ended;refresh.disabled=busy||!active||ended;document.querySelectorAll('.input').forEach(b=>b.disabled=busy||!active||!frameId||ended);};
  async function request(route,body={}) {
    const response=await fetch(config.path+'/'+route,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Handoff-CSRF':config.csrf},body:JSON.stringify(body)});
    let data;try{data=await response.json();}catch{throw Error('Connection interrupted. Refresh before continuing');}
    if(!response.ok){if(['CONTROL_NOT_HELD','DESKTOP_SESSION_CHANGED'].includes(data.error)){clearText();active=false;}if(response.status===401){clearText();ended=true;active=false;screen.removeAttribute('src');}throw Error(/^HANDOFF_INPUT_/.test(data.error||'')?'Typing may have stopped partway. Inspect the remote field before sending again':data.error||'Request failed');}
    return data;
  }
  function render(data) {
    if(ended||Date.now()>=deadline||document.hidden){clearText();frameId=null;screen.removeAttribute('src');return;}
    nextSequence=data.nextSequence;active=data.active;
    if(data.image){screen.src='data:image/jpeg;base64,'+data.image;frameId=data.frameId;renderedAt=Date.now();}
    status.textContent=active?'You have exclusive control. Tap the browser image to click':'Ready to take control';
  }
  async function run(operation) {
    if(busy||ended)return;busy=true;update();
    try{await operation();}catch(e){frameId=null;if(!ended)status.textContent=e.message+' · Refresh to see the current screen';}finally{busy=false;update();}
  }
  const frame=()=>run(async()=>render(await request('frame')));
  take.onclick=()=>run(async()=>{render(await request('take'));render(await request('frame'));});
  refresh.onclick=frame;
  byId('keyboard').onclick=()=>{if(!active||busy||ended)return;typing.hidden=false;textInput.focus();};
  async function sendText(){
    if(busy||ended||!active||!textInput.value)return;
    if(!frameId||Date.now()-renderedAt>12000){status.textContent='Refresh before sending; your text is still here';return;}
    const text=textInput.value;textInput.value='';textInput.blur();
    await action({action:'type',text});
  }
  byId('send-text').onclick=sendText;
  textInput.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();textInput.blur();}});
  async function action(args) {
    if(!active||!frameId||Date.now()-renderedAt>12000){status.textContent='Refresh the screen before clicking';return;}
    await run(async()=>{const id=frameId;frameId=null;render(await request('action',{...args,frameId:id,sequence:nextSequence}));});
  }
  screen.addEventListener('pointerdown',e=>{if(e.isPrimary)pointer={x:e.clientX,y:e.clientY,at:Date.now()};});
  screen.addEventListener('pointercancel',()=>{pointer=null;});
  screen.addEventListener('pointerup',e=>{
    const p=pointer;pointer=null;
    if(!p||!e.isPrimary||Math.hypot(p.x-e.clientX,p.y-e.clientY)>8||Date.now()-p.at>700)return;
    const r=screen.getBoundingClientRect();
    const x=Math.min(1279,Math.max(0,Math.floor((e.clientX-r.left)*1280/r.width)));
    const y=Math.min(719,Math.max(0,Math.floor((e.clientY-r.top)*720/r.height)));
    action({action:'click',x,y});
  });
  document.querySelectorAll('[data-key]').forEach(b=>b.onclick=()=>action({action:'key',key:b.dataset.key}));
  document.querySelectorAll('[data-scroll]').forEach(b=>b.onclick=()=>action({action:'scroll',dy:Number(b.dataset.scroll)}));
  byId('zoom').onclick=()=>{const full=byId('screen-wrap').classList.toggle('full');byId('zoom').textContent=full?'Fit screen':'Full size';};
  done.onclick=async()=>{
    if(ended)return;
    clearText();done.disabled=true;
    try{await request('finish');ended=true;active=false;frameId=null;screen.removeAttribute('src');status.textContent='Handoff ended. You can close this page';}
    catch(e){done.disabled=false;status.textContent='Could not confirm Done. Retry, or close this page; control releases after one minute';}
    update();
  };
  setInterval(()=>{const seconds=Math.max(0,Math.ceil((deadline-Date.now())/1000));byId('clock').textContent='Session time left: '+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');if(!seconds&&!ended){clearText();ended=true;active=false;screen.removeAttribute('src');status.textContent='Session expired. Sign in again for a new handoff';update();}},1000);
  setInterval(()=>{if(active&&!busy&&!ended&&!document.hidden)frame();},5000);
  document.addEventListener('visibilitychange',()=>{if(document.hidden){clearText();frameId=null;pointer=null;screen.removeAttribute('src');update();}else if(active&&!ended)frame();});
  window.addEventListener('pagehide',()=>{const revoke=!ended;clearText();ended=true;active=false;frameId=null;screen.removeAttribute('src');update();if(revoke)navigator.sendBeacon(config.path+'/finish',new Blob([JSON.stringify({csrf:config.csrf})],{type:'application/json'}));});
  window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
  update();if(active)frame();
}
