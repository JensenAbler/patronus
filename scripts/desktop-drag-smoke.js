import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {DesktopControl} from '../src/patronus/desktop-control.js';

// Never reuse DISPLAY or a browser profile: the fixture has its own X server and
// synthetic page. Playwright observes events only; the gesture uses real X input.
const xvfb=spawn('Xvfb',['-displayfd','1','-screen','0','1280x720x24','-nolisten','tcp'],{stdio:['ignore','pipe','ignore']});
let browser;
try {
 const display=await new Promise((resolve,reject)=>{
  let data='';const timer=setTimeout(()=>reject(Error('fixture display timeout')),10000);
  xvfb.stdout.on('data',chunk=>{data+=chunk;const m=data.match(/^(\d+)\n/);if(m){clearTimeout(timer);resolve(':'+m[1]);}});
  xvfb.once('error',e=>{clearTimeout(timer);reject(e);});
  xvfb.once('exit',()=>{clearTimeout(timer);reject(Error('fixture display exited'));});
 });
 assert.match(display,/^:\d{1,4}$/);
 browser=await chromium.launch({headless:false,executablePath:'/usr/bin/google-chrome',env:{...process.env,DISPLAY:display}});
 const page=await browser.newPage({viewport:{width:1280,height:620}});
 await page.setContent('<style>body{margin:0}#source{position:absolute;left:80px;top:100px;width:70px;height:70px;background:royalblue}#target{position:absolute;left:460px;top:260px;width:100px;height:100px;background:lightgreen}</style><div id="source">DRAG</div><div id="target">DROP</div><script>window.events=[];for(const type of ["mousedown","mousemove","mouseup"])document.addEventListener(type,e=>events.push({type,x:e.clientX,y:e.clientY,buttons:e.buttons}));document.addEventListener("mouseup",e=>window.dropped=e.target.id==="target");<\/script>');
 const windows=execFileSync('xdotool',['search','--onlyvisible','--class','chrome'],{encoding:'utf8',env:{...process.env,DISPLAY:display}}).trim().split('\n');
 execFileSync('xdotool',['windowfocus','--sync',windows[0]],{env:{...process.env,DISPLAY:display}});
 // Wait for the synthetic window to receive focus and paint before measuring
 // screen offsets. An immediate first click can otherwise be consumed by focus.
 await page.waitForFunction(()=>document.hasFocus());
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await new Promise(resolve=>setTimeout(resolve,150));
 const offset=await page.evaluate(()=>({x:window.screenX+(window.outerWidth-window.innerWidth)/2,y:window.screenY+window.outerHeight-window.innerHeight}));
 const ctrl=new DesktopControl({healthy:()=>true,display},{screen:{width:1280,height:720},view:{width:1280,height:720}});
 await ctrl.drag({x:Math.round(115+offset.x),y:Math.round(135+offset.y),toX:Math.round(500+offset.x),toY:Math.round(300+offset.y),points:[{x:Math.round(300+offset.x),y:Math.round(200+offset.y)}],durationMs:600});
 const result=await page.evaluate(()=>({events,dropped}));
 assert.equal(result.dropped,true);
 assert.equal(result.events.filter(e=>e.type==='mousedown').length,1,JSON.stringify({offset,result}));
 assert.equal(result.events.filter(e=>e.type==='mouseup').length,1);
 assert.ok(result.events.filter(e=>e.type==='mousemove'&&e.buttons===1).length>=10);
 assert.equal(result.events.at(-1).buttons,0);
 const frame=await ctrl.screenshot();assert.ok(frame.length>1000);
 console.log(JSON.stringify({ok:true,isolatedX11:true,display,nativeDrag:true,heldMoves:result.events.filter(e=>e.type==='mousemove'&&e.buttons===1).length,released:true,screenshotBytes:frame.length}));
} finally {await browser?.close();xvfb.kill('SIGTERM');}
