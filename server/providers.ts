import WebSocket from 'ws';
import fs from 'node:fs';
import { finalSchema, previewSchema, DomainError } from './validation.js';
import { reserveBudget } from './budget.js';
import { fieldModelSchema, asFinalPlan } from './field-schema.js';
import { fastSchema, initialFastSchema, recapSchema } from './fast-schema.js';
import { normalizeSpeaker } from '../shared/transcript.js';
const env=(key:string,fallback='')=>process.env[key]||fallback;
const llmProvider=()=>env('LLM_PROVIDER','openrouter').toLowerCase();
const llmKey=()=>{
 switch(llmProvider()){
  case 'openrouter':return env('OPENROUTER_API_KEY');
  case 'anthropic':return env('VECTRUST_API_KEY');
  case 'openai':return env('OPENAI_API_KEY');
  default:return '';
 }
};
const llmModel=()=>llmProvider()==='openai'?env('OPENAI_LLM_MODEL','gpt-4.1-mini-2025-04-14'):env('LLM_MODEL',llmProvider()==='openrouter'?'google/gemini-3.8-flash':'claude-opus-5-5');
export const providerStatus=()=>({assemblyai:Boolean(env('ASSEMBLYAI_API_KEY')),llm:Boolean(llmKey()),llmProvider:llmProvider(),llmModel:llmModel(),openai:Boolean(env('OPENAI_API_KEY')),tts:Boolean(env('OPENAI_API_KEY')),budgetConfigured:Number(env('DAILY_LLM_BUDGET_USD',env('DAILY_BUDGET_USD')))>0});
export function requireProviders(voice=false){const status=providerStatus();if(!status.llm||voice&&!status.assemblyai)throw new DomainError('provider_unavailable','Voice and AI are awaiting server provider configuration',503);if(!status.budgetConfigured)throw new DomainError('budget_unconfigured','AI budget has not been configured',503);}
const prompt=(name:string)=>fs.readFileSync(`PLAN/prompts/${name}-system.md`,'utf8').replaceAll('FORK','ELSE');
export async function structuredResponse(kind:'preview'|'final'|'fast'|'recap',input:unknown,signal?:AbortSignal,repair?:{proposal:any;errors:string}){
 requireProviders();reserveBudget(kind==='preview'?0.01:0.06,kind);
 const timeout=AbortSignal.timeout(25000),signals=signal?AbortSignal.any([signal,timeout]):timeout;
 const fieldInput=kind==='final'?(input as any)?.conversationField:undefined;
 const initialField=kind==='fast'&&(input as any)?.conversationField?.isInitial===true;
 const compactField=llmProvider()==='openrouter'&&llmModel().startsWith('google/');
 const schema=kind==='fast'?(initialField?initialFastSchema:fastSchema):kind==='recap'?recapSchema:kind==='preview'?previewSchema:fieldInput?fieldModelSchema(fieldInput,{compact:compactField}):finalSchema;
 const normalize=(value:any)=>fieldInput?asFinalPlan(value):value;
 const toolName=`else_${kind}`;
 const outputInstruction=llmProvider()==='anthropic'
  ?`Use the required ${toolName} tool exactly once. The tool input is the only response; do not write prose or markdown.`
  :'Return only a JSON object; do not write prose or markdown.';
 const system=`${prompt(kind)+(repair?'\n'+prompt('repair'):'')}\n\n${outputInstruction} Conform to the supplied structured response schema.${kind==='final'?`\nFor selected statements from the current turn, include currentTurnId and an exact quote.`:''}`;
 const maxTokens=kind==='preview'?600:kind==='fast'?(initialField?1800:1200):kind==='recap'?2400:fieldInput?4000:4500;
 const response=await (async()=>llmProvider()==='anthropic'
  ?await fetch(`${env('ANTHROPIC_BASE_URL','https://api.openai-next.com').replace(/\/$/,'')}${env('ANTHROPIC_BASE_URL','').replace(/\/$/,'').endsWith('/v1')?'':'/v1'}/messages`,{method:'POST',signal:signals,headers:{'x-api-key':env('VECTRUST_API_KEY'),'anthropic-version':'2023-06-01','Content-Type':'application/json'},body:JSON.stringify({model:env('LLM_MODEL','claude-opus-5-5'),system,max_tokens:maxTokens,tools:[{name:toolName,description:`Return the ${kind} object matching the supplied schema.`,input_schema:schema}],tool_choice:{type:'tool',name:toolName},messages:[{role:'user',content:JSON.stringify({context:input,...(repair||{})})}]})})
  :llmProvider()==='openrouter'
  ?await fetch(`${env('OPENROUTER_BASE_URL','https://openrouter.ai/api/v1').replace(/\/$/,'')}/chat/completions`,{
   method:'POST',signal:signals,
   headers:{Authorization:`Bearer ${env('OPENROUTER_API_KEY')}`,'Content-Type':'application/json'},
   body:JSON.stringify({
    model:llmModel(),stream:false,max_tokens:maxTokens,
    messages:[{role:'system',content:system},{role:'user',content:JSON.stringify({context:input,...(repair||{})})}],
    response_format:{type:'json_schema',json_schema:{name:toolName,strict:true,schema}},
    provider:{require_parameters:true},reasoning:{effort:'low',exclude:true},
   }),
  })
  :await fetch(`${env('OPENAI_BASE_URL','https://api.openai.com/v1').replace(/\/$/,'')}/responses`,{method:'POST',signal:signals,headers:{Authorization:`Bearer ${env('OPENAI_API_KEY')}`,'Content-Type':'application/json'},body:JSON.stringify({model:env('OPENAI_LLM_MODEL','gpt-4.1-mini-2025-04-14'),store:false,max_output_tokens:maxTokens,input:[{role:'system',content:system},{role:'user',content:JSON.stringify({context:input,...(repair||{})})}],text:{format:{type:'json_schema',name:`else_${kind}`,strict:true,schema}}})}))().catch(error=>{if(signal?.aborted)throw error;if(timeout.aborted)throw new DomainError('provider_timeout','Analysis took too long. Your last words are retained; keep talking or retry.',504);throw new DomainError('provider_unavailable','The analysis service could not be reached. Your last words are retained.',502);});
 if(!response.ok)throw new DomainError('provider_error',`Analysis service returned ${response.status}`,502);
 let data:any;try{data=await response.json();}catch(error){if(signal?.aborted)throw error;if(timeout.aborted)throw new DomainError('provider_timeout','Analysis took too long. Your last words are retained; keep talking or retry.',504);throw new DomainError('provider_error','Analysis returned an unreadable response. Your last words are retained.',502);}
 if(!data||typeof data!=='object'||Array.isArray(data))throw new DomainError('provider_error','Analysis returned an unreadable response. Your last words are retained.',502);
 if(data.stop_reason==='max_tokens'||data.status==='incomplete'||data.status==='failed')throw new DomainError('provider_incomplete','Analysis was incomplete; your transcript is retained',502);
 const choice=llmProvider()==='openrouter'?data.choices?.[0]:undefined;
 if(data.error||choice?.error||choice?.finish_reason==='error')throw new DomainError('provider_error','Analysis service could not complete this request. Your last words are retained.',502);
 if(choice?.finish_reason==='length')throw new DomainError('provider_incomplete','Analysis was incomplete; your transcript is retained',502);
 if(data.stop_reason==='refusal'||data.type==='error'||choice?.finish_reason==='content_filter'||choice?.message?.refusal)throw new DomainError('provider_refusal','Analysis could not be generated for this request',422);
 const parts=data.content||data.output?.flatMap((o:any)=>o.content||[])||[];
 const tool=Array.isArray(parts)?parts.find((c:any)=>c.type==='tool_use'&&c.name===toolName):null;
 if(tool&&tool.input&&typeof tool.input==='object')return normalize(tool.input);
 const output=llmProvider()==='openrouter'
  ?(typeof choice?.message?.content==='string'?choice.message.content:'')
  :Array.isArray(parts)?parts.filter((c:any)=>c.type==='text'||c.type==='output_text').map((c:any)=>c.text).join(''):'';
 if(!output)throw new DomainError('provider_empty','Analysis returned no output',502);
 try{return normalize(JSON.parse(output));}catch{const start=output.indexOf('{'),end=output.lastIndexOf('}');if(start>=0&&end>start){try{return normalize(JSON.parse(output.slice(start,end+1)));}catch{}}throw new DomainError('invalid_plan','Analysis returned invalid JSON',422);}
}
export const generatePreview=(text:string,_language:'en'='en',signal?:AbortSignal)=>structuredResponse('preview',{text,language:'en'},signal);
export const generateFinal=(text:string,_language:'en'='en',context:any={},signal?:AbortSignal)=>structuredResponse('final',{text,language:'en',...context},signal);
export async function synthesizeSpeech(text:string,signal?:AbortSignal){requireProviders();if(!env('OPENAI_API_KEY'))throw new DomainError('tts_unavailable','Spoken playback is not configured; the text reply remains available',503);reserveBudget(0.03,'tts');const response=await fetch(`${env('OPENAI_BASE_URL','https://api.openai.com/v1').replace(/\/$/,'')}/audio/speech`,{method:'POST',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${env('OPENAI_API_KEY')}`,'Content-Type':'application/json'},body:JSON.stringify({model:env('OPENAI_TTS_MODEL','gpt-4o-mini-tts'),voice:env('OPENAI_TTS_VOICE','coral'),input:text,response_format:'pcm'})});if(!response.ok||!response.body)throw new DomainError('tts_unavailable',`Speech service returned ${response.status}`,502);return response.body;}
export type ASREvent={text:string;final:boolean;segmentId:string;speaker?:string};
export class AssemblyAIStream{
 ws:WebSocket|null=null;ready=false;private beginTimer:ReturnType<typeof setTimeout>|undefined;
 onTranscript:(event:ASREvent)=>void=()=>{};onSpeechStarted:()=>void=()=>{};onReady:(config:any)=>void=()=>{};onError:(error:Error)=>void=()=>{};onClose:()=>void=()=>{};
 connect(){requireProviders(true);const url=new URL(env('ASSEMBLYAI_STT_URL','wss://streaming.assemblyai.com/v3/ws'));url.searchParams.set('speech_model',env('ASSEMBLYAI_STT_MODEL','universal-3-6-pro'));url.searchParams.set('sample_rate','16000');url.searchParams.set('encoding','pcm_s16le');url.searchParams.set('include_partial_turns','true');url.searchParams.set('language_codes','en');url.searchParams.set('speaker_labels','true');this.ws=new WebSocket(url,{headers:{Authorization:env('ASSEMBLYAI_API_KEY')},handshakeTimeout:10000});this.beginTimer=setTimeout(()=>{this.onError(new Error('Recognition startup timed out'));this.close();},12000);
  this.ws.on('message',(raw)=>{try{const message=JSON.parse(raw.toString());if(message.type==='Begin'){if(this.beginTimer)clearTimeout(this.beginTimer);if(message.speech_model&&message.speech_model!==env('ASSEMBLYAI_STT_MODEL','universal-3-6-pro')){this.onError(new Error('Unexpected recognition model'));this.close();return;}this.ready=true;this.onReady(message);}else if(message.type==='SpeechStarted')this.onSpeechStarted();else if(message.type==='Turn')this.onTranscript({text:message.transcript||'',final:Boolean(message.end_of_turn),segmentId:String(message.turn_order),speaker:normalizeSpeaker(message.speaker_label)});else if(message.type==='Termination'){this.ready=false;this.ws?.close();}}catch{this.onError(new Error('Invalid recognition event'));}});
  this.ws.on('error',(e)=>this.onError(e));this.ws.on('close',()=>{this.ready=false;this.onClose();});
 }
 sendAudio(data:Buffer){if(data.length>16384)throw new DomainError('audio_too_large','Audio frame exceeds 16 KB',413);if(!this.ready||this.ws?.readyState!==WebSocket.OPEN)return;if(this.ws.bufferedAmount>32000)throw new DomainError('audio_backpressure','Speech network is too slow',429);this.ws.send(data);}
 finish(){if(this.ready)this.ws?.send(JSON.stringify({type:'ForceEndpoint'}));}
 close(){if(this.beginTimer)clearTimeout(this.beginTimer);this.ready=false;if(this.ws?.readyState===WebSocket.OPEN){const socket=this.ws;socket.send(JSON.stringify({type:'Terminate'}));const timer=setTimeout(()=>socket.close(),1000);timer.unref();}else this.ws?.close();}
}
