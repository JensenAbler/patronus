import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { displayURL } from './network.js';
export function extract(html,url) {
  const {document}=parseHTML(html); const title=document.querySelector('title')?.textContent||'';
  const links=[],images=[];
  // Describe forms without field values, hidden tokens or credentials.
  const allForms=[...document.querySelectorAll('form')];
  const forms=allForms.slice(0,20).map((form,index)=>{
    let action=null;
    try{const u=new URL(form.getAttribute('action')||url,url);if(['https:','http:'].includes(u.protocol))action=displayURL(u.href);}catch{}
    const controls=[...form.querySelectorAll('input,textarea,select,button')];
    const fields=controls.filter(el=>!['hidden','password'].includes((el.getAttribute('type')||'').toLowerCase())).slice(0,50).map(el=>({
      tag:el.localName,type:el.getAttribute('type')||(el.localName==='button'?'submit':'text'),
      name:el.getAttribute('name')||null,id:el.getAttribute('id')||null,
      label:el.getAttribute('aria-label')||[...document.querySelectorAll('label')].find(l=>el.getAttribute('id')&&l.getAttribute('for')===el.getAttribute('id'))?.textContent.trim()||el.closest('label')?.textContent.trim()||null,
      required:el.hasAttribute('required'),disabled:el.hasAttribute('disabled')
    }));
    return {index,action,method:(form.getAttribute('method')||'GET').toUpperCase(),fields,fieldsOmitted:controls.length-fields.length,hasPassword:controls.some(el=>el.getAttribute('type')?.toLowerCase()==='password'),submissionSupported:false};
  });
  for(const el of document.querySelectorAll('script,style,noscript,template,input,textarea')) el.remove();
  for(const a of document.querySelectorAll('a[href]')) {
    try{const full=new URL(a.getAttribute('href'),url);if(!['https:','http:'].includes(full.protocol)){a.removeAttribute('href');continue;}
      links.push({text:a.textContent.trim(),url:full.href});a.setAttribute('href',displayURL(full.href));
    }catch{a.removeAttribute('href');}
  }
  for(const [i,img] of [...document.querySelectorAll('img')].entries()) {
    try{const src=new URL(img.getAttribute('src')||'',url).href;
      images.push({id:'image-'+i,url:src,alt:img.getAttribute('alt')||'',caption:img.closest('figure')?.querySelector('figcaption')?.textContent||'',source:'page'});
      img.setAttribute('src','patronus-image:'+i);
    }catch{}
  }
  const converter=new TurndownService({headingStyle:'atx'});converter.use(gfm);
  let markdown=converter.turndown(document.body?.innerHTML??document.documentElement?.outerHTML??'');
  const truncated=markdown.length>500000;markdown=markdown.slice(0,500000);
  return {title,markdown,links,images,forms,coverage:{formsCaptured:forms.length,formsOmitted:allForms.length-forms.length,textTruncated:truncated,iframes:document.querySelectorAll('iframe').length,scope:'Rendered/extracted document; unvisited links and frames are not claimed complete.'}};
}
