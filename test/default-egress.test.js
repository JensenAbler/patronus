import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { once, EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseEgressProxy, parseRoutes, publicRequest, request, startProxy, connectVia } from '../src/patronus/network.js';
import { solverTransport } from '../src/patronus/solver.js';

const resolver=async()=>[{address:'93.184.216.34',family:4}];
const loopbackConnect=net.connect.bind(net);
const timeout=()=>AbortSignal.timeout(3000);
async function listen(t,server) {
  const sockets=new Set();
  server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{for(const s of sockets)s.destroy();server.close();});
  return server.address().port;
}
async function fixture(t,handler,{secure=false,trusted=true}={}) {
  let server;
  const seen=[],sni=[];
  if(secure) {
    const dir=mkdtempSync(join(tmpdir(),'patronus-tls-'));
    t.after(()=>rmSync(dir,{recursive:true,force:true}));
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=fixture.test',
      '-addext','subjectAltName=DNS:fixture.test,DNS:api.solvecaptcha.com,IP:93.184.216.34',
      '-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')],{stdio:'ignore'});
    const key=readFileSync(join(dir,'key.pem')),cert=readFileSync(join(dir,'cert.pem'));
    if(trusted) {
      const previous=tls.getCACertificates('default');
      tls.setDefaultCACertificates([...previous,cert.toString()]);
      t.after(()=>tls.setDefaultCACertificates(previous));
    }
    server=https.createServer({key,cert},handler);
    server.on('secureConnection',s=>sni.push(s.servername));
    server.on('tlsClientError',()=>{});
  }else server=http.createServer(handler);
  const targetPort=await listen(t,server);
  const proxy=http.createServer();
  proxy.on('connect',(req,client,head)=>{
    seen.push(req.url);
    const upstream=loopbackConnect({host:'127.0.0.1',port:targetPort});
    upstream.on('error',()=>client.destroy());
    client.on('error',()=>upstream.destroy());client.on('close',()=>upstream.destroy());
    upstream.once('connect',()=>{
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head.length)upstream.write(head);
      client.pipe(upstream);upstream.pipe(client);
    });
  });
  const port=await listen(t,proxy);
  return {url:'http://127.0.0.1:'+port,port,seen,sni,server};
}
async function text(res) {let body='';for await(const chunk of res)body+=chunk;return body;}
function envProxy(t,url) {
  const old=process.env.PATRONUS_EGRESS_PROXY;
  process.env.PATRONUS_EGRESS_PROXY=url;
  t.after(()=>{if(old===undefined)delete process.env.PATRONUS_EGRESS_PROXY;else process.env.PATRONUS_EGRESS_PROXY=old;});
}
async function connectBrowser(t,proxy,target) {
  const client=loopbackConnect({host:'127.0.0.1',port:Number(new URL(proxy.url).port)});
  t.after(()=>client.destroy());
  await once(client,'connect',{signal:timeout()});
  const reply=once(client,'data',{signal:timeout()});
  client.write('CONNECT '+target+' HTTP/1.1\r\nHost: '+target+'\r\n\r\n');
  return {client,reply:(await reply)[0].toString()};
}
async function browserHTTP(proxy,target,{method='GET',headers={}}={}) {
  return new Promise((resolve,reject)=>{
    const req=http.request(proxy.url,{method,path:target,headers,signal:timeout()},resolve);
    req.once('error',reject);req.end();
  });
}

test('default proxy accepts only unambiguous loopback HTTP endpoints',()=>{
  assert.equal(parseEgressProxy(''),null);
  assert.equal(parseEgressProxy(null),null);
  assert.deepEqual(parseEgressProxy('http://127.0.0.1:1056'),{host:'127.0.0.1',port:1056});
  assert.deepEqual(parseEgressProxy('http://localhost:1056'),{host:'127.0.0.1',port:1056});
  assert.deepEqual(parseEgressProxy('http://[::1]:1056'),{host:'::1',port:1056});
  for(const bad of ['https://127.0.0.1:1056','http://10.0.0.1:1056','http://example.com:1056',
    'http://127.0.0.1','http://user:pass@127.0.0.1:1056','http://127.0.0.1:1056/path',
    'http://127.0.0.1:1056?x=1','http://127.0.0.1:1056#x','garbage'])
    assert.throws(()=>parseEgressProxy(bad),{code:'EGRESS_CONFIG'},bad);
});

test('ordinary HTTP download defaults to environment upstream and pins DNS once',async t=>{
  const received=[];
  const f=await fixture(t,(req,res)=>{received.push({url:req.url,host:req.headers.host});res.end(Buffer.from([0,1,2,255]));});
  envProxy(t,f.url);
  let lookups=0;
  const result=await request('http://fixture.test/download',{resolver:async host=>{
    lookups++;assert.equal(host,'fixture.test');return resolver();},signal:timeout()});
  const chunks=[];for await(const chunk of result.response)chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks),Buffer.from([0,1,2,255]));
  assert.equal(lookups,1);
  assert.deepEqual(f.seen,['93.184.216.34:80']);
  assert.deepEqual(received,[{url:'/download',host:'fixture.test'}]);
});

