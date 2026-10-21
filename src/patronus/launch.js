import { join } from 'node:path';
import { chromium, firefox } from 'playwright';

export const BROWSERS=['chromium','firefox'];
const chromiumArgs=['--disable-blink-features=AutomationControlled','--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--disable-background-networking'];

// Firefox counterparts of the Chromium flags above, plus background services that would
// otherwise spend the job's byte budget or open channels outside page routing.
export const firefoxPrefs=Object.freeze({
 'network.http.http3.enable':false,
 'media.peerconnection.enabled':false,
 'network.trr.mode':5,
 'network.dns.disablePrefetch':true,
 'network.prefetch-next':false,
 'network.predictor.enabled':false,
 'network.captive-portal-service.enabled':false,
 'network.connectivity-service.enabled':false,
 'browser.safebrowsing.malware.enabled':false,
 'browser.safebrowsing.phishing.enabled':false,
 'browser.safebrowsing.downloads.enabled':false,
 'app.update.auto':false,
 'app.normandy.enabled':false,
 'extensions.update.enabled':false,
 'messaging-system.rsexperimentloader.enabled':false,
 'datareporting.healthreport.uploadEnabled':false,
 'datareporting.policy.dataSubmissionEnabled':false,
 'toolkit.telemetry.enabled':false,
 'browser.region.network.url':'',
 'browser.search.geoip.url':''
});

export function browserKind(args){return args?.browser==='firefox'?'firefox':'chromium';}

// Persistent profiles are engine-specific; Firefox never opens a Chromium profile directory.
// The provisioning gate and access.json import stay under profiles/<name> for both.
export function profileDir(root,name,browser){
 return browserKind({browser})==='firefox'?join(root,'firefox-profiles',name):join(root,'profiles',name);
}

// One launch policy for every browser use. proxy is the started DNS-pinning proxy.
export function launchConfig({browser,headed=false,proxy,userAgent,permissions,viewport,acceptDownloads=false}={}){
 const config={headless:!headed,serviceWorkers:'block',acceptDownloads};
 if(proxy)config.proxy={server:proxy.url,bypass:'<-loopback>'};
 if(permissions)config.permissions=permissions;
 if(userAgent)config.userAgent=userAgent;
 if(viewport)config.viewport=viewport;
 else if(browserKind({browser})==='chromium')config.viewport=null;
 if(browserKind({browser})==='firefox')config.firefoxUserPrefs={...firefoxPrefs};
 else Object.assign(config,{channel:'chrome',chromiumSandbox:true,ignoreDefaultArgs:['--enable-automation'],args:[...(headed?['--disable-gpu']:[]),...chromiumArgs,'--enable-speech-dispatcher','--window-size=1920,1080',...(!headed?['--screen-info={1920x1080}']:[])]});
 return config;
}

// Keep Chromium's native brand/GREASE lists. CDP fills omitted brand fields from
// the running binary, including fullVersionList; never pretend Chromium is Chrome.
export function chromiumIdentity(version){
 if(!/Linux/.test(version.userAgent))throw new Error('Expected a Linux browser');
 const fullVersion=version.product.split('/')[1];
 if(!/^\d+\.\d+\.\d+\.\d+$/.test(fullVersion))throw new Error('Invalid browser version');
 return {userAgent:version.userAgent.replace('HeadlessChrome/','Chrome/'),platform:'Linux x86_64',
  userAgentMetadata:{platform:'Linux',platformVersion:'',architecture:'x86',model:'',
   mobile:false,bitness:'64',wow64:false,fullVersion}};
}

export async function defaultLaunch(options){
 const isFirefox=browserKind(options)==='firefox';
 const context=await (isFirefox?firefox:chromium).launchPersistentContext(options.path,options.config);
 if(isFirefox)return context;
 try{
  const page=context.pages()[0]||await context.newPage();
  const session=await context.newCDPSession(page);
  const identity=chromiumIdentity(await session.send('Browser.getVersion'));
  await session.send('Emulation.setUserAgentOverride',identity);
  // Keep the CDP session attached: detaching resets its emulation overrides.
  context.on('page',async next=>{
   try{const s=await context.newCDPSession(next);await s.send('Emulation.setUserAgentOverride',identity);}
   // Download-only targets can disappear before a CDP session attaches.
   catch{if(!next.isClosed())await next.close().catch(()=>{});}
  });
  return context;
 }catch(error){await context.close();throw error;}
}
