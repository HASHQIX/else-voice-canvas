import WebSocket from 'ws';
import fs from 'node:fs';
import { finalSchema, previewSchema, DomainError } from './validation.js';
import { reserveBudget } from './budget.js';
const env=(key:string,fallback='')=>process.env[key]||fallback;
const llmProvider=()=>env('LLM_PROVIDER','anthropic').toLowerCase();
const llmKey=()=>llmProvider()==='anthropic'?env('VECTRUST_API_KEY'):env('OPENAI_API_KEY');
export const providerStatus=()=>({assemblyai:Boolean(env('ASSEMBLYAI_API_KEY')),llm:Boolean(llmKey()),llmProvider:llmProvider(),openai:Boolean(env('OPENAI_API_KEY')),tts:Boolean(env('OPENAI_API_KEY')),budgetConfigured:Number(env('DAILY_LLM_BUDGET_USD',env('DAILY_BUDGET_USD')))>0});
export function requireProviders(voice=false){const status=providerStatus();if(!status.llm||voice&&!status.assemblyai)throw new DomainError('provider_unavailable','Voice and AI are awaiting server provider configuration',503);if(!status.budgetConfigured)throw new DomainError('budget_unconfigured','AI budget has not been configured',503);}
const prompt=(name:string)=>fs.readFileSync(`PLAN/prompts/${name}-system.md`,'utf8').replaceAll('FORK','ELSE');
export async function structuredResponse(kind:'preview'|'final',input:unknown,signal?:AbortSignal,repair?:{proposal:any;errors:string}){
 requireProviders();reserveBudget(kind==='preview'?0.01:0.06,kind);
 const timeout=AbortSignal.timeout(25000),signals=signal?AbortSignal.any([signal,timeout]):timeout;
 const schema=kind==='preview'?previewSchema:finalSchema;
 const toolName=`else_${kind}`;
 const system=`${prompt(repair?'repair':kind)}\n\nUse the required ${toolName} tool exactly once. The tool input is the only response; do not write prose or markdown. It must conform to this JSON Schema (the server validates it):\n${JSON.stringify(schema)}${kind==='final'?`\nFor every selected statement based on the current user turn, include a sourceRefs entry with the currentTurnId and an exact quote from the current user text.`:''}${repair?`\n\nPrevious proposal and validation errors to repair:\n${JSON.stringify(repair)}`:''}`;
 const response=llmProvider()==='anthropic'
  ?await fetch(`${env('ANTHROPIC_BASE_URL','https://api.openai-next.com').replace(/\/$/,'')}${env('ANTHROPIC_BASE_URL','').replace(/\/$/,'').endsWith('/v1')?'':'/v1'}/messages`,{method:'POST',signal:signals,headers:{'x-api-key':env('VECTRUST_API_KEY'),'anthropic-version':'2023-06-01','Content-Type':'application/json'},body:JSON.stringify({model:env('LLM_MODEL','claude-opus-5-5'),system,max_tokens:kind==='preview'?600:3500,tools:[{name:toolName,description:`Return the ${kind} object matching the supplied schema.`,input_schema:schema}],tool_choice:{type:'tool',name:toolName},messages:[{role:'user',content:JSON.stringify({context:input,...(repair||{})})}]})})
  :await fetch(`${env('OPENAI_BASE_URL','https://api.openai.com/v1').replace(/\/$/,'')}/responses`,{method:'POST',signal:signals,headers:{Authorization:`Bearer ${env('OPENAI_API_KEY')}`,'Content-Type':'application/json'},body:JSON.stringify({model:env('OPENAI_LLM_MODEL','gpt-4.1-mini-2025-04-14'),store:false,max_output_tokens:kind==='preview'?600:3500,input:[{role:'system',content:system},{role:'user',content:JSON.stringify({context:input,...(repair||{})})}],text:{format:{type:'json_schema',name:`else_${kind}`,strict:true,schema}}})});
 if(!response.ok)throw new DomainError('provider_error',`Analysis service returned ${response.status}`,502);
 const data:any=await response.json();if(data.stop_reason==='max_tokens'||data.status==='incomplete'||data.status==='failed')throw new DomainError('provider_incomplete','Analysis was incomplete; your transcript is retained',502);
 if(data.stop_reason==='refusal'||data.type==='error')throw new DomainError('provider_refusal','Analysis could not be generated for this request',422);
 const parts=data.content||data.output?.flatMap((o:any)=>o.content||[])||[];
 const tool=Array.isArray(parts)?parts.find((c:any)=>c.type==='tool_use'&&c.name===toolName):null;
 if(tool&&tool.input&&typeof tool.input==='object')return tool.input;
 const output=Array.isArray(parts)?parts.filter((c:any)=>c.type==='text'||c.type==='output_text').map((c:any)=>c.text).join(''):'';
 if(!output)throw new DomainError('provider_empty','Analysis returned no output',502);
 try{return JSON.parse(output);}catch{const start=output.indexOf('{'),end=output.lastIndexOf('}');if(start>=0&&end>start){try{return JSON.parse(output.slice(start,end+1));}catch{}}throw new DomainError('invalid_plan','Analysis returned invalid JSON',422);}
}
export const generatePreview=(text:string,_language:'en'='en',signal?:AbortSignal)=>structuredResponse('preview',{text,language:'en'},signal);
export const generateFinal=(text:string,_language:'en'='en',context:any={},signal?:AbortSignal)=>structuredResponse('final',{text,language:'en',...context},signal);
export async function synthesizeSpeech(text:string,signal?:AbortSignal){requireProviders();if(!env('OPENAI_API_KEY'))throw new DomainError('tts_unavailable','Spoken playback is not configured; the text reply remains available',503);reserveBudget(0.03,'tts');const response=await fetch(`${env('OPENAI_BASE_URL','https://api.openai.com/v1').replace(/\/$/,'')}/audio/speech`,{method:'POST',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${env('OPENAI_API_KEY')}`,'Content-Type':'application/json'},body:JSON.stringify({model:env('OPENAI_TTS_MODEL','gpt-4o-mini-tts'),voice:env('OPENAI_TTS_VOICE','coral'),input:text,response_format:'pcm'})});if(!response.ok||!response.body)throw new DomainError('tts_unavailable',`Speech service returned ${response.status}`,502);return response.body;}
export type ASREvent={text:string;final:boolean;segmentId:string};
export class AssemblyAIStream{
 ws:WebSocket|null=null;ready=false;private beginTimer:ReturnType<typeof setTimeout>|undefined;
 onTranscript:(event:ASREvent)=>void=()=>{};onSpeechStarted:()=>void=()=>{};onReady:(config:any)=>void=()=>{};onError:(error:Error)=>void=()=>{};onClose:()=>void=()=>{};
 connect(){requireProviders(true);const url=new URL(env('ASSEMBLYAI_STT_URL','wss://streaming.assemblyai.com/v3/ws'));url.searchParams.set('speech_model',env('ASSEMBLYAI_STT_MODEL','universal-3-6-pro'));url.searchParams.set('sample_rate','16000');url.searchParams.set('encoding','pcm_s16le');url.searchParams.set('include_partial_turns','true');url.searchParams.set('language_codes','en');this.ws=new WebSocket(url,{headers:{Authorization:env('ASSEMBLYAI_API_KEY')},handshakeTimeout:10000});this.beginTimer=setTimeout(()=>{this.onError(new Error('Recognition startup timed out'));this.close();},12000);
  this.ws.on('message',(raw)=>{try{const message=JSON.parse(raw.toString());if(message.type==='Begin'){if(this.beginTimer)clearTimeout(this.beginTimer);if(message.speech_model&&message.speech_model!==env('ASSEMBLYAI_STT_MODEL','universal-3-6-pro')){this.onError(new Error('Unexpected recognition model'));this.close();return;}this.ready=true;this.onReady(message);}else if(message.type==='SpeechStarted')this.onSpeechStarted();else if(message.type==='Turn')this.onTranscript({text:message.transcript||'',final:Boolean(message.end_of_turn),segmentId:String(message.turn_order)});else if(message.type==='Termination'){this.ready=false;this.ws?.close();}}catch{this.onError(new Error('Invalid recognition event'));}});
  this.ws.on('error',(e)=>this.onError(e));this.ws.on('close',()=>{this.ready=false;this.onClose();});
 }
 sendAudio(data:Buffer){if(data.length>16384)throw new DomainError('audio_too_large','Audio frame exceeds 16 KB',413);if(!this.ready||this.ws?.readyState!==WebSocket.OPEN)return;if(this.ws.bufferedAmount>32000)throw new DomainError('audio_backpressure','Speech network is too slow',429);this.ws.send(data);}
 finish(){if(this.ready)this.ws?.send(JSON.stringify({type:'ForceEndpoint'}));}
 close(){if(this.beginTimer)clearTimeout(this.beginTimer);this.ready=false;if(this.ws?.readyState===WebSocket.OPEN){const socket=this.ws;socket.send(JSON.stringify({type:'Terminate'}));const timer=setTimeout(()=>socket.close(),1000);timer.unref();}else this.ws?.close();}
}
