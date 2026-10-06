import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {typeDesktopText,validHandoffText} from '../src/handoff-input.js';

test('text is bounded printable Unicode with no controls or normalization',()=>{
 for(const value of ['', 'a'.repeat(1001),'line\nbreak','tab\tfield','null\0value','\x7f','\x85','\u2028','\ud800'])assert.equal(validHandoffText(value),false);
 for(const value of [' a b ', 'email@example.test', 'café 🔒'])assert.equal(validHandoffText(value),true);
});
test('text travels only on stdin, never argv/environment/output',async()=>{
 const secret='synthetic-private-value';let input,argv,options;
 const spawn=(command,args,config)=>{
  assert.equal(command,'/usr/bin/xdotool');argv=args;options=config;
  const child=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=value=>{input=value;queueMicrotask(()=>child.emit('close',0));};return child;
 };
 await typeDesktopText({text:secret,display:':77',spawn});
 assert.equal(input,secret);assert.equal(JSON.stringify({argv,options}).includes(secret),false);
 assert.deepEqual(argv.slice(-2),['--file','-']);assert.deepEqual(options.stdio,['pipe','ignore','ignore']);
 assert.equal(options.env.DISPLAY,':77');assert.equal(options.env.LC_ALL,'C.UTF-8');
});
test('remote displays and control characters never spawn a process',()=>{
 const spawn=()=>assert.fail('must not spawn');
 assert.throws(()=>typeDesktopText({text:'safe',display:'attacker.example:0',spawn}),/INVALID_TEXT_INPUT/);
 assert.throws(()=>typeDesktopText({text:'bad\ntext',display:':0',spawn}),/INVALID_TEXT_INPUT/);
});
test('revocation kills typing and keeps promise unsettled until child exit',async()=>{
 const controller=new AbortController();let child,killed=false,settled=false;
 const spawn=()=>{child=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=()=>{};child.kill=signal=>{assert.equal(signal,'SIGKILL');killed=true;};return child;};
 const pending=typeDesktopText({text:'synthetic-only',display:':77',spawn,signal:controller.signal}).finally(()=>{settled=true;});
 controller.abort();await new Promise(r=>setTimeout(r,5));assert.equal(killed,true);assert.equal(settled,false);
 child.emit('close',null);await assert.rejects(pending,e=>e.code==='HANDOFF_INPUT_CANCELLED');
});
test('process errors never echo text or executable diagnostics',async()=>{
 const secret='synthetic-private-value';
 const spawn=()=>{const child=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=()=>queueMicrotask(()=>{child.emit('error',new Error(secret));child.emit('close',-1);});return child;};
 await assert.rejects(typeDesktopText({text:secret,display:':77',spawn}),e=>e.code==='HANDOFF_INPUT_FAILED'&&!e.message.includes(secret));
});
