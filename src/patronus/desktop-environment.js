import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, writeFile, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

// Native per-service daemons: no login session, TCP listener, device spoofing,
// permission grant, or changes to the host's global sound configuration.
export function desktopEnvironmentConfig(dir) {
 if (!/^\/[A-Za-z0-9_./-]+$/.test(dir)) throw new Error('INVALID_DESKTOP_RUNTIME_PATH');
 return {
  env: {XDG_RUNTIME_DIR:dir, PULSE_SERVER:'unix:'+join(dir,'native.sock'), SPEECHD_ADDRESS:'unix_socket:'+join(dir,'speech.sock')},
  pulse: [
   'load-module module-native-protocol-unix socket='+join(dir,'native.sock'),
   'load-module module-null-sink sink_name=desktop sink_properties=device.description=Desktop_Audio',
   'load-module module-remap-source master=desktop.monitor source_name=microphone source_properties=device.description=Desktop_Microphone',
   'set-default-sink desktop', 'set-default-source microphone', ''
  ].join('\n'),
  speech: [
   'LogLevel 1', 'LogDir "'+dir+'"', 'CommunicationMethod "unix_socket"',
   'SocketPath "'+join(dir,'speech.sock')+'"', 'AudioOutputMethod "pulse"',
   'AddModule "espeak-ng" "sd_espeak-ng" "/etc/speech-dispatcher/modules/espeak-ng.conf"',
   'DefaultModule espeak-ng', ''
  ].join('\n')
 };
}
export async function startDesktopEnvironment({root='/run/patronus', onFailure=()=>process.exit(1)}={}) {
 await mkdir(root,{recursive:true,mode:0o700});
 const dir=await mkdtemp(join(root,'desktop-')), config=desktopEnvironmentConfig(dir);
 const env={...process.env,...config.env}, children=[];
 let stopping=false, failure;
 const start=(command,args)=>{
  const child=spawn(command,args,{env,stdio:['ignore','ignore','pipe']});children.push(child);
  child.stderr.on('data',data=>console.error(command+': '+data.toString().trim()));
  child.on('error',error=>{failure=error;});
  child.on('exit',(code,signal)=>{if(!stopping){failure=new Error(command+' stopped: '+(code??signal));console.error(failure.message);onFailure(failure);}});
  return child;
 };
 const stop=async()=>{
  stopping=true;
  await Promise.all(children.map(child=>new Promise(resolve=>{
   if(child.exitCode!==null||child.signalCode!==null||!child.pid)return resolve();
   const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
   child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');
  })));
  await rm(dir,{recursive:true,force:true});
 };
 try {
  await writeFile(join(dir,'pulse.pa'),config.pulse,{mode:0o600});
  await writeFile(join(dir,'speechd.conf'),config.speech,{mode:0o600});
  start('pulseaudio',['-n','--daemonize=no','--exit-idle-time=-1','--use-pid-file=no','--log-target=stderr','-F',join(dir,'pulse.pa')]);
  start('speech-dispatcher',['-s','-C',dir,'-S',join(dir,'speech.sock'),'-P',join(dir,'speech.pid'),'-L',dir,'-t','0']);
  const deadline=Date.now()+15000;
  for(;;){
   if(failure)throw failure;
   const ready=await Promise.all(['native.sock','speech.sock'].map(name=>stat(join(dir,name)).then(s=>s.isSocket(),()=>false)));
   if(ready.every(Boolean))break;
   if(Date.now()>=deadline)throw new Error('DESKTOP_AUDIO_START_TIMEOUT');
   await delay(50);
  }
  Object.assign(process.env,config.env);
  return {dir,stop};
 } catch(error){await stop();throw error;}
}
