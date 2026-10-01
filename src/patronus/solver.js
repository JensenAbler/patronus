import { openSync, fstatSync, readFileSync, closeSync, constants } from 'node:fs';
import { join } from 'node:path';
import https from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolvePublic, safeURL, fault } from './network.js';

const endpoint='https://api.solvecaptcha.com';
const knownErrors=new Set(['ERROR_WRONG_USER_KEY','ERROR_KEY_DOES_NOT_EXIST','ERROR_ZERO_BALANCE','ERROR_NO_SLOT_AVAILABLE','ERROR_CAPTCHA_UNSOLVABLE','ERROR_WRONG_CAPTCHA_ID','ERROR_BAD_PARAMETERS','ERROR_BAD_TOKEN_OR_PAGEURL','ERROR_IP_NOT_ALLOWED','ERROR_METHOD_NOT_SUPPORTED','ERROR_BAD_METHOD','ERROR_TOO_BIG_CAPTCHA_FILESIZE','ERROR_IMAGE_TYPE_NOT_SUPPORTED']);
export function readSolverConfig(root) {
 let fd;
 try { fd=openSync(join(root,'solvecaptcha.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK); }
 catch(e) { if(e.code==='ENOENT')return null;throw fault('SOLVER_CONFIG_POLICY'); }
 try {
  const st=fstatSync(fd);
  if(!st.isFile()||(st.mode&0o077)||st.size>16384)throw fault('SOLVER_CONFIG_POLICY');
  let value;try{value=JSON.parse(readFileSync(fd,'utf8'));}catch{throw fault('SOLVER_CONFIG_INVALID');}
  if(value.enabled===false)return null;
  if(value.enabled!==true||typeof value.apiKey!=='string'||! /^[a-fA-F0-9]{32}$/.test(value.apiKey)||
     !Number.isInteger(value.maxTasksPerJob)||value.maxTasksPerJob<1||value.maxTasksPerJob>5)
   throw fault('SOLVER_CONFIG_INVALID');
  return {apiKey:value.apiKey,maxTasksPerJob:value.maxTasksPerJob};
 }finally{closeSync(fd);}
}

// Never place keys in URLs or return provider exception text. No redirects or retries.
export async function solverTransport(path,params,signal) {
 if(!['/in.php','/res.php'].includes(path))throw fault('SOLVER_ENDPOINT_POLICY');
 const {u,address,family}=await resolvePublic(endpoint+path);
 const body=new URLSearchParams({...params,json:'1'}).toString();
 return new Promise((resolve,reject)=>{
  const req=https.request(u,{method:'POST',signal,headers:{'content-type':'application/x-www-form-urlencoded','content-length':Buffer.byteLength(body)},
   lookup:(_h,opts,cb)=>opts?.all?cb(null,[{address,family}]):cb(null,address,family)},res=>{
   if(res.statusCode!==200){res.destroy();reject(fault('SOLVER_HTTP_ERROR'));return;}
   const chunks=[];let bytes=0;
   res.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536){res.destroy();reject(fault('SOLVER_RESPONSE_LIMIT'));}else chunks.push(chunk);});
   res.on('error',()=>reject(fault('SOLVER_NETWORK_ERROR')));
   res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(fault('SOLVER_RESPONSE_INVALID'));}});
  });
  req.on('error',()=>reject(signal?.aborted?signal.reason:fault('SOLVER_NETWORK_ERROR')));
  req.setTimeout(15000,()=>req.destroy());
  req.end(body);
 });
}

export async function solveToken({config,challenge,signal,record,transport=solverTransport,wait=(ms,s)=>sleep(ms,undefined,{signal:s}),maxPolls=challenge.type==='hcaptcha'?48:24}) {
 const u=safeURL(challenge.pageurl);
 if(u.protocol!=='https:'||!['recaptcha-v2','turnstile','hcaptcha','image'].includes(challenge.type)||
    (challenge.type==='image' ? typeof challenge.body!=='string'||challenge.body.length>1398104||! /^[A-Za-z0-9+/]+={0,2}$/.test(challenge.body) :
     typeof challenge.sitekey!=='string'||!/^[A-Za-z0-9_-]{10,256}$/.test(challenge.sitekey)))
  throw fault('SOLVER_CHALLENGE_UNSUPPORTED');
 const params={key:config.apiKey,pageurl:u.href};
 if(challenge.type==='recaptcha-v2')Object.assign(params,{method:'userrecaptcha',googlekey:challenge.sitekey,version:'v2',invisible:challenge.invisible?'1':'0'});
 else if(challenge.type==='image')Object.assign(params,{method:'base64',body:challenge.body});
 else Object.assign(params,{method:challenge.type==='hcaptcha'?'hcaptcha':'turnstile',sitekey:challenge.sitekey});
 // Managed Cloudflare challenges require browser identity matching and are not
 // treated as ordinary widgets. Do not submit incomplete challenge parameters.
 if(challenge.managed)throw fault('SOLVER_CHALLENGE_UNSUPPORTED');
 const providerError=r=>fault(knownErrors.has(r?.request)?'SOLVER_'+r.request:'SOLVER_PROVIDER_ERROR');
 const call=async(path,p)=>{try{return await transport(path,p,signal);}catch(e){if(signal?.aborted)throw signal.reason;throw fault(/^SOLVER_[A-Z_]+$/.test(e.code||'')?e.code:'SOLVER_NETWORK_ERROR');}};
 if(signal?.aborted)throw signal.reason;
 // Durable receipt precedes the paid POST. Unknown outcomes are never resubmitted.
 record({state:'submitting',type:challenge.type});
 const task=await call('/in.php',params);
 if(task?.status!==1)throw providerError(task);
 if(typeof task.request!=='string'||!/^\d{1,40}$/.test(task.request))throw fault('SOLVER_RESPONSE_INVALID');
 record({state:'polling',taskId:task.request,type:challenge.type});
 for(let n=0;n<maxPolls;n++) {
  await wait(n===0&&challenge.type==='recaptcha-v2'?20000:5000,signal);
  if(signal?.aborted)throw signal.reason;
  const result=await call('/res.php',{key:config.apiKey,action:'get',id:task.request});
  if(result?.status===1) {
   if(typeof result.request!=='string'||!(challenge.type==='image'?/^[^\x00-\x1f\x7f]{1,256}$/:/^[A-Za-z0-9._~-]{20,32768}$/).test(result.request))throw fault('SOLVER_RESPONSE_INVALID');
   record({state:'solved',taskId:task.request,type:challenge.type});
   return result.request;
  }
  if(result?.request!=='CAPCHA_NOT_READY')throw providerError(result);
 }
 throw fault('SOLVER_TIMEOUT');
}
