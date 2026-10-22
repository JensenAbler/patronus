import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
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
// One public-address-pinned transport for retrievals, browser HTTP, and provider
// POSTs. Prefer the configured upstream; availability fallback happens only
// before dispatch. Never retry an origin request or an established tunnel.
const availabilityFailures=new Set(['ROUTE_UNAVAILABLE','ROUTE_TIMEOUT','ROUTE_GATEWAY_UNAVAILABLE']);
export function logEgressRoute(event) {
  if(event.fallback)console.warn(JSON.stringify({event:'patronus_egress',...event}));
}
function reportRoute(onRoute,event) {
  // Diagnostics must neither leak target URLs/credentials nor change routing.
  try{onRoute(event);}catch{}
}
async function preferredTunnel(route,address,port,{signal,timeout=5000,onRoute=logEgressRoute,transport='request'}={}) {
  if(!route){reportRoute(onRoute,{transport,route:'alpha',fallback:false,reason:'unconfigured'});return null;}
  try {
    const socket=await connectVia(route,address,port,{signal,timeout});
    reportRoute(onRoute,{transport,route:'upstream',fallback:false,reason:'configured'});
    return socket;
  }catch(error){
    if(signal?.aborted)throw signal.reason;
    if(!availabilityFailures.has(error.code))throw error;
    // No HTTP headers, credentials, body, or browser tunnel bytes were sent:
    // CONNECT establishment failed before callers obtained the socket.
    reportRoute(onRoute,{transport,route:'alpha',fallback:true,reason:error.code});
    return null;
  }
}
export async function publicRequest(raw, {signal,headers={},method='GET',body,
  timeout=30000,anyPort=false,routes=[],egressProxy=process.env.PATRONUS_EGRESS_PROXY,
  resolver=lookup,onRoute=logEgressRoute,upstreamTimeout=5000}={}) {
  const fallback=parseEgressProxy(egressProxy);
  signal?.throwIfAborted();
  const {u,address,family}=await resolvePublic(raw,resolver,{anyPort});
  signal?.throwIfAborted();
  const route=routeFor(u.hostname,routes)||fallback;
  const socket=await preferredTunnel(route,address,Number(u.port)||(u.protocol==='https:'?443:80),
    {signal,timeout:Math.min(timeout,upstreamTimeout),onRoute});
  if(signal?.aborted){socket?.destroy();signal.throwIfAborted();}
  let requestAgent;
  if(socket) {
    const secure=u.protocol==='https:',hostname=u.hostname.replace(/^\[|\]$/g,'');
    requestAgent=new (secure?https.Agent:http.Agent)({keepAlive:false,maxSockets:1});
    // The target remains the original hostname for Host, SNI, and certificate
    // verification. Only the already-validated IP is sent to CONNECT.
    requestAgent.createConnection=()=>secure
      ?tls.connect({socket,host:hostname,servername:net.isIP(hostname)?undefined:hostname,rejectUnauthorized:true})
      :socket;
  }
  return new Promise((resolve,reject)=>{
    let req,dispatched=false,originReady=false,bytesAtAttach=0;
    const write=!['GET','HEAD','OPTIONS'].includes(method.toUpperCase());
    const uncertain=()=>Object.assign(fault('REQUEST_OUTCOME_UNCERTAIN'),{outcomeUncertain:true});
    const classify=error=>{
      if(signal?.aborted)return signal.reason;
      return write&&originReady&&(dispatched||(req.socket?.bytesWritten||0)>bytesAtAttach)?uncertain():error;
    };
    const cleanup=()=>{requestAgent?.destroy();socket?.destroy();};
    try {
      req=(u.protocol==='https:'?https:http).request(u,{
        method,signal,headers,...(requestAgent?{agent:requestAgent}:{}),
        lookup:(_h,opts,cb)=>opts?.all?cb(null,[{address,family}]):cb(null,address,family)
      },response=>{
        // A response proves dispatch. A truncated response to a write can hide
        // the result, so expose uncertainty rather than invite a resend.
        response.once('error',error=>{
          if(write&&!signal?.aborted)Object.assign(error,{code:'REQUEST_OUTCOME_UNCERTAIN',message:'REQUEST_OUTCOME_UNCERTAIN',outcomeUncertain:true});
        });
        response.once('close',cleanup);
        resolve(response);
      });
      req.once('socket',s=>{
        bytesAtAttach=s.bytesWritten||0;
        if(s.encrypted){originReady=!!s.authorized;s.once('secureConnect',()=>{originReady=true;});}
        else{originReady=!s.connecting;s.once('connect',()=>{originReady=true;});}
        if(socket&&u.protocol==='http:')s.resume();
      });
      req.once('finish',()=>{dispatched=true;});
      req.once('error',error=>{const failure=classify(error);cleanup();reject(failure);});
      req.setTimeout(timeout,()=>req.destroy(fault('TIMEOUT')));
      req.end(body);
    } catch(error) {cleanup();reject(error);}
  });
}
export async function request(raw,{signal,headers={},trace=()=>{},redirects=8,...transport}={}) {
  let current=raw;
  for(let n=0;n<=redirects;n++) {
    const u=safeURL(current);let egress;
    const response=await publicRequest(current,{
      // This redirect-following reader remains GET-only. Write callers use
      // publicRequest directly, which never follows redirects or replays.
      ...transport,method:'GET',body:undefined,signal,headers:{'user-agent':agent,'accept-encoding':'identity',...headers},
      onRoute:event=>{egress=event;reportRoute(transport.onRoute||logEgressRoute,event);}
    });
    trace({url:displayURL(current),status:response.statusCode,client:agent,egress});
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
// Availability fallback to Alpha is permitted only before origin dispatch.
function parseProxy(spec,code) {
  let via;try{via=new URL(spec);}catch{throw fault(code);}
  const host=via.hostname.replace(/^\[|\]$/g,'');
  if(via.protocol!=='http:'||!via.port||!['127.0.0.1','localhost','::1'].includes(host)||
    via.username||via.password||via.pathname!=='/'||via.search||via.hash)throw fault(code);
  // Avoid resolving even the upstream hostname through external DNS.
  return {host:host==='localhost'?'127.0.0.1':host,port:Number(via.port)};
}
export function parseEgressProxy(spec=process.env.PATRONUS_EGRESS_PROXY) {
  if(spec===undefined||spec===null||String(spec).trim()==='')return null;
  return parseProxy(String(spec).trim(),'EGRESS_CONFIG');
}
export function parseRoutes(spec='') {
  const routes=[];
  for(const part of String(spec||'').split(';').map(s=>s.trim()).filter(Boolean)){
    const i=part.lastIndexOf('=');if(i<1)throw fault('ROUTE_CONFIG');
    const via=parseProxy(part.slice(i+1).trim(),'ROUTE_CONFIG');
    const hosts=part.slice(0,i).split(',').map(h=>h.trim().toLowerCase().replace(/^\.+|\.+$/g,'')).filter(Boolean);
    if(!hosts.length||hosts.some(h=>!/^[a-z0-9.-]+$/.test(h)))throw fault('ROUTE_CONFIG');
    routes.push({hosts,...via});
  }
  return routes;
}
export function routeFor(hostname,routes=[]) {
  const h=String(hostname).toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');
  return routes.find(r=>r.hosts.some(d=>h===d||h.endsWith('.'+d)))||null;
}
// Opens a socket already tunneled to address:port through the route's CONNECT proxy.
export function connectVia(route,address,port,{signal,timeout=30000}={}) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(signal.reason);return;}
    const s=net.connect({host:route.host,port:route.port});
    let buf=Buffer.alloc(0),settled=false;
    const clean=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);s.off('data',onData);s.off('error',error);s.off('close',closed);};
    const fail=e=>{if(settled)return;settled=true;clean();s.destroy();reject(e);};
    // Empty disconnects/timeouts are availability failures. Once the proxy
    // sends protocol bytes, an incomplete response is not permission to bypass it.
    const unavailable=code=>fail(fault(buf.length?'ROUTE_PROTOCOL':code));
    const abort=()=>fail(signal.reason),error=()=>unavailable('ROUTE_UNAVAILABLE'),closed=()=>unavailable('ROUTE_UNAVAILABLE');
    const timer=setTimeout(()=>unavailable('ROUTE_TIMEOUT'),timeout);
    signal?.addEventListener('abort',abort,{once:true});
    s.on('error',error);s.once('close',closed);
    s.once('connect',()=>{const target=(address.includes(':')?'['+address+']':address)+':'+port;s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);});
    const onData=chunk=>{
      buf=Buffer.concat([buf,chunk]);const end=buf.indexOf('\r\n\r\n');
      if(end<0){if(buf.length>16384)fail(fault('ROUTE_PROTOCOL'));return;}
      if(end>16384)return fail(fault('ROUTE_PROTOCOL'));
      const statusLine=buf.subarray(0,end).toString('latin1').split('\r\n',1)[0];
      const status=/^HTTP\/1\.[01] ([1-5][0-9]{2})(?:[ \t].*)?$/.exec(statusLine);
      if(!status)return fail(fault('ROUTE_PROTOCOL'));
      const code=Number(status[1]);
      if([502,503,504].includes(code))return fail(fault('ROUTE_GATEWAY_UNAVAILABLE'));
      if(code!==200)return fail(fault('ROUTE_REFUSED'));
      s.pause();settled=true;clean();
      const rest=buf.subarray(end+4);if(rest.length)s.unshift(rest);resolve(s);
    };
    s.on('data',onData);
  });
}
// DNS is resolved and checked once, then the socket is pinned to that address.
// Both ordinary HTTP and CONNECT traffic use this same policy.
// The desktop browser (anyPort) may reach public services on any port, such as
// DirectAdmin on 2222; retrieval jobs stay on 80/443. Private addresses never pass.
export async function startProxy({signal,maxBytes,onBytes=()=>{},anyPort=false,routes=[],
  egressProxy=process.env.PATRONUS_EGRESS_PROXY,resolver=lookup,onRoute=logEgressRoute,upstreamTimeout=5000}={}) {
  const fallback=parseEgressProxy(egressProxy);
  signal?.throwIfAborted();
  const sockets=new Set(),shutdown=new AbortController();let total=0;
  const count=chunk=>{total+=chunk.length;onBytes(total);if(total>maxBytes)close();};
  const server=http.createServer(async(req,res)=>{
    const disconnected=new AbortController();
    const done=()=>disconnected.abort(fault('CANCELLED'));
    res.once('close',done);
    const requestSignal=AbortSignal.any([shutdown.signal,disconnected.signal]);
    try {
      if(!['GET','HEAD'].includes(req.method))throw fault('METHOD_POLICY');
      // Proxy-only headers are for this hop; forwarding them would reveal the proxy.
      const u=safeURL(req.url,{anyPort});
      const headers={...req.headers,host:u.host};delete headers['proxy-connection'];delete headers['proxy-authorization'];
      const upstream=await publicRequest(u.href,{method:req.method,headers,signal:requestSignal,anyPort,routes,egressProxy,resolver,upstreamTimeout,
        onRoute:event=>reportRoute(onRoute,{...event,transport:'browser-http'})});
      if(requestSignal.aborted){upstream.destroy();return;}
      res.writeHead(upstream.statusCode,upstream.headers);
      upstream.on('error',()=>res.destroy());upstream.on('data',count);upstream.pipe(res);
    }catch{if(!res.destroyed){res.writeHead(403);res.end();}}
  });
  server.on('connect',async(req,client,head)=>{
    const disconnected=new AbortController(),pending=[head];let pendingBytes=head.length;
    const cancel=()=>{disconnected.abort(fault('CANCELLED'));client.destroy();};
    client.once('close',cancel);client.once('end',cancel);
    // Observe disconnects while CONNECT negotiation is pending without losing
    // eagerly sent tunnel bytes. Bound this pre-tunnel buffer.
    const buffer=chunk=>{pendingBytes+=chunk.length;if(pendingBytes>65536)cancel();else pending.push(chunk);};
    client.on('data',buffer);
    if(pendingBytes>65536){cancel();return;}
    const requestSignal=AbortSignal.any([shutdown.signal,disconnected.signal]);
    try{
      const {address,u}=await resolvePublic('https://'+req.url,resolver,{anyPort});
      requestSignal.throwIfAborted();
      // CONNECT also carries WebSockets. The browser owns end-to-end TLS.
      const port=Number(u.port)||443,route=routeFor(u.hostname,routes)||fallback;
      const tunnel=await preferredTunnel(route,address,port,{signal:requestSignal,timeout:upstreamTimeout,onRoute,transport:'browser-connect'});
      if(requestSignal.aborted){tunnel?.destroy();return;}
      const upstream=tunnel||net.connect({host:address,port});
      client.pause();client.off('data',buffer);client.off('end',cancel);
      // Closing an idle upstream must also close the browser's tunnel.
      sockets.add(upstream);upstream.on('close',()=>{sockets.delete(upstream);client.destroy();});
      upstream.setTimeout(30000,()=>upstream.destroy());
      upstream.on('error',()=>client.destroy());
      const ready=()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');for(const chunk of pending)if(chunk.length)upstream.write(chunk);upstream.on('data',count);upstream.pipe(client);client.pipe(upstream);};
      if(tunnel)ready();else upstream.on('connect',ready);
      client.on('error',()=>upstream.destroy());client.on('close',()=>upstream.destroy());
    }catch{client.off('data',buffer);if(!client.destroyed)client.end('HTTP/1.1 403 Forbidden\r\n\r\n');}
  });
  server.on('connection',s=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));});
  const close=()=>{shutdown.abort(fault('CANCELLED'));signal?.removeEventListener('abort',close);for(const s of sockets)s.destroy();server.close();};
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const url='http://127.0.0.1:'+server.address().port;
  signal?.addEventListener('abort',close,{once:true});
  if(signal?.aborted){close();signal.throwIfAborted();}
  return {url,close,bytes:()=>total};
}
