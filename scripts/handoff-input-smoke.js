import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {typeDesktopText} from '../src/handoff-input.js';
// A separate synthetic browser/profile/display, matching production's X11 setup.
const xvfb=spawn('Xvfb',['-displayfd','1','-screen','0','1280x720x24','-nolisten','tcp'],{stdio:['ignore','pipe','ignore']});
process.env.DISPLAY=await new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(Error('fixture display timeout')),10000);xvfb.stdout.on('data',chunk=>{data+=chunk;const m=data.match(/^(\d+)\n/);if(m){clearTimeout(timer);resolve(':'+m[1]);}});xvfb.on('error',reject);});
assert.match(process.env.DISPLAY,/^:\d{1,4}$/);
const browser=await chromium.launch({headless:false,executablePath:'/usr/bin/google-chrome'});
try {
 const page=await browser.newPage();await page.setContent('<label>Synthetic field<input id="target"></label>');
 await page.locator('#target').click();
 const windows=execFileSync('/usr/bin/xdotool',['search','--onlyvisible','--class','chrome'],{encoding:'utf8'}).trim().split('\n');
 execFileSync('/usr/bin/xdotool',['windowfocus','--sync',windows[0]]);
 await page.locator('#target').click();
 const sample='ASCII café 🔒';
 await typeDesktopText({text:sample,display:process.env.DISPLAY});
 assert.equal(await page.locator('#target').inputValue(),sample);
 console.log(JSON.stringify({ok:true,isolatedX11:true,stdinTyping:true,asciiAndUnicodeRoundTrip:true}));
} finally {await browser.close();xvfb.kill('SIGTERM');}
