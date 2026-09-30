// Synthetic audio only. Run with the project's private env loaded; never logs credentials.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
process.env.DATABASE_PATH = ':memory:';
const { AssemblyAIStream } = await import('../server/providers.ts');
const { db } = await import('../server/db.ts');
function pcm(filename) {
 const buffer=fs.readFileSync(filename);
 assert.equal(buffer.toString('ascii',0,4),'RIFF');
 assert.equal(buffer.toString('ascii',8,12),'WAVE');
 let audio;
 for(let offset=12;offset+8<=buffer.length;){
  const kind=buffer.toString('ascii',offset,offset+4),size=buffer.readUInt32LE(offset+4),start=offset+8;
  if(kind==='fmt '){assert.equal(buffer.readUInt16LE(start),1);assert.equal(buffer.readUInt16LE(start+2),1);assert.equal(buffer.readUInt32LE(start+4),16000);assert.equal(buffer.readUInt16LE(start+14),16);}
  if(kind==='data')audio=buffer.subarray(start,start+size);
  offset=start+size+(size%2);
 }
 assert.ok(audio?.length);return audio;
}
const clips=process.argv.slice(2).map(pcm);
assert.equal(clips.length,2,'Pass two synthetic 16 kHz mono PCM WAV files');
const stream=new AssemblyAIStream(),events=[];
let rejectRun;
const failure=new Promise((_,reject)=>{rejectRun=reject;});
stream.onError=()=>rejectRun(new Error('Synthetic diarization stream failed'));
stream.onTranscript=event=>events.push(event);
const timer=setTimeout(()=>rejectRun(new Error('Synthetic diarization stream timed out')),65000);
try {
 await Promise.race([failure,new Promise(resolve=>{stream.onReady=resolve;stream.connect();})]);
 const audio=Buffer.concat([clips[0],Buffer.alloc(64000),clips[1],Buffer.alloc(64000),clips[0],Buffer.alloc(64000),clips[1],Buffer.alloc(64000)]);
 await Promise.race([failure,(async()=>{for(let offset=0;offset<audio.length;offset+=1600){stream.sendAudio(audio.subarray(offset,offset+1600));await delay(50);}stream.finish();await delay(1800);})()]);
 const corrected=[...new Map(events.filter(event=>event.final).map(event=>[event.segmentId,event])).values()];
 const speakers=[...new Set(corrected.map(event=>event.speaker).filter(label=>label&&label!=='UNKNOWN'))];
 fs.writeFileSync('validation/speaker-live-result.json',JSON.stringify({synthetic:true,model:process.env.ASSEMBLYAI_STT_MODEL||'universal-3-6-pro',speakers,turns:corrected},null,2)+'\n');
 assert.ok(speakers.length>=2,'The two synthetic voices should receive different speaker labels');
 console.log(JSON.stringify({synthetic:true,speakers,finalTurns:corrected.length}));
} finally {clearTimeout(timer);stream.close();await delay(1100);db.close();}
