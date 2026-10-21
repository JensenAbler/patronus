import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
export const agent = 'Patronus/0.1 (+https://github.com/JensenAbler/patronus)';
export function fault(code, message = code) { return Object.assign(new Error(message), { code }); }
export function safeURL(raw, { anyPort = false } = {}) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (!anyPort && u.port && !['80','443'].includes(u.port))) throw fault('URL_POLICY');
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
export async function resolvePublic(raw, resolver=lookup, { anyPort = false } = {}) {
  const u=safeURL(raw,{anyPort}), hostname=u.hostname.replace(/^\[|\]$/g,'');
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
// Owner-configured upstream routes. Some sites reject datacenter addresses, so
// their tunnels leave through a local HTTP CONNECT proxy instead, such as
// Tailscale's outbound proxy to an exit node on the owner's own connection.
// Spec: "host1,host2=http://127.0.0.1:1056;host3=http://127.0.0.1:2000".
// A host matches itself and its subdomains. Only loopback proxies are accepted.
// Routed traffic fails closed: it never falls back to direct egress.
export function parseRoutes(spec='') {
  const routes=[];
  for(const part of String(spec||'').split(';').map(s=>s.trim()).filter(Boolean)){
    const i=part.lastIndexOf('=');if(i<1)throw fault('ROUTE_CONFIG');
    let via;try{via=new URL(part.slice(i+1).trim());}catch{throw fault('ROUTE_CONFIG');}
    const host=via.hostname.replace(/^\[|\]$/g,'');
    if(via.protocol!=='http:'||!via.port||!['127.0.0.1','localhost','::1'].includes(host))throw fault('ROUTE_CONFIG');
    const hosts=part.slice(0,i).split(',').map(h=>h.trim().toLowerCase().replace(/^\.+|\.+$/g,'')).filter(Boolean);
    if(!hosts.length||hosts.some(h=>!/^[a-z0-9.-]+$/.test(h)))throw fault('ROUTE_CONFIG');
    routes.push({hosts,host,port:Number(via.port)});
  }
  return routes;
}
export function routeFor(hostname,routes=[]) {
  const h=String(hostname).toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');
  return routes.find(r=>r.hosts.some(d=>h===d||h.endsWith('.'+d)))||null;
}
// Opens a socket already tunneled to address:port through the route's CONNECT proxy.
export function connectVia(route,address,port) {
  return new Promise((resolve,reject)=>{
    const s=net.connect({host:route.host,port:route.port});
    let buf=Buffer.alloc(0),settled=false;
    const fail=e=>{if(settled)return;settled=true;s.destroy();reject(e);};
    s.setTimeout(30000,()=>fail(fault('ROUTE_TIMEOUT')));
    s.on('error',()=>fail(fault('ROUTE_UNAVAILABLE')));
    s.once('close',()=>fail(fault('ROUTE_UNAVAILABLE')));
    s.once('connect',()=>{const target=(address.includes(':')?'['+address+']':address)+':'+port;s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);});
    const onData=chunk=>{
      buf=Buffer.concat([buf,chunk]);const end=buf.indexOf('\r\n\r\n');
      if(end<0){if(buf.length>16384)fail(fault('ROUTE_PROTOCOL'));return;}
      s.pause();s.off('data',onData);
      if(!/^HTTP\/1\.[01] 200/.test(buf.subarray(0,end).toString('latin1')))return fail(fault('ROUTE_REFUSED'));
      settled=true;s.setTimeout(0);s.removeAllListeners('timeout');s.removeAllListeners('error');s.removeAllListeners('close');
      const rest=buf.subarray(end+4);if(rest.length)s.unshift(rest);resolve(s);
    };
    s.on('data',onData);
  });
}
// DNS is resolved and checked once, then the socket is pinned to that address.
// Both ordinary HTTP and CONNECT traffic use this same policy.
// The desktop browser (anyPort) may reach public services on any port, such as
// DirectAdmin on 2222; retrieval jobs stay on 80/443. Private addresses never pass.
export async function startProxy({signal,maxBytes,onBytes=()=>{},anyPort=false,routes=[]}={}) {
  const sockets=new Set();let total=0;
  const count=chunk=>{total+=chunk.length;onBytes(total);if(total>maxBytes) for(const s of sockets)s.destroy();};
  const server=http.createServer(async(req,res)=>{
    try {
      if(!['GET','HEAD'].includes(req.method))throw fault('METHOD_POLICY');
      const {u,address,family}=await resolvePublic(req.url,lookup,{anyPort});
      // Routed hosts are only tunneled (HTTPS); plain HTTP to them fails closed.
      if(routeFor(u.hostname,routes))throw fault('ROUTE_POLICY');
      // Proxy-only headers are for this hop; forwarding them would reveal the proxy.
      const headers={...req.headers,host:u.host};delete headers['proxy-connection'];delete headers['proxy-authorization'];
      const upstream=http.request(u,{method:req.method,headers,lookup:(_h,o,cb)=>o?.all?cb(null,[{address,family}]):cb(null,address,family)},r=>{
        res.writeHead(r.statusCode,r.headers);r.on('data',count);r.pipe(res);
      });
      upstream.on('error',()=>{res.destroy();});req.pipe(upstream);
    }catch{res.writeHead(403);res.end();}
  });
  server.on('connect',async(req,client,head)=>{
    try{
      const {address,u}=await resolvePublic('https://'+req.url,lookup,{anyPort});
      // Chrome tunnels both ws:// (80) and wss:// (443) through CONNECT.
      // resolvePublic already enforces public addresses and the same 80/443
      // port policy as ordinary retrieval. Received frames are counted below.
      const port=Number(u.port)||443,route=routeFor(u.hostname,routes);
      const upstream=route?await connectVia(route,address,port):net.connect({host:address,port});
      // Closing an idle upstream must also close the browser's tunnel; otherwise
      // it can reuse a socket that can no longer receive a response.
      sockets.add(upstream);upstream.on('close',()=>{sockets.delete(upstream);client.destroy();});
      upstream.setTimeout(30000,()=>upstream.destroy());
      upstream.on('error',()=>client.destroy());
      const ready=()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);upstream.on('data',count);upstream.pipe(client);client.pipe(upstream);};
      if(route)ready();else upstream.on('connect',ready);
      client.on('error',()=>upstream.destroy());client.on('close',()=>upstream.destroy());
    }catch{client.end('HTTP/1.1 403 Forbidden\r\n\r\n');}
  });
  server.on('connection',s=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const close=()=>{for(const s of sockets)s.destroy();server.close();};
  signal?.addEventListener('abort',close,{once:true});
  return {url:'http://127.0.0.1:'+server.address().port,close,bytes:()=>total};
}
