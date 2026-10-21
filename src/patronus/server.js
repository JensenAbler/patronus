import http from 'node:http';
import { mkdirSync, chmodSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Patronus } from './engine.js';
import { Desktop } from './desktop.js';
import { startDesktopEnvironment } from './desktop-environment.js';
import { patronusTools } from './schema.js';
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k));
const validLease = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export async function serve({root='/var/lib/patronus',socket='/run/patronus/api.sock'}={}) {
 const desktopEnvironment=process.env.PATRONUS_NATIVE_DESKTOP==='1'?await startDesktopEnvironment():null;
 const engine=new Patronus(root);
 // The persistent human-first browser runs only where the installer enables it.
 if(process.env.PATRONUS_DESKTOP==='1'){engine.desktop=new Desktop({root});engine.desktop.start().catch(()=>console.error('patronus_desktop_start_failed'));}
 mkdirSync(dirname(socket),{recursive:true,mode:0o700});if(existsSync(socket))unlinkSync(socket);
 const server=http.createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  try{
   if(req.method!=='POST'||!['/call','/desktop-lease'].includes(req.url))throw new Error('BAD_REQUEST');
   let body='';for await(const b of req){body+=b;if(body.length>100000)throw new Error('REQUEST_LIMIT');}
   const input=JSON.parse(body);
   if(req.url==='/desktop-lease'){
    if(!exact(input,['action','args']))throw new Error('INVALID_ARGUMENT');
    const {action,args}=input;let data;
    if(action==='acquire'&&exact(args,['kind'])&&['owner','agent'].includes(args.kind))data=engine.desktopLease.acquire(args);
    else if(action==='release'&&exact(args,['leaseId'])&&validLease(args.leaseId))data=engine.desktopLease.release(args);
    else if(action==='status'&&exact(args,[]))data=engine.desktopLease.status();
    else throw new Error('INVALID_ARGUMENT');
    res.end(JSON.stringify({ok:true,data}));return;
   }
   if(!exact(input,['action','args','leaseId','ownerText','expectedDesktopStartedAt']))throw new Error('INVALID_ARGUMENT');
   const {action,args,leaseId,ownerText,expectedDesktopStartedAt}=input,tool=patronusTools[action];if(!tool)throw new Error('UNKNOWN_ACTION');
   if(leaseId!==undefined&&(!validLease(leaseId)||action!=='patronus_desktop'))throw new Error('INVALID_ARGUMENT');
   if(ownerText!==undefined&&(ownerText!==true||action!=='patronus_desktop'||args?.action!=='type'||!leaseId||typeof args.text!=='string'||args.credential!==undefined))throw new Error('INVALID_ARGUMENT');
   if(expectedDesktopStartedAt!==undefined&&(typeof expectedDesktopStartedAt!=='string'||!expectedDesktopStartedAt.length||expectedDesktopStartedAt.length>100||action!=='patronus_desktop'||args?.action==='screenshot'||!leaseId))throw new Error('INVALID_ARGUMENT');
   const parsed=tool.schema.safeParse(args);if(!parsed.success)throw new Error('INVALID_ARGUMENT');
   const data=await engine[tool.method](parsed.data,...(action==='patronus_desktop'?[{leaseId,ownerText,expectedDesktopStartedAt}]:[]));res.end(JSON.stringify({ok:true,data}));
  }catch(e){res.statusCode=400;res.end(JSON.stringify({ok:false,error:{code:/^[A-Z][A-Z0-9_]+$/.test(e.code||e.message)?e.code||e.message:'PATRONUS_ERROR',message:'Patronus could not complete this operation.'}}));}
 });
 await new Promise(r=>server.listen(socket,r));chmodSync(socket,0o660);
 const timer=setInterval(()=>engine.tick().catch(()=>console.error('patronus_tick_failed')),500);
 const desktopTimer=engine.desktop?setInterval(()=>engine.desktop.ensure().catch(()=>console.error('patronus_desktop_ensure_failed')),15000):null;
 return {engine,server,close:async()=>{clearInterval(timer);clearInterval(desktopTimer);engine.desktopLease.close();await new Promise(r=>server.close(r));await engine.desktop?.stop();await engine.close();await desktopEnvironment?.stop();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const svc=await serve({root:process.env.PATRONUS_DATA_DIR,socket:process.env.PATRONUS_SOCKET});let closing=false;
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{if(closing)return;closing=true;const deadline=setTimeout(()=>process.exit(1),20000);await svc.close();clearTimeout(deadline);process.exit(0);});
 console.log('Patronus listening');
}
