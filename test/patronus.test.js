import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPublic,resolvePublic,safeURL,displayURL } from '../src/patronus/network.js';
import { extract } from '../src/patronus/extract.js';
import { Patronus } from '../src/patronus/engine.js';
import { patronusTools } from '../src/patronus/schema.js';
test('Patronus rejects internal addresses and mixed DNS answers',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','::1','::ffff:127.0.0.1','fc00::1','0.0.0.0','192.168.2.3'])assert.equal(isPublic(ip),false,ip);
 assert.equal(isPublic('1.1.1.1'),true);
 await assert.rejects(resolvePublic('https://test.example',async()=>[{address:'1.1.1.1',family:4},{address:'127.0.0.1',family:4}]),{code:'NETWORK_POLICY'});
 for(const u of ['file:///etc/passwd','http://u:p@example.com','http://example.com:22'])assert.throws(()=>safeURL(u));
 assert.equal(displayURL('https://e.com/x?token=secret#secret'),'https://e.com/x?token=%5Bredacted%5D');
});
test('Patronus unwraps search redirects and redacts only secret-looking params',()=>{
 const R='%5Bredacted%5D';
 assert.equal(displayURL('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fnitter.example%2Fxikhar&rut=0f3a9c6e1b2d4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a'),'https://nitter.example/xikhar');
 assert.equal(displayURL('https://www.google.com/url?q=https://example.com/page&sa=U'),'https://example.com/page');
 const b64=Buffer.from('https://example.com/bing-target').toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 assert.equal(displayURL('https://www.bing.com/ck/a?!&&p=abc&u=a1'+b64+'&ntb=1'),'https://example.com/bing-target');
 assert.equal(displayURL('https://duckduckgo.com/l/?uddg='+encodeURIComponent('https://e.com/x?api_key=hunter2&page=2')),'https://e.com/x?api_key='+R+'&page=2');
 assert.equal(displayURL('https://html.duckduckgo.com/html/?q=wildbrush+site%3Ax.com'),'https://html.duckduckgo.com/html/?q=wildbrush+site%3Ax.com');
 assert.equal(displayURL('https://github.com/search?q=wildbrush&type=repositories'),'https://github.com/search?q=wildbrush&type=repositories');
 assert.equal(displayURL('https://b.s3.amazonaws.com/f?X-Amz-Signature=abc&X-Amz-Credential=def&v=1'),'https://b.s3.amazonaws.com/f?X-Amz-Signature='+R+'&X-Amz-Credential='+R+'&v=1');
 assert.equal(displayURL('https://e.com/cb?code=4%2F0Adeu5B&state=xyz'),'https://e.com/cb?code='+R+'&state='+R);
 assert.equal(displayURL('https://e.com/d?dl=aGVsbG8td29ybGQtdGhpcy1pcy1vcGFxdWUtYmxvYg'),'https://e.com/d?dl='+R);
 assert.equal(displayURL('https://e.com/v?t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.sig'),'https://e.com/v?t='+R);
 assert.equal(displayURL('https://evil.example/l/?uddg=https%3A%2F%2Fother.example'),'https://evil.example/l/?uddg=https%3A%2F%2Fother.example');
 assert.equal(displayURL('https://duckduckgo.com/l/?uddg=javascript%3Aalert(1)'),'https://duckduckgo.com/l/?uddg=javascript%3Aalert%281%29');
});
test('Patronus preserves relationships and excludes executable content',()=>{
 const r=extract('<html><head><title>Sample</title></head><body><h1>Heading</h1><figure><img src="/a.png" alt="A"><figcaption>Caption</figcaption></figure><table><tr><th>A</th></tr><tr><td>B</td></tr></table><a href="/next">Next</a><script>steal()</script></body></html>','https://example.com/');
 assert.match(r.markdown,/# Heading/);assert.match(r.markdown,/patronus-image:0/);assert.equal(r.images[0].caption,'Caption');assert.equal(r.images[0].url,'https://example.com/a.png');assert.doesNotMatch(r.markdown,/steal/);assert.equal(r.links[0].url,'https://example.com/next');
});
test('Patronus idempotency cancellation and recovery never wait for a person',async()=>{
 const root=mkdtempSync(join(tmpdir(),'patronus-test-'));let e=new Patronus(root);
 try{
 const args=patronusTools.patronus_start.schema.parse({urls:['https://example.com'],idempotencyKey:'test-reader-1'});
 const a=e.start(args);assert.equal(e.start(args).jobId,a.jobId);
 assert.throws(()=>e.start({...args,maxPages:4}),{code:'IDEMPOTENCY_CONFLICT'});
 assert.equal(e.cancel({jobId:a.jobId}).state,'cancelled');
 const b=e.start({...args,idempotencyKey:'test-reader-2'});const d=e.get(b.jobId).data;d.state='running';e.save(d);
 await e.close();e=new Patronus(root);assert.equal(e.status({jobId:b.jobId}).state,'failed');assert.equal(e.status({jobId:b.jobId}).obstacles[0].code,'INTERRUPTED');
 const c=e.start({...args,urls:['http://127.0.0.1'],rendering:'http',idempotencyKey:'test-reader-3'});await e.tick();assert.equal(e.status({jobId:c.jobId}).state,'failed');assert.equal(e.status({jobId:c.jobId}).obstacles[0].code,'NETWORK_POLICY');
 }finally{await e.close();rmSync(root,{recursive:true,force:true});}
});

test('Patronus resumes unchanged files and rejects changed validators',async()=>{
 const {Readable}=await import('node:stream');
 const {readFileSync,writeFileSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'patronus-resume-'));
 let etag='"same"';
 const e=new Patronus(root,{requestFn:async(raw,{headers})=>{
  assert.equal(headers.range,'bytes=3-');assert.equal(headers['if-range'],'"same"');
  const response=Readable.from([Buffer.from('def')]);
  response.statusCode=206;response.headers={'content-type':'application/octet-stream','content-length':'3',etag,'content-range':'bytes 3-5/6'};
  return {response,url:raw};
 }});
 try{
  const args=patronusTools.patronus_start.schema.parse({urls:['https://example.com/file'],mode:'download',idempotencyKey:'resume-test-1'});
  const d=e.start(args);const original=join(root,'original');writeFileSync(original,'abc');
  const r=await e.bytes(args.urls[0],d,args,new AbortController().signal,{file:true,resume:{etag:'"same"',bytes:3,path:original}});
  assert.equal(readFileSync(join(root,'jobs',d.jobId,r.artifact.artifactId),'utf8'),'abcdef');
  assert.equal(r.artifact.bytes,6);assert.equal(r.artifact.sha256,'bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721');
  etag='"changed"';
  await assert.rejects(e.bytes(args.urls[0],d,args,new AbortController().signal,{file:true,resume:{etag:'"same"',bytes:3,path:original}}),{code:'RESUME_UNAVAILABLE'});
 }finally{await e.close();rmSync(root,{recursive:true,force:true});}
});

