import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {generateCredentials} from '../scripts/create-credentials.js';
test('gateway exits unsuccessfully when its port is occupied',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'patronus-bind-test-'));
 const c=generateCredentials();
 for(const [name,value] of Object.entries({'password-hash':c.passwordHash,'jwks.json':JSON.stringify(c.jwks),'cookie-keys.json':JSON.stringify(c.cookieKeys)}))writeFileSync(join(dir,name),value,{mode:0o600});
 const occupied=createServer();await new Promise(r=>occupied.listen(0,'127.0.0.1',r));let child;
 try{
  child=spawn(process.execPath,['src/gateway.js'],{env:{...process.env,CREDENTIALS_DIRECTORY:dir,PATRONUS_AUTH_DATA_DIR:join(dir,'state'),PORT:String(occupied.address().port)},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const result=await new Promise((resolve,reject)=>{const t=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Gateway failed to exit'));},10000);child.once('exit',(code)=>{clearTimeout(t);resolve(code);});child.once('error',reject);});
  assert.equal(result,1);assert.match(output,/patronus_listen_failed/);assert.doesNotMatch(output,/Patronus MCP listening/);
 }finally{child?.kill();await new Promise(r=>occupied.close(r));rmSync(dir,{recursive:true,force:true});}
});
