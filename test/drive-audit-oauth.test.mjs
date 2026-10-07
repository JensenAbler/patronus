import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import {createHandler,SCOPE,validClient} from '../scripts/drive-audit-oauth.mjs';
test('metadata OAuth validates session, scope, account and single-use callback',async()=>{
 const dir=fs.mkdtempSync(os.tmpdir()+'/drive-oauth-test-');
 const origin='https://praxis-apps.jensenabler.com';
 const redirect=origin+'/drive-audit/callback';
 assert.equal(validClient({client_id:'x.apps.googleusercontent.com',client_secret:'s',redirect_uris:[redirect]},redirect),true);
 assert.equal(validClient({client_id:'x.apps.googleusercontent.com',client_secret:'s',redirect_uris:['http://localhost']},redirect),false);
 let calls=0;
 const server=http.createServer(createHandler({dir,origin,key:'private-test-key',expectedEmail:'owner@example.com',fetcher:async(url,opts)=>{
 calls++;
 if(url.includes('/token')) {assert.equal(opts.body.get('grant_type'),'authorization_code');assert.ok(opts.body.get('code_verifier'));return {ok:true,json:async()=>({access_token:'test',refresh_token:'test-refresh',expires_in:3600,scope:SCOPE})};}
 return {ok:true,json:async()=>({user:{emailAddress:'owner@example.com'},storageQuota:{usage:'123'}})};
 }}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await fetch(base+'/drive-audit/callback?code=x&state=bad')).status,400);
  assert.equal(calls,0);
  const setup=await fetch(base+'/drive-audit/setup/private-test-key',{redirect:'manual'});
  const cookie=setup.headers.get('set-cookie').split(';')[0];
  const formResponse=await fetch(base+'/drive-audit/setup',{headers:{cookie}});
  assert.equal(formResponse.headers.get('referrer-policy'),'same-origin');
  const form=await formResponse.text();
  const csrf=/name="csrf" value="([^"]+)"/.exec(form)[1];
  const body=new URLSearchParams({csrf,client:JSON.stringify({web:{client_id:'x.apps.googleusercontent.com',client_secret:'secret',redirect_uris:[redirect]}})});
  assert.equal((await fetch(base+'/drive-audit/setup',{method:'POST',headers:{cookie,Origin:'https://evil.example'},body,redirect:'manual'})).status,403);
  const start=await fetch(base+'/drive-audit/setup',{method:'POST',headers:{cookie,Origin:origin},body,redirect:'manual'});
  const auth=new URL(start.headers.get('location'));
  assert.equal(auth.searchParams.get('scope'),SCOPE);
  assert.equal(auth.searchParams.get('code_challenge_method'),'S256');
  const callback=base+'/drive-audit/callback?code=one&state='+auth.searchParams.get('state');
  assert.equal((await fetch(callback,{headers:{cookie}})).status,200);
  assert.equal(calls,2);
  assert.equal(fs.statSync(dir+'/rclone.conf').mode & 0o777,0o600);
  assert.equal(JSON.parse(fs.readFileSync(dir+'/authorized.json')).email,'owner@example.com');
  assert.equal((await fetch(callback,{headers:{cookie}})).status,410);
  assert.equal(calls,2);
 }finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true});}
});
