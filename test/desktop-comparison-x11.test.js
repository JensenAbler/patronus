import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {captureFrame,runDesktopInput} from '../src/patronus/desktop-control.js';

const painter=String.raw`
import ctypes as C, sys
x=C.CDLL('libX11.so.6')
def bind(name,restype,*args):
 f=getattr(x,name); f.restype=restype; f.argtypes=list(args); return f
P=C.c_void_p; U=C.c_ulong; I=C.c_int
op=bind('XOpenDisplay',P,C.c_char_p); d=op(None)
if not d: raise RuntimeError('fixture display unavailable')
root=bind('XDefaultRootWindow',U,P)(d)
w=bind('XCreateSimpleWindow',U,P,U,I,I,C.c_uint,C.c_uint,C.c_uint,U,U)(d,root,0,0,320,240,0,0,0x607080)
gc=bind('XCreateGC',P,P,U,U,P)(d,w,0,None)
bind('XMapWindow',I,P,U)(d,w)
cursor=bind('XCreateFontCursor',U,P,C.c_uint)(d,68)
bind('XDefineCursor',I,P,U,U)(d,w,cursor)
sync=bind('XSync',I,P,I)
setfg=bind('XSetForeground',I,P,P,U)
arc=bind('XDrawArc',I,P,U,P,I,I,C.c_uint,C.c_uint,I,I)
line=bind('XDrawLine',I,P,U,P,I,I,I,I)
sync(d,0); print('READY',flush=True)
for cmd in sys.stdin:
 if cmd.strip()=='ring':
  setfg(d,gc,0xffffff); arc(d,w,gc,140,90,50,50,0,360*64)
  line(d,w,gc,158,108,172,122);line(d,w,gc,172,108,158,122)
  sync(d,0);print('PAINTED',flush=True)
`;
const hash=b=>createHash('sha256').update(b).digest('hex');
function nextLine(stream){
 const rl=createInterface({input:stream});return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{rl.close();reject(Error('fixture readiness timeout'));},5000);
  rl.once('line',value=>{clearTimeout(timer);rl.close();resolve(value);});
 });
}
async function stop(child){
 if(child.exitCode!==null||child.signalCode!==null)return;
 const done=once(child,'close');child.kill('SIGTERM');await done;
}
test('isolated X11: excluding native cursor removes only cursor changes, not painted rings',
 {skip:process.env.PATRONUS_X11_CAPTURE_TEST!=='1',timeout:30000},async t=>{
 const xvfb=spawn('Xvfb',['-displayfd','1','-screen','0','320x240x24','-nolisten','tcp'],{stdio:['ignore','pipe','pipe']});
 t.after(()=>stop(xvfb));
 const display=':'+await nextLine(xvfb.stdout);
 assert.match(display,/^:\d+$/);
 // Never reuse a caller's DISPLAY or address the production browser.
 const paint=spawn('python3',['-u','-c',painter],{env:{PATH:'/usr/bin:/bin',DISPLAY:display},stdio:['pipe','pipe','pipe']});
 t.after(()=>stop(paint));
 assert.equal(await nextLine(paint.stdout),'READY');
 const take=drawMouse=>captureFrame({display,screen:{width:320,height:240},view:{width:320,height:240},drawMouse});
 await runDesktopInput('xdotool',['mousemove','--sync','40','50'],{display});
 const normalA=await take(true),neutralA=await take(false);
 await runDesktopInput('xdotool',['mousemove','--sync','220','160'],{display});
 const normalB=await take(true),neutralB=await take(false);
 assert.notDeepEqual(normalA,normalB);
 assert.deepEqual(neutralA,neutralB);
 const painted=nextLine(paint.stdout);paint.stdin.write('ring\n');assert.equal(await painted,'PAINTED');
 const neutralRing=await take(false);
 assert.notDeepEqual(neutralB,neutralRing);
 t.diagnostic(JSON.stringify({normalA:hash(normalA),normalB:hash(normalB),neutralA:hash(neutralA),
  neutralB:hash(neutralB),neutralRing:hash(neutralRing),scope:'Synthetic window on isolated Xvfb; no browser'}));
});
