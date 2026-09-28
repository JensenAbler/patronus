import { parse, Kind } from 'graphql';
import { displayURL, fault } from './network.js';

// HTTP verbs alone cannot identify read-only GraphQL traffic. Fail closed on
// opaque/persisted/batched operations; never log request bodies or credentials.
export function browserRequestPolicy(req) {
 const method=req.method();
 if(['GET','HEAD'].includes(method))return {allowed:true,kind:'safe-method'};
 const deny={allowed:false,reason:'METHOD_POLICY'};
 if(method!=='POST'||!['fetch','xhr'].includes(req.resourceType()))return deny;
 try {
  const url=new URL(req.url()),frame=new URL(req.frame().url());
  if(url.protocol!=='https:'||url.origin!==frame.origin||!/(?:^|\/)graphql(?:-public)?\/?$/.test(url.pathname))return deny;
  if((req.headers()['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json')return deny;
  const raw=req.postData();
  if(!raw||Buffer.byteLength(raw)>262144)return deny;
  const body=JSON.parse(raw);
  if(!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).some(k=>!['query','variables','operationName'].includes(k)))return deny;
  if(typeof body.query!=='string'||(body.operationName!=null&&typeof body.operationName!=='string')||
    (body.variables!=null&&(typeof body.variables!=='object'||Array.isArray(body.variables))))return deny;
  const ast=parse(body.query,{maxTokens:10000});
  const ops=ast.definitions.filter(d=>d.kind===Kind.OPERATION_DEFINITION);
  if(!ops.length||ops.some(o=>o.operation!=='query')||ast.definitions.some(d=>![Kind.OPERATION_DEFINITION,Kind.FRAGMENT_DEFINITION].includes(d.kind)))return deny;
  if(body.operationName!=null?!ops.some(o=>o.name?.value===body.operationName):ops.length!==1)return deny;
  return {allowed:true,kind:'graphql-query'};
 }catch{return deny;}
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
 if(decision.kind!=='graphql-query')return route.continue();
 const response=await route.fetch({maxRedirects:0,timeout:30000});
 try{
  if(response.status()>=300&&response.status()<400)throw fault('POST_REDIRECT_POLICY');
  await route.fulfill({response});
 }finally{await response.dispose();}
}
