import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute=promisify(execFile);
export const AUDIO_SEGMENT_SECONDS=30;
// Reject playlists and network protocols. Only ordinary self-contained media
// containers are decoded; downloads themselves still use Patronus network policy.
const inputPolicy=['-protocol_whitelist','file,pipe','-format_whitelist','mov,mp3,wav,flac,ogg,matroska,webm,aac'];
export async function extractAudio(path,{signal,onSegment}={}){
 const options={signal,killSignal:'SIGKILL',maxBuffer:1048576,encoding:'buffer'};
 const {stdout}=await execute('ffprobe',['-v','error',...inputPolicy,'-show_entries','format=duration:stream=codec_type','-of','json',path],options);
 const info=JSON.parse(stdout.toString()),duration=Number(info.format?.duration);
 if(!info.streams?.some(s=>s.codec_type==='audio'))return {available:false,reason:'NO_AUDIO_STREAM'};
 if(!Number.isFinite(duration)||duration<=0)throw Object.assign(Error('Audio duration unavailable'),{code:'AUDIO_DURATION_UNKNOWN'});
 let count=0;
 for(let start=0;start<duration;start+=AUDIO_SEGMENT_SECONDS){
  signal?.throwIfAborted();
  const seconds=Math.min(AUDIO_SEGMENT_SECONDS,duration-start);
  const {stdout:bytes}=await execute('ffmpeg',['-nostdin','-v','error',...inputPolicy,'-ss',String(start),'-i',path,'-t',String(seconds),'-map','0:a:0','-vn','-map_metadata','-1','-ac','2','-ar','44100','-c:a','libmp3lame','-b:a','128k','-f','mp3','pipe:1'],options);
  if(!bytes.length)throw Object.assign(Error('Empty audio'),{code:'AUDIO_EMPTY'});
  await onSegment({bytes,startSeconds:start,durationSeconds:seconds,index:count++});
 }
 return {available:true,durationSeconds:duration,segments:count,mimeType:'audio/mpeg',segmentSeconds:AUDIO_SEGMENT_SECONDS,scope:'Extracted audio, not a transcription or evidence the client/model heard it.'};
}
