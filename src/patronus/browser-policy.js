import { displayURL, fault } from './network.js';

// Read mode never types, clicks or submits, so the only write it could make is a
// navigation that carries a body (a form submission or a 307 replaying one). Block
// those. Everything else a page issues on its own while loading (fetch/XHR POSTs,
// beacons, anti-bot challenge handshakes, framework data calls) is allowed: blocking
// it broke ordinary sites (Linktree, Patreon, Google Forms) in the 2026-10-21 evals.
export function browserRequestPolicy(req) {
 const method=req.method();
 if(['GET','HEAD'].includes(method))return {allowed:true,kind:'safe-method'};
 let type='';
 try{type=req.resourceType();}catch{}
 if(type==='document')return {allowed:false,reason:'FORM_SUBMISSION_POLICY'};
 return {allowed:true,kind:'page-request'};
}
export function blockedRequest(req,reason) {
 // Omit query strings entirely in diagnostics. Content URLs have their separate
 // display policy; request telemetry does not need query values.
 let url='[invalid URL]';try{const u=new URL(req.url());u.search='';u.hash='';url=displayURL(u.href);}catch{}
 return {code:'SUBREQUEST_BLOCKED',reason,url,method:req.method(),resourceType:req.resourceType(),message:'A page request was blocked; see reason.'};
}


// A permitted POST must not be redirected outside the inspected endpoint.
// route.fetch uses the browser context's proxy; maxRedirects=0 prevents replay.
export async function continueBrowserRequest(route,decision){
 if(!['graphql-query','captcha-verification'].includes(decision.kind))return route.continue();
 const response=await route.fetch({maxRedirects:0,timeout:30000});
 try{
  if(response.status()>=300&&response.status()<400)throw fault('POST_REDIRECT_POLICY');
  await route.fulfill({response});
 }finally{await response.dispose();}
}
