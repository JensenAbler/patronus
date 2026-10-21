import test from 'node:test';
import assert from 'node:assert/strict';
import {desktopEnvironmentConfig} from '../src/patronus/desktop-environment.js';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {launchConfig} from '../src/patronus/launch.js';
test('native sound uses private Unix sockets, persistent daemons and real Linux backend',()=>{
 const c=desktopEnvironmentConfig('/run/patronus/desktop-test');
 assert.equal(c.env.PULSE_SERVER,'unix:/run/patronus/desktop-test/native.sock');
 assert.equal(c.env.SPEECHD_ADDRESS,'unix_socket:/run/patronus/desktop-test/speech.sock');
 assert.match(c.pulse,/module-null-sink/);assert.match(c.pulse,/module-remap-source master=desktop.monitor/);
 assert.doesNotMatch(c.pulse,/tcp|auth-anonymous/);
 assert.match(c.speech,/DefaultModule espeak-ng/);
 assert.match(c.speech,/AddModule "espeak-ng" "sd_generic"/);
 assert.throws(()=>desktopEnvironmentConfig('/tmp/a\nload-module bad'));
});
test('native speech inventory selects 28 installed voices, including English variants',()=>{
 const config=readFileSync(new URL('../src/patronus/espeak-ng.conf',import.meta.url),'utf8');
 const voices=[...config.matchAll(/^AddVoice "([^"]+)" "([^"]+)" "([^"]+)"$/gm)];
 assert.equal(voices.length,28);assert.equal(voices.filter(v=>v[1].startsWith('en-')).length,12);
 assert.equal(new Set(voices.map(v=>v[3])).size,28);
 for(const [,lang,,voice]of voices){
  assert.match(voice,/^[a-z0-9+-]+$/);assert.ok(voice.startsWith(lang));
  const wav=execFileSync('espeak-ng',['-v',voice,'--stdout','test']);
  assert.equal(wav.subarray(0,4).toString(),'RIFF');assert.ok(wav.length>44);
 }
});
test('Chrome uses native desktop geometry and speech without emulated devices or permission grants',()=>{
 for(const headed of [false,true]){
  const c=launchConfig({headed});
  assert.equal(c.viewport,null);assert.equal(c.permissions,undefined);
  assert.ok(c.args.includes('--window-size=1920,1080'));
  assert.ok(c.args.includes('--enable-speech-dispatcher'));
  assert.equal(c.args.includes('--screen-info={1920x1080}'),!headed);
  assert.ok(c.args.every(a=>!a.includes('fake-device')));
 }
 assert.deepEqual(launchConfig({viewport:{width:1100,height:900}}).viewport,{width:1100,height:900});
 assert.equal(launchConfig({browser:'firefox'}).args,undefined);
 assert.equal(launchConfig({browser:'firefox'}).viewport,undefined);
});
