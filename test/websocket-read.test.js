import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Patronus} from '../src/patronus/engine.js';
import {defaultLaunch} from '../src/patronus/launch.js';
import {patronusTools} from '../src/patronus/schema.js';

test('read-mode page WebSocket connects through proxy, counts received bytes, and form navigation stays blocked',
 {skip:!existsSync('/opt/google/chrome/chrome'),timeout:30000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'patronus-ws-test-'));
 const server=http.createServer((_q,r)=>{r.writeHead(500);r.end();});
 let connections=0,formRequests=0;
 server.on('request',q=>{if(q.method==='POST')formRequests++;});
 const sockets=new Set();
 server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 server.on('upgrade',(q,s)=>{
  connections++;
  const accept=createHash('sha1').update(q.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  // An open, idle socket must not prevent document readiness. Frames are not logged.
  const payload=Buffer.alloc(65536,120),header=Buffer.alloc(10);header[0]=0x82;header[1]=127;header.writeBigUInt64BE(BigInt(payload.length),2);
  s.write(Buffer.concat([header,payload]));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const realConnect=net.connect;
 // Keep production public-DNS/port validation, substituting only the upstream
 // socket in this isolated fixture. No production private-address bypass.
 t.mock.method(net,'connect',function(options,...args){
  if(typeof options==='object'&&Number(options.port)===80)
   return realConnect.call(net,{...options,host:'127.0.0.1',port:server.address().port},...args);
  return realConnect.call(net,options,...args);
 });
 let globals;
 const engine=new Patronus(root,{launch:async options=>{
  const context=await defaultLaunch({...options,config:{...options.config,chromiumSandbox:process.getuid?.()!==0}});
  const page=context.pages()[0];
  await page.route('http://example.com/fixture',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><title>Socket fixture</title><body><p id="result">waiting</p><iframe name="target"></iframe><form method="post" action="http://example.com/submit?token=secret" target="target"><input name="fixture" value="test"></form><script>
const socket=new WebSocket('ws://example.com/socket?token=secret');
socket.onmessage=()=>{document.querySelector('#result').textContent='socket connected';document.querySelector('form').submit();};
</script></body>`}));
  page.on('websocket',ws=>ws.on('framereceived',async()=>{globals=await page.evaluate(()=>Object.getOwnPropertyNames(window).filter(k=>/^__playwright|^__pwWebSocket/.test(k)));}));
  // Reintroduction of either binding API fails this test immediately.
  context.routeWebSocket=()=>{throw Error('WebSocket routing must not be installed');};
  return context;
 }});
 try{
  const args=patronusTools.patronus_start.schema.parse({urls:['http://example.com/fixture'],rendering:'browser',solveCaptchas:false,browserWaitSeconds:8,idempotencyKey:'websocket-read-fixture'});
  assert.equal(args.maxBytes,2147483648);
  const job=engine.start(args);await engine.tick();
  const s=engine.status({jobId:job.jobId}),out=JSON.parse(engine.result({jobId:job.jobId}).content)[0];
  assert.equal(connections,1);assert.equal(formRequests,0);assert.match(out.markdown,/socket connected/);
  assert.ok(s.bytes>=65536,'received WebSocket data uses the existing byte budget');
  assert.ok([...s.obstacles,...s.warnings].some(o=>o.reason==='FORM_SUBMISSION_POLICY'));
  assert.equal(out.coverage.readiness.outcome,'settled');assert.deepEqual(globals,[]);
  assert.doesNotMatch(JSON.stringify(s),/token=secret|x{100}/);
 }finally{await engine.close();for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true});}
});
test('neither read nor login installs page-visible WebSocket bindings',()=>{
 for(const path of ['engine.js','login.js'])
  assert.doesNotMatch(readFileSync(new URL('../src/patronus/'+path,import.meta.url),'utf8'),/\.routeWebSocket\s*\(/);
});
