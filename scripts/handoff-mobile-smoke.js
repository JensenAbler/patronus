import assert from 'node:assert/strict';
import express from 'express';
import {chromium,devices} from 'playwright';
import {createHandoff} from '../src/handoff.js';
// A separate, ephemeral test browser and synthetic pixels only; never live Chrome.
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome'});
const desktop=await browser.newPage({viewport:{width:1280,height:720}});
await desktop.setContent('<body style="margin:0;background:#e7edf3;font:40px system-ui"><h1 style="padding:30px">Synthetic handoff test screen</h1><div style="display:grid;grid-template-columns:repeat(3,200px);gap:10px;padding:30px">'+[1,2,3,4,5,6].map(x=>'<div style="background:#537eaa;height:150px;padding:10px;color:white">Tile '+x+'</div>').join('')+'</div></body>');
const synthetic=(await desktop.screenshot({type:'jpeg'})).toString('base64');await desktop.close();
const app=express(), server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
const origin='http://127.0.0.1:'+server.address().port,calls=[];
const handoff=createHandoff({baseUrl:origin+'/patronus',verifyPassword:async p=>p==='fixture-only-password',
 call:async(name,args)=>{calls.push(args);await new Promise(r=>setTimeout(r,80));return {screenshot:synthetic,screenshotMimeType:'image/jpeg',desktop:{startedAt:'synthetic-only'}};}});
app.use('/patronus/handoff',handoff.router);
const context=await browser.newContext({...devices['iPhone 13']});
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{const original=Date.now;Date.now=()=>original()+Number(window.__clockSkew||0);});
async function delayNextFrame(){
 let release,received=false;const delay=new Promise(r=>release=r);
 await page.route('**/handoff/frame',async route=>{const response=await route.fetch();received=true;await delay;await route.fulfill({response});},{times:1});
 await page.getByRole('button',{name:'Refresh',exact:true}).tap();
 while(!received)await new Promise(r=>setTimeout(r,10));
 return release;
}
try {
 await page.goto(origin+'/patronus/handoff');
 await page.getByLabel('Patronus password').fill('fixture-only-password');
 await page.getByRole('button',{name:'Sign in',exact:true}).tap();
 await page.getByRole('button',{name:'Take control',exact:true}).waitFor();
 await page.getByRole('button',{name:'Take control',exact:true}).tap();
 await page.waitForFunction(()=>document.getElementById('screen').src.startsWith('data:image/jpeg'));
 await page.getByRole('button',{name:'Refresh',exact:true}).waitFor({state:'visible'});
 await page.waitForFunction(()=>!document.getElementById('refresh').disabled);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'mobile page should fit');
 const screen=page.locator('#screen');await screen.scrollIntoViewIfNeeded();
 await screen.tap({position:{x:120,y:80}});
 await page.waitForFunction(()=>!document.getElementById('refresh').disabled);
 const click=calls.find(c=>c.action==='click');assert.ok(click);
 assert.ok(click.x>400&&click.x<440,'scaled horizontal tap should map to desktop pixels: '+click.x);
 assert.ok(click.y>270&&click.y<300,'scaled vertical tap should map to desktop pixels: '+click.y);
 await page.getByRole('button',{name:'Full size',exact:true}).tap();
 assert.equal(await page.locator('#screen-wrap').evaluate(e=>e.scrollWidth>e.clientWidth),true,'full-size view supports panning');
 await page.getByRole('button',{name:'Fit screen',exact:true}).tap();
 await page.getByRole('button',{name:'Scroll down',exact:true}).tap();
 await page.waitForFunction(()=>!document.getElementById('refresh').disabled);
 assert.ok(calls.some(c=>c.action==='scroll'&&c.dy===3));
 await page.getByRole('button',{name:'Tab',exact:true}).tap();
 await page.waitForFunction(()=>!document.getElementById('refresh').disabled);
 assert.ok(calls.some(c=>c.action==='key'&&c.key==='Tab'));
 await page.screenshot({path:'/tmp/patronus-handoff-mobile-fixture.png',fullPage:true});
 const releaseDoneFrame=await delayNextFrame();
 await page.getByRole('button',{name:'Done',exact:true}).tap();
 await page.waitForFunction(()=>document.getElementById('status').textContent.includes('Handoff ended'));
 releaseDoneFrame();await page.waitForTimeout(250);
 assert.equal(await page.locator('#screen').getAttribute('src'),null,'late frame must not restore pixels after Done');
 await page.reload();
 await page.getByLabel('Patronus password').waitFor();
 await page.getByLabel('Patronus password').fill('fixture-only-password');
 await page.getByRole('button',{name:'Sign in',exact:true}).tap();
 await page.getByRole('button',{name:'Take control',exact:true}).tap();
 await page.waitForFunction(()=>document.getElementById('screen').src.startsWith('data:image/jpeg')&&!document.getElementById('refresh').disabled);
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
 assert.equal(await page.locator('#screen').getAttribute('src'),null,'app background hides private pixels');
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
 await page.waitForFunction(()=>document.getElementById('screen').src.startsWith('data:image/jpeg')&&!document.getElementById('refresh').disabled);
 const releaseExpiredFrame=await delayNextFrame();
 await page.evaluate(()=>{window.__clockSkew=960000;});
 await page.waitForFunction(()=>document.getElementById('status').textContent.includes('Session expired'));
 releaseExpiredFrame();await page.waitForTimeout(250);
 assert.equal(await page.locator('#screen').getAttribute('src'),null,'late frame must not restore pixels after expiry');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,viewport:'iPhone 13 390x664',checks:['password sign-in','take control','frame display','scaled touch click','full-size pan','scroll','navigation key','Done clears pixels','revoked sign-in','late frame after Done blocked','background hides pixels','visible revalidation','late frame after expiry blocked','no JS errors'],syntheticOnly:true}));
} finally {
 handoff.close();await context.close();await browser.close();await new Promise(r=>server.close(r));
}
