import {spawn as nodeSpawn} from 'node:child_process';

export const validHandoffText = text => typeof text === 'string' && text.length > 0 && text.length <= 1000 && /^[^\p{Cc}\p{Cs}\p{Zl}\p{Zp}]+$/u.test(text);
const failure=code=>Object.assign(new Error(code),{code});
/** Owner-entered text travels only over stdin. Never include it in argv, logs or errors. */
export function typeDesktopText({text,display,signal,spawn=nodeSpawn}) {
 if(!validHandoffText(text)||!/^:\d{1,4}$/.test(display||''))throw failure('INVALID_TEXT_INPUT');
 if(signal?.aborted)throw failure('HANDOFF_INPUT_CANCELLED');
 return new Promise((resolve,reject)=>{
  let settled=false,stopReason=null;
  const child=spawn('/usr/bin/xdotool',['type','--clearmodifiers','--delay','10','--file','-'],
    {env:{PATH:'/usr/bin:/bin',DISPLAY:display,LANG:'C.UTF-8',LC_ALL:'C.UTF-8'},stdio:['pipe','ignore','ignore']});
  const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(failure(error)):resolve();};
  const stop=reason=>{stopReason ||= reason;child.kill('SIGKILL');};
  const abort=()=>stop('HANDOFF_INPUT_CANCELLED');
  const timer=setTimeout(()=>stop('HANDOFF_INPUT_TIMEOUT'),15000);
  signal?.addEventListener('abort',abort,{once:true});
  child.on('error',()=>{stopReason ||= 'HANDOFF_INPUT_FAILED';});
  child.on('close',code=>finish(stopReason||(code===0?null:'HANDOFF_INPUT_FAILED')));
  child.stdin.on('error',()=>stop('HANDOFF_INPUT_FAILED'));
  child.stdin.end(text);
 });
}