test('HTTPS through upstream keeps original SNI, Host, and valid certificate verification',async t=>{
  const received=[];
  const f=await fixture(t,(req,res)=>{received.push(req.headers.host);res.end('secure');},{secure:true});
  const res=await publicRequest('https://fixture.test/path',{resolver,egressProxy:f.url,signal:timeout()});
  assert.equal(await text(res),'secure');
  assert.deepEqual(f.seen,['93.184.216.34:443']);
  assert.deepEqual(f.sni,['fixture.test']);assert.deepEqual(received,['fixture.test']);
});

test('HTTPS rejects mismatched hostname and untrusted certificate instead of bypassing TLS',async t=>{
  for(const trusted of [true,false])await t.test(String(trusted),async t=>{
    const f=await fixture(t,(_req,res)=>res.end('must not arrive'),{secure:true,trusted});
    await assert.rejects(publicRequest(trusted?'https://wrong.test':'https://fixture.test',
      {resolver,egressProxy:f.url,signal:timeout()}),e=>trusted?e.code==='ERR_TLS_CERT_ALTNAME_INVALID':
      ['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN'].includes(e.code));
    assert.equal(f.seen.length,1);
  });
});

test('redirects stay proxied, preserve same-origin headers, strip cross-origin headers, and recheck DNS',async t=>{
  const received=[];
  const f=await fixture(t,(req,res)=>{
    received.push({host:req.headers.host,url:req.url,auth:req.headers.authorization,cookie:req.headers.cookie});
    if(req.url==='/one'){res.writeHead(302,{location:'/two'});res.end();}
    else if(req.url==='/two'){res.writeHead(302,{location:'http://other.test/final'});res.end();}
    else res.end('final');
  });
  const hosts=[];
  const result=await request('http://fixture.test/one',{resolver:async h=>{hosts.push(h);return resolver();},
    egressProxy:f.url,headers:{authorization:'test-secret',cookie:'test-cookie'},signal:timeout()});
  assert.equal(await text(result.response),'final');
  assert.deepEqual(hosts,['fixture.test','fixture.test','other.test']);
  assert.deepEqual(f.seen,['93.184.216.34:80','93.184.216.34:80','93.184.216.34:80']);
  assert.equal(received[1].auth,'test-secret');assert.equal(received[1].cookie,'test-cookie');
  assert.equal(received[2].auth,undefined);assert.equal(received[2].cookie,undefined);
});

test('scheme changes strip secrets and redirect to private or disallowed port never opens a tunnel',async t=>{
  const received=[];
  const plain=await fixture(t,(req,res)=>{received.push(req.headers);res.end('plain');});
  const secure=await fixture(t,(_req,res)=>{res.writeHead(302,{location:'http://other.test/final'});res.end();},{secure:true});
  const result=await request('https://fixture.test/start',{resolver,egressProxy:plain.url,
    routes:parseRoutes('fixture.test='+secure.url),headers:{authorization:'secret'},signal:timeout()});
  assert.equal(await text(result.response),'plain');assert.equal(received[0].authorization,undefined);
  for(const target of ['http://private.test/','http://other.test:8080/']){
    const f=await fixture(t,(_req,res)=>{res.writeHead(302,{location:target});res.end();});
    await assert.rejects(request('http://fixture.test/',{egressProxy:f.url,signal:timeout(),
      resolver:async h=>h==='private.test'?[{address:'127.0.0.1',family:4}]:resolver()}),
      {code:target.includes('private')?'NETWORK_POLICY':'URL_POLICY'});
    assert.equal(f.seen.length,1);
  }
});

test('explicit domain overrides do not disable default for other HTTP or CONNECT hosts',async t=>{
  const fallback=await fixture(t,(_req,res)=>res.end('default'));
  const override=await fixture(t,(_req,res)=>res.end('override'));
  envProxy(t,fallback.url);
  const routes=parseRoutes('special.test='+override.url);
  for(const [host,expected] of [['special.test','override'],['ordinary.test','default']]){
    assert.equal(await text(await publicRequest('http://'+host,{routes,resolver,signal:timeout()})),expected);
  }
  const proxy=await startProxy({routes,resolver,maxBytes:10000});t.after(()=>proxy.close());
  assert.equal(await text(await browserHTTP(proxy,'http://ordinary.test/')),'default');
  for(const host of ['ordinary.test','special.test']){
    const {client,reply}=await connectBrowser(t,proxy,host+':443');
    assert.match(reply,/200 Connection Established/);client.destroy();
  }
  assert.deepEqual(fallback.seen,['93.184.216.34:80','93.184.216.34:80','93.184.216.34:443']);
  assert.deepEqual(override.seen,['93.184.216.34:80','93.184.216.34:443']);
});

test('browser plain HTTP forwards through default and strips proxy-only headers; write policy is unchanged',async t=>{
  let received;
  const f=await fixture(t,(req,res)=>{received=req.headers;res.end('browser');});
  const proxy=await startProxy({egressProxy:f.url,resolver,maxBytes:10000});t.after(()=>proxy.close());
  assert.equal(await text(await browserHTTP(proxy,'http://fixture.test/',{headers:{
    'proxy-authorization':'do-not-forward','proxy-connection':'keep-alive'}})),'browser');
  assert.equal(received['proxy-authorization'],undefined);assert.equal(received['proxy-connection'],undefined);
  assert.equal(received.host,'fixture.test');
  const denied=await browserHTTP(proxy,'http://fixture.test/',{method:'POST'});
  assert.equal(denied.statusCode,403);denied.resume();assert.equal(f.seen.length,1);
});

