import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {challengePage} from '../src/patronus/challenge-page.js';
import {Patronus} from '../src/patronus/engine.js';
import {patronusTools} from '../src/patronus/schema.js';
const doc=body=>body.startsWith('<title>')?'<html><head>'+body+'</head><body></body></html>':'<html><head><title></title></head><body>'+body+'</body></html>';
const cases=[
 ['Vimeo','<h1>Verify to continue</h1><p>To continue, please confirm that you are a human (and not a spambot).</p><h2>Checking if the site connection is secure</h2>'],
 ['Cloudflare','<title>Just a moment...</title>'],
 ['human prompt','<h1>Verify you are human</h1>'],
 ['hCaptcha','<iframe src="https://newassets.hcaptcha.com/captcha/v1/test/hcaptcha.html"></iframe>'],
 ['reCAPTCHA','<iframe src="https://www.google.com/recaptcha/api2/bframe?k=private-token"></iframe>'],
 ['enterprise reCAPTCHA','<iframe src="https://www.recaptcha.net/recaptcha/enterprise/bframe"></iframe>'],
 ['Akamai','<div id="sec-cpt-container">Complete the security check</div>'],
 ['PerimeterX','<div id="px-captcha">Press &amp; hold to confirm that you are a human</div>'],
 ['DataDome','<iframe src="https://geo.captcha-delivery.com/captcha/"></iframe>'],
 ['Cloudflare frame','<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/widget"></iframe>'],
 ['plain prompt','Please verify that you are human to continue.']
];
for(const [name,html]of cases)test('classifies '+name,()=>assert.ok(challengePage(doc(html),'https://example.com')));
for(const [name,html]of [
 ['article','<h1>Browser verification explained</h1><article>'+('An article about CAPTCHA systems. '.repeat(100))+'Verify you are human is a common prompt.</article>'],
 ['article with challenge heading','<h1>Browser verification explained</h1><h2>Verify you are human</h2><article>'+('Useful documentation about browser systems. '.repeat(100))+'</article>'],
 ['hcaptcha form','<h1>Join our event</h1><form><input name="email"></form><iframe src="https://newassets.hcaptcha.com/captcha/widget"></iframe>'],
 ['ordinary form','<h1>Join our event</h1><form><input name="email"></form><iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>'],
 ['invisible vendor scripts','<h1>Welcome</h1><script src="https://js.datadome.co/tags.js"></script><script>Verify you are human</script>'],
 ['content plus hcaptcha','<h1>Documentation</h1><article>'+('Useful documentation. '.repeat(100))+'</article><iframe src="https://newassets.hcaptcha.com/captcha/widget"></iframe>']
])test('preserves '+name,()=>assert.equal(challengePage(doc(html),'https://example.com'),null));
test('a challenge is an obstacle, not a captured page; reason stays credential-free',async()=>{
 const root=mkdtempSync(join(tmpdir(),'patronus-challenge-test-')),page=new EventEmitter();
 Object.assign(page,{url:()=> 'https://example.com/?token=secret',goto:async()=>null,
 evaluate:async()=>{},waitForTimeout:ms=>new Promise(r=>setTimeout(r,ms)),frames:()=>[],
 content:async()=>doc(cases[0][1]),locator:()=>({count:async()=>0,innerText:async()=> 'Verify to continue'}),
 screenshot:async()=>Buffer.from('fixture')});
 const context={pages:()=>[page],route:async()=>{},routeWebSocket:async()=>{},close:async()=>{}};
 const engine=new Patronus(root,{launch:async()=>context});
 try{
  const args=patronusTools.patronus_start.schema.parse({urls:['https://example.com'],rendering:'browser',solveCaptchas:false,idempotencyKey:'challenge-fixture'});
  assert.equal(args.maxBytes,2147483648);
  const job=engine.start(args);await engine.tick();const s=engine.status({jobId:job.jobId});
  assert.equal(s.state,'failed');assert.equal(s.pages.length,0);assert.equal(s.outcome.capturedPages,0);
  assert.equal(s.obstacles[0].code,'CHALLENGE_PAGE');assert.equal(s.obstacles[0].reason,'VERIFICATION_INTERSTITIAL');
  assert.doesNotMatch(JSON.stringify(s),/token=secret/);
 }finally{await engine.close();rmSync(root,{recursive:true,force:true});}
});
