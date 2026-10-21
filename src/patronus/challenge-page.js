import {parseHTML} from 'linkedom';
import {fault} from './network.js';

// Classify evidence only. Never execute page code, click a widget, or pass
// untrusted text/URLs into an obstacle reason.
export function challengePage(html, url, frameUrls=[]) {
 const {document}=parseHTML(html);
 const title=(document.querySelector('title')?.textContent||'').trim();
 const headings=[...document.querySelectorAll('h1,h2,[role=heading]')].map(e=>e.textContent.trim());
 const prompt=/^(?:just a moment(?:[.!…]|$)|verify (?:to continue|you are (?:a )?human)|checking (?:your browser|if the site connection is secure)|security (?:check|verification)|are you (?:a )?(?:human|robot)|access denied)/i;
 if(prompt.test(title))return 'VERIFICATION_INTERSTITIAL';
 const formContent=!!document.querySelector('form input:not([type=hidden]),form textarea,form select');
 const frames=[...frameUrls,...[...document.querySelectorAll('iframe[src]')].map(f=>f.getAttribute('src'))];
 let provider=null;
 for(const src of frames){
  let u;try{u=new URL(src,url);}catch{continue;}
  if(u.hostname==='challenges.cloudflare.com'&&u.pathname.includes('/challenge-platform/'))provider='CLOUDFLARE_CHALLENGE';
  if(/(^|\.)hcaptcha\.com$/.test(u.hostname))provider='HCAPTCHA_CHALLENGE';
  if(/(^|\.)(google\.com|recaptcha\.net)$/.test(u.hostname)&&/\/recaptcha\/(?:api2|enterprise)\/bframe/.test(u.pathname))provider='RECAPTCHA_CHALLENGE';
  if(/(^|\.)captcha-delivery\.com$/.test(u.hostname))provider='DATADOME_CHALLENGE';
 }
 const vendorWidget=!!document.querySelector('#px-captcha,#datadome-captcha,#sec-cpt-container');
 for(const e of document.querySelectorAll('script,style,noscript,template,[hidden],[aria-hidden=true]'))e.remove();
 const text=(document.body?.textContent||document.documentElement?.textContent||'').replace(/\s+/g,' ').trim();
 if(text.length<1500&&headings.some(h=>prompt.test(h)))return 'VERIFICATION_INTERSTITIAL';
 const instruction=/(?:verify (?:that )?you(?:'re| are) (?:a )?human|confirm that you(?:'re| are) (?:a )?human|press (?:and|&) hold|complete (?:the|this) security check|checking your browser|unusual traffic from your|enable javascript and cookies to continue)/i.test(text);
 // A widget on a content/form page is not itself an interstitial. Require
 // challenge instructions or a short, otherwise empty challenge surface.
 if(provider&&(instruction||(!formContent&&text.length<200)))return provider;
 if(vendorWidget&&(instruction||text.length<200))return 'VENDOR_CHALLENGE';
 if(instruction&&text.length<1500)return 'VERIFICATION_INTERSTITIAL';
 return null;
}
export function rejectChallengePage(html,url,frameUrls=[]) {
 const reason=challengePage(html,url,frameUrls);
 if(reason)throw Object.assign(fault('CHALLENGE_PAGE'),{reason});
}