test('private/mixed DNS and forbidden ports fail before upstream; desktop anyPort retains public-only rule',async t=>{
  const f=await fixture(t,(_req,res)=>res.end('ok'));
  for(const rows of [[{address:'127.0.0.1',family:4}],[{address:'93.184.216.34',family:4},{address:'::1',family:6}]]){
    await assert.rejects(publicRequest('http://fixture.test',{resolver:async()=>rows,egressProxy:f.url}),{code:'NETWORK_POLICY'});
  }
  await assert.rejects(publicRequest('http://fixture.test:2222',{resolver,egressProxy:f.url}),{code:'URL_POLICY'});
  assert.equal(f.seen.length,0);
  const proxy=await startProxy({anyPort:true,resolver,egressProxy:f.url});t.after(()=>proxy.close());
  const {client,reply}=await connectBrowser(t,proxy,'fixture.test:2222');assert.match(reply,/200/);client.destroy();
  assert.deepEqual(f.seen,['93.184.216.34:2222']);
  const limited=await startProxy({resolver,egressProxy:f.url});t.after(()=>limited.close());
  assert.match((await connectBrowser(t,limited,'fixture.test:2222')).reply,/403/);
});

test('denied or malformed upstream never invokes a direct HTTP request',async t=>{
  const original=http.request.bind(http);
  let directCalls=0;t.mock.method(http,'request',(...args)=>{directCalls++;return original(...args);});
  for(const reply of ['HTTP/1.1 401 Unauthorized\r\n\r\n','HTTP/1.1 403 Forbidden\r\n\r\n','HTTP/1.1 407 Proxy Authentication Required\r\n\r\n','HTTP/1.1 2000 Not success\r\n\r\n','x'.repeat(17000)]){
    const proxy=net.createServer(s=>s.once('data',()=>s.end(reply)));const port=await listen(t,proxy);
    await assert.rejects(publicRequest('http://fixture.test',{resolver,egressProxy:'http://127.0.0.1:'+port,signal:timeout()}),
      e=>['ROUTE_REFUSED','ROUTE_PROTOCOL'].includes(e.code));
  }
  assert.equal(directCalls,0);
});

test('pending CONNECT honors cancellation and total handshake timeout and closes sockets',async t=>{
  for(const abort of [true,false])await t.test(String(abort),async t=>{
    let incoming;const server=net.createServer(s=>{incoming=s;s.resume();});
    const port=await listen(t,server),controller=new AbortController();
    const connected=once(server,'connection',{signal:timeout()});
    const result=connectVia({host:'127.0.0.1',port},'93.184.216.34',443,{signal:controller.signal,timeout:100});
    const rejected=assert.rejects(result,{code:abort?'CANCELLED':'ROUTE_TIMEOUT'});
    await connected;
    const closed=once(incoming,'close',{signal:timeout()});
    if(abort)controller.abort(Object.assign(new Error('cancel'),{code:'CANCELLED'}));
    await rejected;await closed;assert.equal(incoming.destroyed,true);
  });
});

test('closing browser proxy aborts pending CONNECT instead of leaving an upstream behind',async t=>{
  const server=net.createServer(s=>s.resume());const port=await listen(t,server);
  const proxy=await startProxy({resolver,egressProxy:'http://127.0.0.1:'+port});t.after(()=>proxy.close());
  const incoming=once(server,'connection',{signal:timeout()});
  const client=loopbackConnect({host:'127.0.0.1',port:Number(new URL(proxy.url).port)});t.after(()=>client.destroy());
  await once(client,'connect',{signal:timeout()});
  client.write('CONNECT fixture.test:443 HTTP/1.1\r\nHost: fixture.test:443\r\n\r\n');
  const [socket]=await incoming,closed=once(socket,'close',{signal:timeout()});
  proxy.close();await closed;assert.equal(socket.destroyed,true);
});

test('browser tunnel byte budget is still enforced through default upstream',async t=>{
  const upstream=net.createServer(socket=>socket.once('data',()=>socket.write('HTTP/1.1 200 OK\r\n\r\n')));
  const port=await listen(t,upstream);
  const proxy=await startProxy({resolver,egressProxy:'http://127.0.0.1:'+port,maxBytes:3});t.after(()=>proxy.close());
  const incoming=once(upstream,'connection',{signal:timeout()});
  const {client}=await connectBrowser(t,proxy,'fixture.test:443');
  const [socket]=await incoming,closed=once(client,'close',{signal:timeout()});
  socket.write('1234');await closed;assert.equal(proxy.bytes(),4);
});

test('invalid configured default fails closed even with an explicit route',async t=>{
  envProxy(t,'not a proxy');
  const routes=parseRoutes('fixture.test=http://127.0.0.1:1056');
  await assert.rejects(publicRequest('http://fixture.test',{routes,resolver}),{code:'EGRESS_CONFIG'});
  await assert.rejects(startProxy({routes,resolver}),{code:'EGRESS_CONFIG'});
});

