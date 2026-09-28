import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
export const agent = 'Patronus/0.1 (+https://github.com/JensenAbler/patronus)';
export function fault(code, message = code) { return Object.assign(new Error(message), { code }); }
export function safeURL(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.port && !['80','443'].includes(u.port))) throw fault('URL_POLICY');
  return u;
}
// Search engines wrap result links in redirectors whose real destination is a
// query value. Unwrap those first so the destination survives display.
export function unwrapRedirect(u) {
  const h=u.hostname.replace(/^www\./,'');let t=null;
  if(['duckduckgo.com','html.duckduckgo.com','lite.duckduckgo.com'].includes(h)&&u.pathname==='/l/') t=u.searchParams.get('uddg');
  else if(/^google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(h)&&u.pathname==='/url') t=u.searchParams.get('q')||u.searchParams.get('url');
  else if(h==='bing.com'&&u.pathname==='/ck/a'){const v=u.searchParams.get('u');if(v?.startsWith('a1'))t=Buffer.from(v.slice(2).replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8');}
  if(!t) return null;
  try { const n=new URL(t); return ['http:','https:'].includes(n.protocol)?n:null; } catch { return null; }
}
// Redact parameters whose name suggests a credential, and any value that looks
// like an opaque token (long, no spaces, token charset). Ordinary values such as
// search queries, page numbers and ids stay readable.
const SECRET_KEY=/token|secret|passw|pwd|session|sig|auth|key|credential|jwt|otp|ticket|nonce|cookie|^x-amz-|^x-goog-|^(code|state|sid|pass|hash|policy)$/i;
export function sensitiveParam(k,v) {
  if(SECRET_KEY.test(k)) return true;
  if(/^eyJ[\w-]+\.[\w-]+/.test(v)) return true;
  return v.length>=32 && /^[A-Za-z0-9+/=_\-.~%]+$/.test(v) && !/^https?:/i.test(v);
}
export function displayURL(raw) {
  try {
    let u=new URL(raw);
    for(let i=0;i<3;i++){const n=unwrapRedirect(u);if(!n)break;u=n;}
    u.username='';u.password='';u.hash='';
    if(u.search){const out=new URLSearchParams();for(const [k,v] of u.searchParams)out.append(k,sensitiveParam(k,v)?'[redacted]':v);u.search=out.toString();}
    return u.href;
  } catch { return '[invalid URL]'; }
}
export function isPublic(address) {
  try { let a=ipaddr.parse(address); if(a.kind()==='ipv6' && a.isIPv4MappedAddress()) a=a.toIPv4Address(); return a.range()==='unicast'; } catch { return false; }
}
export async function resolvePublic(raw, resolver=lookup) {
  const u=safeURL(raw), hostname=u.hostname.replace(/^\[|\]$/g,'');
  const rows=await resolver(hostname,{all:true});
  if (!rows.length || rows.some(r=>!isPublic(r.address))) throw fault('NETWORK_POLICY','Destination is not a public address.');
  return {u,address:rows[0].address,family:rows[0].family};
}
export async function request(raw,{signal,headers={},trace=()=>{},redirects=8}={}) {
  let current=raw;
  for(let n=0;n<=redirects;n++) {
    const {u,address,family}=await resolvePublic(current);
    const response=await new Promise((resolve,reject)=>{
      const req=(u.protocol==='https:'?https:http).request(u,{
        method:'GET',signal,headers:{'user-agent':agent,'accept-encoding':'identity',...headers},
        lookup:(_h,opts,cb)=> opts?.all ? cb(null,[{address,family}]) : cb(null,address,family)
      },resolve);
      req.once('error',reject);req.setTimeout(30000,()=>req.destroy(fault('TIMEOUT')));req.end();
    });
    trace({url:displayURL(current),status:response.statusCode,client:agent});
    if([301,302,303,307,308].includes(response.statusCode)&&response.headers.location) {
      const next=new URL(response.headers.location,u).href;
      if(new URL(next).origin!==u.origin) headers={};
      response.resume();current=next;continue;
    }
    return {response,url:current};
  }
  throw fault('REDIRECT_LIMIT');
}
// DNS is resolved and checked once, then the socket is pinned to that address.
// Both ordinary HTTP and CONNECT traffic use this same policy.
export async function startProxy({signal,maxBytes,onBytes=()=>{}}={}) {
  const sockets=new Set();let total=0;
  const count=chunk=>{total+=chunk.length;onBytes(total);if(total>maxBytes) for(const s of sockets)s.destroy();};
  const server=http.createServer(async(req,res)=>{
    try {
      if(!['GET','HEAD'].includes(req.method))throw fault('METHOD_POLICY');
      const {u,address,family}=await resolvePublic(req.url);
      const upstream=http.request(u,{method:req.method,headers:{...req.headers,host:u.host},lookup:(_h,o,cb)=>o?.all?cb(null,[{address,family}]):cb(null,address,family)},r=>{
        res.writeHead(r.statusCode,r.headers);r.on('data',count);r.pipe(res);
      });
      upstream.on('error',()=>{res.destroy();});req.pipe(upstream);
    }catch{res.writeHead(403);res.end();}
  });
  server.on('connect',async(req,client,head)=>{
    try{
      const {address,u}=await resolvePublic('https://'+req.url);
      if(u.port && u.port!=='443')throw fault('PORT_POLICY');
      const upstream=net.connect({host:address,port:443});
      sockets.add(upstream);upstream.on('close',()=>sockets.delete(upstream));
      upstream.setTimeout(30000,()=>upstream.destroy());
      upstream.on('error',()=>client.destroy());
      upstream.on('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);upstream.on('data',count);upstream.pipe(client);client.pipe(upstream);});
      client.on('error',()=>upstream.destroy());client.on('close',()=>upstream.destroy());
    }catch{client.end('HTTP/1.1 403 Forbidden\r\n\r\n');}
  });
  server.on('connection',s=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const close=()=>{for(const s of sockets)s.destroy();server.close();};
  signal?.addEventListener('abort',close,{once:true});
  return {url:'http://127.0.0.1:'+server.address().port,close,bytes:()=>total};
}
