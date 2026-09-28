// A bounded readiness observation, not a claim that a site is complete.
// Track application/document requests (including frames), not ad image traffic.
export function trackRequests(page) {
 const pending=new Set();let changedAt=Date.now();
 const begin=r=>{if(['document','fetch','xhr'].includes(r.resourceType())){pending.add(r);changedAt=Date.now();}};
 const end=r=>{if(pending.delete(r))changedAt=Date.now();};
 page.on('request',begin);page.on('requestfinished',end);page.on('requestfailed',end);
 return {pending,changedAt:()=>changedAt,close:()=>{page.off('request',begin);page.off('requestfinished',end);page.off('requestfailed',end);}};
}
export async function waitForReadiness(page,tracker,{timeoutMs=20000,minWaitMs=5000,selector,signal,clock=()=>Date.now(),sleep=ms=>page.waitForTimeout(ms)}={}) {
 const start=clock();let signature=null,stableSince=start,selectorMatched=!selector;
 while(true){
  if(signal?.aborted)throw signal.reason;
  const frames=page.frames().slice(0,10);
  const snapshots=await Promise.all(frames.map(async frame=>{
   try{return await frame.evaluate(sel=>{
    const text=(document.body?.innerText||'').slice(0,500000);let hash=0;
    for(let i=0;i<text.length;i++)hash=(Math.imul(hash,31)+text.charCodeAt(i))|0;
    let matched=!sel;try{if(sel)matched=!!document.querySelector(sel);}catch{}
    return {url:location.href,length:text.length,hash,matched,ready:document.readyState!=='loading'};
   },selector||null);}catch{return {ready:false};}
  }));
  const next=JSON.stringify(snapshots);
  if(next!==signature){signature=next;stableSince=clock();}
  selectorMatched=!selector||snapshots.some(s=>s.matched);
  if(clock()-start>=minWaitMs&&clock()-stableSince>=1000&&clock()-tracker.changedAt()>=1000&&
    tracker.pending.size===0&&snapshots.every(s=>s.ready)&&selectorMatched)
   return {outcome:'settled',elapsedMs:clock()-start,pendingRequests:0,selectorMatched,minWaitMs,timeoutMs};
  if(clock()-start>=timeoutMs)break;
  await sleep(250);
 }
 return {outcome:'timeout',elapsedMs:clock()-start,pendingRequests:tracker.pending.size,selectorMatched,minWaitMs,timeoutMs};
}