test('unset default retains direct pinned transport',async t=>{
  let options;
  t.mock.method(http,'request',(_url,opts,done)=>{
    options=opts;
    const req=new net.Socket();
    req.setTimeout=()=>req;req.end=()=>{queueMicrotask(()=>{const res=new net.Socket();done(res);});return req;};
    return req;
  });
  await publicRequest('http://fixture.test',{resolver,egressProxy:''});
  assert.equal(options.agent,undefined);
  await new Promise((resolve,reject)=>options.lookup('fixture.test',{all:true},(error,rows)=>{
    if(error)return reject(error);assert.deepEqual(rows,[{address:'93.184.216.34',family:4}]);resolve();
  }));
});

test('solver uses shared default TLS POST without redirects/retries and masks transport errors',async t=>{
  const calls=[];
  const f=await fixture(t,async(req,res)=>{
    calls.push({method:req.method,url:req.url,body:await text(req)});
    res.setHeader('content-type','application/json');res.end('{"status":1,"request":"123"}');
  },{secure:true});
  envProxy(t,f.url);
  t.mock.method(dns,'lookup',resolver);syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  assert.deepEqual(await solverTransport('/in.php',{key:'fixture-only',method:'test'},timeout()),{status:1,request:'123'});
  assert.equal(calls.length,1);assert.equal(calls[0].method,'POST');assert.equal(calls[0].url,'/in.php');
  assert.match(calls[0].body,/key=fixture-only/);assert.match(calls[0].body,/json=1/);
  assert.deepEqual(f.sni,['api.solvecaptcha.com']);assert.deepEqual(f.seen,['93.184.216.34:443']);
  f.server.removeAllListeners('request');f.server.on('request',(_req,res)=>{res.writeHead(302,{location:'https://fixture.test/'});res.end();});
  await assert.rejects(solverTransport('/res.php',{key:'fixture-only'},timeout()),{code:'SOLVER_HTTP_ERROR'});
  assert.equal(f.seen.length,2);
  process.env.PATRONUS_EGRESS_PROXY='invalid secret';
  await assert.rejects(solverTransport('/in.php',{key:'fixture-only'},timeout()),{code:'SOLVER_NETWORK_ERROR',message:'SOLVER_NETWORK_ERROR'});
  assert.equal(f.seen.length,2);
});

test('raw-IP HTTPS verifies the IP certificate identity without DNS SNI',async t=>{
  const f=await fixture(t,(_req,res)=>res.end('ip'),{secure:true});
  assert.equal(await text(await publicRequest('https://93.184.216.34/',{resolver,egressProxy:f.url,signal:timeout()})),'ip');
  assert.equal(f.sni[0],false);
  await assert.rejects(publicRequest('https://93.184.216.35/',{resolver,egressProxy:f.url,signal:timeout()}),{code:'ERR_TLS_CERT_ALTNAME_INVALID'});
});

test('one-shot HTTPS Agent releases its tunnel when a complete response is consumed',async t=>{
  const f=await fixture(t,(_req,res)=>res.end('complete'),{secure:true});
  const incoming=once(f.server,'connection',{signal:timeout()});
  const result=publicRequest('https://fixture.test/',{resolver,egressProxy:f.url,signal:timeout()});
  const [socket]=await incoming,closed=once(socket,'close',{signal:timeout()});
  assert.equal(await text(await result),'complete');
  await closed;assert.equal(socket.destroyed,true);
});

test('HTTP byte budget aborts the response and upstream without uncaught errors',async t=>{
  const f=await fixture(t,(_req,res)=>{res.writeHead(200);res.write('12345');});
  const proxy=await startProxy({resolver,egressProxy:f.url,maxBytes:3});t.after(()=>proxy.close());
  const incoming=once(f.server,'connection',{signal:timeout()});
  const fetch=browserHTTP(proxy,'http://fixture.test/').then(text);
  const rejected=assert.rejects(fetch,e=>['ECONNRESET','ABORT_ERR'].includes(e.code));
  const [socket]=await incoming,closed=once(socket,'close',{signal:timeout()});
  await rejected;await closed;assert.equal(proxy.bytes(),5);assert.equal(socket.destroyed,true);
});

test('a browser disconnect during pending CONNECT cancels the upstream',async t=>{
  const server=net.createServer(s=>s.resume()),port=await listen(t,server);
  const proxy=await startProxy({resolver,egressProxy:'http://127.0.0.1:'+port});t.after(()=>proxy.close());
  const incoming=once(server,'connection',{signal:timeout()});
  const client=loopbackConnect({host:'127.0.0.1',port:Number(new URL(proxy.url).port)});
  t.after(()=>client.destroy());await once(client,'connect',{signal:timeout()});
  client.write('CONNECT fixture.test:443 HTTP/1.1\r\nHost: fixture.test:443\r\n\r\n');
  const [socket]=await incoming,closed=once(socket,'close',{signal:timeout()});
  client.destroy();await closed;assert.equal(socket.destroyed,true);
});