test('Browser denial evidence survives independently and redacts credential headers',async()=>{
 const root=mkdtempSync(join(tmpdir(),'patronus-denial-'));const e=new Patronus(root);
 try{
  const args=patronusTools.patronus_start.schema.parse({urls:['https://example.com'],idempotencyKey:'denial-evidence-test'});
  const d=e.start(args);
  const page={url:()=> 'https://example.com/?secret=hidden',content:async()=>'<html><body>Blocked</body></html>',locator:()=>({innerText:async()=> 'Blocked'}),screenshot:async()=>{throw new Error('renderer closed');}};
  const response={status:()=>403,allHeaders:async()=>({'server':'edge','set-cookie':'secret=value','x-token':'hidden','location':'/login?token=secret'})};
  const info=await e.browserFailure(page,response,d,args,'HTTP_ERROR');
  assert.equal(d.state,'queued');assert.equal(info.status,403);assert.equal(info.captureErrors[0].part,'screenshot');
  const headers=JSON.parse(Buffer.from(e.artifact({jobId:d.jobId,artifactId:info.artifacts.headers}).content,'base64').toString());
  assert.equal(headers.headers.server,'edge');assert.ok(headers.redactedHeaders.includes('set-cookie'));
  assert.doesNotMatch(JSON.stringify(headers.headers),/secret=value|hidden|token=secret/);
  assert.equal(e.status({jobId:d.jobId}).diagnostics[0].artifacts.content,info.artifacts.content);
 }finally{await e.close();rmSync(root,{recursive:true,force:true});}
});
