import { join } from 'node:path';
import { chromium, firefox } from 'playwright';

export const BROWSERS=['chromium','firefox'];
const chromiumArgs=['--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--disable-background-networking'];

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
 if(browserKind({browser})==='firefox')config.firefoxUserPrefs={...firefoxPrefs};
 else Object.assign(config,{channel:'chromium',chromiumSandbox:true,args:[...(headed?['--disable-gpu']:[]),...chromiumArgs]});
 return config;
}

export function defaultLaunch(options){
 return (browserKind(options)==='firefox'?firefox:chromium).launchPersistentContext(options.path,options.config);
}