test('an upstream that closes during CONNECT is classified as unavailable',async t=>{
  const server=net.createServer(s=>s.once('data',()=>s.end())),port=await listen(t,server);
  await assert.rejects(connectVia({host:'127.0.0.1',port},'93.184.216.34',443,{signal:timeout()}),{code:'ROUTE_UNAVAILABLE'});
});

test('public request timeout remains active after CONNECT succeeds',async t=>{
  const f=await fixture(t,()=>{});
  await assert.rejects(publicRequest('http://fixture.test/',{resolver,egressProxy:f.url,timeout:50,signal:timeout()}),{code:'TIMEOUT'});
});

test('eager browser tunnel bytes survive pending CONNECT negotiation',async t=>{
  const seen=[];
  let negotiate;
  const server=net.createServer(s=>s.once('data',()=>{
    negotiate=()=>{s.write('HTTP/1.1 200 OK\r\n\r\n');s.on('data',data=>{seen.push(data);s.write(data);});};
  }));
  const port=await listen(t,server);
  const proxy=await startProxy({resolver,egressProxy:'http://127.0.0.1:'+port});t.after(()=>proxy.close());
  const client=loopbackConnect({host:'127.0.0.1',port:Number(new URL(proxy.url).port)});
  t.after(()=>client.destroy());await once(client,'connect',{signal:timeout()});
  let output='';
  client.on('data',data=>{output+=data;});
  client.write('CONNECT fixture.test:443 HTTP/1.1\r\nHost: fixture.test:443\r\n\r\ninitial');
  while(!negotiate)await new Promise(r=>setTimeout(r,1));
  client.write('later');
  await new Promise(r=>setTimeout(r,10));negotiate();
  const deadline=Date.now()+2000;
  while(!output.endsWith('initiallater')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
  assert.equal(Buffer.concat(seen).toString(),'initiallater');
  assert.match(output,/200 OK|200 Connection Established/);
  assert.ok(output.endsWith('initiallater'));
});

test('excessive eager browser bytes close pending CONNECT',async t=>{
  const server=net.createServer(s=>s.resume()),port=await listen(t,server);
  const proxy=await startProxy({resolver,egressProxy:'http://127.0.0.1:'+port});t.after(()=>proxy.close());
  const incoming=once(server,'connection',{signal:timeout()});
  const client=loopbackConnect({host:'127.0.0.1',port:Number(new URL(proxy.url).port)});
  client.on('error',()=>{});t.after(()=>client.destroy());await once(client,'connect',{signal:timeout()});
  client.write('CONNECT fixture.test:443 HTTP/1.1\r\nHost: fixture.test:443\r\n\r\n');
  const [socket]=await incoming,closed=once(socket,'close',{signal:timeout()});
  client.write(Buffer.alloc(65537));await closed;assert.equal(socket.destroyed,true);
});

test('solver response limit and cancellation remain enforced on the default route',async t=>{
  const f=await fixture(t,(_req,res)=>res.end('x'.repeat(65537)),{secure:true});
  envProxy(t,f.url);t.mock.method(dns,'lookup',resolver);syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  await assert.rejects(solverTransport('/res.php',{key:'fixture-only'},timeout()),{code:'SOLVER_RESPONSE_LIMIT'});
  f.server.removeAllListeners('request');f.server.on('request',()=>{});
  const controller=new AbortController();
  const started=once(f.server,'request',{signal:timeout()});
  const result=solverTransport('/res.php',{key:'fixture-only'},controller.signal);
  const rejected=assert.rejects(result,{code:'CANCELLED'});
  await started;controller.abort(Object.assign(new Error('cancel'),{code:'CANCELLED'}));await rejected;
});

test('established browser CONNECT half-close still receives the upstream response',async t=>{
  const server=net.createServer({allowHalfOpen:true},socket=>{
    socket.once('data',()=>{
      socket.write('HTTP/1.1 200 OK\r\n\r\n');
      let received='';
      socket.on('data',chunk=>{received+=chunk;});
      socket.on('end',()=>socket.end('reply:'+received));
    });
  });
  const port=await listen(t,server);
  const proxy=await startProxy({resolver,egressProxy:'http://127.0.0.1:'+port});t.after(()=>proxy.close());
  const {client}=await connectBrowser(t,proxy,'fixture.test:443');
  const response=once(client,'data',{signal:timeout()});
  client.end('request');
  assert.equal((await response)[0].toString(),'reply:request');
});

function directFixture(t,module=http,{body='alpha',status=200,failAfterDispatch=false}={}) {
  const original=module.request.bind(module),calls=[];
  t.mock.method(module,'request',(url,options,callback)=>{
    if(options.agent)return original(url,options,callback);
    const req=new EventEmitter();
    req.setTimeout=()=>req;
    req.destroy=error=>{queueMicrotask(()=>req.emit('error',error||new Error('closed')));return req;};
    req.end=payload=>{
      req.socket=new EventEmitter();Object.assign(req.socket,{encrypted:false,connecting:false,bytesWritten:0});
      req.emit('socket',req.socket);req.socket.bytesWritten=1;req.emit('finish');
      calls.push({url:String(url),options,payload});
      queueMicrotask(()=>{
        if(failAfterDispatch){req.emit('error',Object.assign(new Error('uncertain origin result'),{code:'ECONNRESET'}));return;}
        const response=Readable.from([Buffer.from(body)]);response.statusCode=status;response.headers={};callback(response);
      });
      return req;
    };
    return req;
  });
  return calls;
}
async function unavailableProxy(t,status=503) {
  const server=net.createServer(socket=>socket.once('data',()=>{
    if(status==='timeout')return;
    if(status==='close'){socket.end();return;}
    socket.end('HTTP/1.1 '+status+' Service Unavailable\r\nContent-Length: 0\r\n\r\n');
  }));
  const port=await listen(t,server);
  return {server,port,url:'http://127.0.0.1:'+port};
}

test('offline-like CONNECT 502/503/504, closure, timeout and listener outage fall back before a single POST',async t=>{
  for(const failure of [502,503,504,'close','timeout','refused'])await t.test(String(failure),async t=>{
    const f=await unavailableProxy(t,failure);
    if(failure==='refused')await new Promise(r=>f.server.close(r));
    const calls=directFixture(t),events=[];
    const res=await publicRequest('http://fixture.test/write',{method:'POST',body:'one-write',resolver,
      egressProxy:f.url,upstreamTimeout:30,signal:timeout(),onRoute:e=>events.push(e)});
    assert.equal(await text(res),'alpha');assert.equal(calls.length,1);
    assert.equal(calls[0].payload,'one-write');assert.equal(calls[0].options.method,'POST');
    assert.deepEqual(await new Promise((resolve,reject)=>calls[0].options.lookup('fixture.test',{all:true},(error,rows)=>error?reject(error):resolve(rows))),[{address:'93.184.216.34',family:4}]);
    assert.equal(events.length,1);assert.equal(events[0].route,'alpha');assert.equal(events[0].fallback,true);
    assert.equal(events[0].reason,failure==='timeout'?'ROUTE_TIMEOUT':
      typeof failure==='number'?'ROUTE_GATEWAY_UNAVAILABLE':'ROUTE_UNAVAILABLE');
  });
});

test('next request prefers a recovered proxy without sticky Alpha fallback; trace records selection',async t=>{
  const f=await unavailableProxy(t,503),calls=directFixture(t),trace=[];
  const first=await request('http://fixture.test/?token=secret',{resolver,egressProxy:f.url,
    signal:timeout(),trace:e=>trace.push(e),onRoute:()=>{}});
  assert.equal(await text(first.response),'alpha');assert.equal(calls.length,1);
  const target=http.createServer((_req,res)=>res.end('phone'));
  const targetPort=await listen(t,target);
  f.server.removeAllListeners('connection');
  f.server.on('connection',socket=>{
    socket.on('error',()=>{});
    socket.once('data',()=>{
      const origin=loopbackConnect({host:'127.0.0.1',port:targetPort});
      origin.on('error',()=>socket.destroy());socket.on('close',()=>origin.destroy());
      origin.once('connect',()=>{socket.write('HTTP/1.1 200 OK\r\n\r\n');socket.pipe(origin);origin.pipe(socket);});
    });
  });
  const second=await request('http://fixture.test/',{resolver,egressProxy:f.url,
    signal:timeout(),trace:e=>trace.push(e),onRoute:()=>{}});
  assert.equal(await text(second.response),'phone');assert.equal(calls.length,1);
  assert.equal(trace[0].egress.route,'alpha');assert.equal(trace[0].egress.fallback,true);
  assert.equal(trace[1].egress.route,'upstream');assert.equal(trace[1].egress.fallback,false);
  assert.ok(!JSON.stringify(trace).includes('secret'));
});

test('upstream origin POST failure is never replayed on Alpha even when outcome is uncertain',async t=>{
  const received=[];
  const f=await fixture(t,async(req)=>{received.push(await text(req));req.socket.destroy();});
  const direct=directFixture(t),events=[];
  await assert.rejects(publicRequest('http://fixture.test/write',{method:'POST',body:'submitted-once',
    resolver,egressProxy:f.url,onRoute:e=>events.push(e),signal:timeout()}),{code:'REQUEST_OUTCOME_UNCERTAIN',outcomeUncertain:true});
  assert.deepEqual(received,['submitted-once']);assert.equal(direct.length,0);
  assert.deepEqual(events.map(e=>e.route),['upstream']);
});

test('failed fallback POST is not attempted a second time',async t=>{
  const f=await unavailableProxy(t,503),direct=directFixture(t,http,{failAfterDispatch:true});
  await assert.rejects(publicRequest('http://fixture.test/write',{method:'POST',body:'one-write',
    resolver,egressProxy:f.url,onRoute:()=>{},signal:timeout()}),{code:'REQUEST_OUTCOME_UNCERTAIN',outcomeUncertain:true});
  assert.equal(direct.length,1);
});

test('origin 401/403/502/503 responses remain origin responses and do not trigger alternate routing',async t=>{
  for(const status of [401,403,502,503])await t.test(String(status),async t=>{
    const f=await fixture(t,(_req,res)=>{res.writeHead(status);res.end('origin response');});
    const direct=directFixture(t),events=[];
    const res=await publicRequest('http://fixture.test/',{resolver,egressProxy:f.url,onRoute:e=>events.push(e),signal:timeout()});
    assert.equal(res.statusCode,status);assert.equal(await text(res),'origin response');
    assert.equal(direct.length,0);assert.deepEqual(events.map(e=>e.route),['upstream']);
  });
});

test('cancellation cannot become an availability fallback, including a cancellation reason named like an outage',async t=>{
  const f=await unavailableProxy(t,'timeout'),direct=directFixture(t),controller=new AbortController(),events=[];
  const incoming=once(f.server,'connection',{signal:timeout()});
  const result=publicRequest('http://fixture.test/write',{method:'POST',body:'never-send',resolver,
    egressProxy:f.url,signal:controller.signal,onRoute:e=>events.push(e)});
  const rejected=assert.rejects(result,{code:'ROUTE_TIMEOUT'});
  await incoming;controller.abort(Object.assign(new Error('cancelled'),{code:'ROUTE_TIMEOUT'}));
  await rejected;assert.equal(direct.length,0);assert.equal(events.length,0);
});

test('SSRF and certificate failures remain terminal, with no direct fallback',async t=>{
  const direct=directFixture(t,https),f=await fixture(t,(_req,res)=>res.end('no'),{secure:true});
  await assert.rejects(publicRequest('https://private.test/',{resolver:async()=>[{address:'127.0.0.1',family:4}],egressProxy:f.url}),{code:'NETWORK_POLICY'});
  await assert.rejects(publicRequest('https://wrong.test/',{resolver,egressProxy:f.url,signal:timeout()}),{code:'ERR_TLS_CERT_ALTNAME_INVALID'});
  assert.equal(direct.length,0);assert.equal(f.seen.length,1);
});

test('solver uses one direct POST after pre-dispatch availability fallback, never after origin dispatch',async t=>{
  const f=await unavailableProxy(t,503),calls=directFixture(t,https,{body:'{"status":1,"request":"42"}'});
  envProxy(t,f.url);t.mock.method(dns,'lookup',resolver);syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  assert.deepEqual(await solverTransport('/in.php',{key:'fixture-only'},timeout()),{status:1,request:'42'});
  assert.equal(calls.length,1);assert.equal(calls[0].options.method,'POST');
  assert.equal(new URL(calls[0].url).pathname,'/in.php');assert.match(calls[0].payload,/key=fixture-only/);
});

test('browser CONNECT falls back before 200 and never reconnects after establishment',async t=>{
  const f=await unavailableProxy(t,503),events=[],direct=[];
  const target=net.createServer(socket=>socket.on('data',chunk=>socket.write(chunk)));
  const targetPort=await listen(t,target),targetSocket=once(target,'connection',{signal:timeout()});
  t.mock.method(net,'connect',options=>{
    if(options.host==='93.184.216.34'){
      direct.push({...options});return loopbackConnect({host:'127.0.0.1',port:targetPort});
    }
    return loopbackConnect(options);
  });
  const proxy=await startProxy({resolver,egressProxy:f.url,onRoute:e=>events.push(e)});t.after(()=>proxy.close());
  const {client,reply}=await connectBrowser(t,proxy,'fixture.test:443');
  assert.match(reply,/200 Connection Established/);
  const echoed=once(client,'data',{signal:timeout()});client.write('one');
  assert.equal((await echoed)[0].toString(),'one');assert.deepEqual(direct,[{host:'93.184.216.34',port:443}]);
  assert.deepEqual(events,[{transport:'browser-connect',route:'alpha',fallback:true,reason:'ROUTE_GATEWAY_UNAVAILABLE'}]);
  const [upstream]=await targetSocket,closed=once(client,'close',{signal:timeout()});upstream.destroy();await closed;
  assert.equal(direct.length,1);
});

test('browser CONNECT denial never attempts direct; explicit route outage may fall back',async t=>{
  let direct=0;
  t.mock.method(net,'connect',options=>{
    if(options.host==='93.184.216.34'){direct++;throw new Error('unexpected direct');}
    return loopbackConnect(options);
  });
  const denied=await unavailableProxy(t,407);
  const proxy=await startProxy({resolver,egressProxy:denied.url,onRoute:()=>{}});t.after(()=>proxy.close());
  assert.match((await connectBrowser(t,proxy,'fixture.test:443')).reply,/403/);assert.equal(direct,0);
  const unavailable=await unavailableProxy(t,503),calls=directFixture(t);
  assert.equal(await text(await publicRequest('http://fixture.test',{resolver,
    routes:parseRoutes('fixture.test='+unavailable.url),egressProxy:denied.url,onRoute:()=>{},signal:timeout()})),'alpha');
  assert.equal(calls.length,1);
});

test('browser HTTP fallback uses the public pinned target and reports only safe diagnostic fields',async t=>{
  const f=await unavailableProxy(t,503),received=[],events=[];
  const target=http.createServer((req,res)=>{received.push(req.url);res.end('alpha-http');});
  const targetPort=await listen(t,target),create=http.Agent.prototype.createConnection;
  t.mock.method(http.Agent.prototype,'createConnection',function(options,callback){
    if(options.host==='fixture.test'){
      options.lookup('fixture.test',{all:true},(_error,rows)=>assert.deepEqual(rows,[{address:'93.184.216.34',family:4}]));
      return loopbackConnect({host:'127.0.0.1',port:targetPort});
    }
    return create.call(this,options,callback);
  });
  const proxy=await startProxy({resolver,egressProxy:f.url,onRoute:e=>events.push(e)});t.after(()=>proxy.close());
  assert.equal(await text(await browserHTTP(proxy,'http://fixture.test/private?token=secret')),'alpha-http');
  assert.equal(received.length,1);
  assert.deepEqual(events,[{transport:'browser-http',route:'alpha',fallback:true,reason:'ROUTE_GATEWAY_UNAVAILABLE'}]);
  assert.ok(!JSON.stringify(events).includes('secret'));assert.ok(!JSON.stringify(events).includes('fixture'));
});

test('default route log exposes fallback reason without URL, origin, payload or credentials',async t=>{
  const f=await unavailableProxy(t,503),calls=directFixture(t),logs=[];
  t.mock.method(console,'warn',value=>logs.push(value));
  await text(await publicRequest('http://fixture.test/?key=secret',{resolver,egressProxy:f.url,method:'POST',body:'private-body',signal:timeout()}));
  assert.equal(calls.length,1);
  assert.deepEqual(JSON.parse(logs[0]),{event:'patronus_egress',transport:'request',route:'alpha',fallback:true,reason:'ROUTE_GATEWAY_UNAVAILABLE'});
  assert.equal(logs.length,1);
});

test('POST TLS failure is not mislabeled uncertain and never falls back',async t=>{
  const f=await fixture(t,(_req,res)=>res.end('no'),{secure:true}),direct=directFixture(t,https);
  await assert.rejects(publicRequest('https://wrong.test/write',{method:'POST',body:'never-origin',
    resolver,egressProxy:f.url,signal:timeout()}),error=>{
      assert.equal(error.code,'ERR_TLS_CERT_ALTNAME_INVALID');assert.notEqual(error.outcomeUncertain,true);return true;
    });
  assert.equal(direct.length,0);
});

test('truncated write response has an explicit uncertain outcome and no replay',async t=>{
  const f=await fixture(t,async(req,res)=>{
    await text(req);res.writeHead(200,{'content-length':100});res.write('partial');
    setTimeout(()=>res.destroy(),10);
  }),direct=directFixture(t);
  const res=await publicRequest('http://fixture.test/write',{method:'PATCH',body:'one-write',
    resolver,egressProxy:f.url,signal:timeout()});
  await assert.rejects(text(res),{code:'REQUEST_OUTCOME_UNCERTAIN',outcomeUncertain:true});
  assert.equal(direct.length,0);
});

test('cancellation after write dispatch retains cancellation identity without resending',async t=>{
  const controller=new AbortController(),reason=Object.assign(new Error('cancelled'),{code:'CANCELLED'});
  const f=await fixture(t,async req=>{await text(req);controller.abort(reason);}),direct=directFixture(t);
  await assert.rejects(publicRequest('http://fixture.test/write',{method:'POST',body:'one-write',
    resolver,egressProxy:f.url,signal:controller.signal}),error=>error===reason);
  assert.equal(direct.length,0);
});

test('solver reports masked uncertain submission and never retries the accepted POST',async t=>{
  const received=[],f=await fixture(t,async req=>{received.push(await text(req));req.socket.destroy();},{secure:true});
  const direct=directFixture(t,https);envProxy(t,f.url);
  t.mock.method(dns,'lookup',resolver);syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  await assert.rejects(solverTransport('/in.php',{key:'secret-fixture-value'},timeout()),error=>{
    assert.equal(error.code,'SOLVER_OUTCOME_UNCERTAIN');assert.ok(!error.message.includes('secret-fixture-value'));return true;
  });
  assert.equal(received.length,1);assert.equal(direct.length,0);
});

test('partial CONNECT responses are protocol failures on close or timeout, never availability fallback',async t=>{
  for(const ending of ['close','timeout'])for(const response of ['HTTP/1.1 403 Forbidden\r\n','malformed'])
    await t.test(ending+' '+response.slice(0,12),async t=>{
      const server=net.createServer(socket=>socket.once('data',()=>{
        socket.write(response);if(ending==='close')socket.end();
      }));
      const port=await listen(t,server),direct=directFixture(t),events=[];
      await assert.rejects(publicRequest('http://fixture.test/write',{method:'POST',body:'never-send',
        resolver,egressProxy:'http://127.0.0.1:'+port,signal:timeout(),upstreamTimeout:40,
        onRoute:event=>events.push(event)}),{code:'ROUTE_PROTOCOL'});
      assert.equal(direct.length,0);assert.deepEqual(events,[]);
    });
});

test('reader request remains GET-only when forwarding transport options across redirects',async t=>{
  const seen=[],f=await fixture(t,async(req,res)=>{
    seen.push({method:req.method,body:await text(req)});
    if(req.url==='/first'){res.writeHead(302,{location:'/second'});res.end();}else res.end('read');
  });
  const result=await request('http://fixture.test/first',{method:'POST',body:'must-not-be-submitted',
    resolver,egressProxy:f.url,signal:timeout()});
  assert.equal(await text(result.response),'read');
  assert.deepEqual(seen,[{method:'GET',body:''},{method:'GET',body:''}]);
});
