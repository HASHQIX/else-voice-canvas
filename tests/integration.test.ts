import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'else-test-'));
process.env.DATABASE_PATH=path.join(directory,'test.sqlite');
process.env.SESSION_SECRET='integration-secret-that-is-not-a-real-credential';
process.env.DAILY_BUDGET_USD='100';
process.env.OPENAI_API_KEY='fake-test-key';
process.env.LLM_PROVIDER='anthropic';
process.env.VECTRUST_API_KEY='fake-test-key';
process.env.ANTHROPIC_BASE_URL='https://api.openai-next.com';
process.env.ASSEMBLYAI_API_KEY='fake-test-key';
process.env.NODE_ENV='test';
let app:any,store:any,budget:any,cookie='',project:any,clientId='test-editor',llmCalls=0,ttsCalls=0;
let transform:(plan:any,input:any)=>any=(plan)=>plan;
let malformed=false, guestCounter=0;
function makePlan(input:any){
 const {text,currentTurnId,snapshot}=input;
 const root=Object.values(snapshot.nodes).find((n:any)=>n.kind==='idea') as any;
 return {language:'en',intent:'develop',statements:[{ref:'idea',targetId:root.logicalId,kind:'idea',domain:'idea',title:'A visual concept tool',body:text,disposition:'selected',sourceRefs:[{turnId:currentTurnId,quote:text}],requestedLock:null}],links:[],issues:[],branchIntent:null,question:{ref:'question',targetRef:'idea',prompt:'Who first uses the tool in the studio?',reason:'Choose the first user.',options:[{ref:'designer',label:'Designer',meaning:'The designer prepares concepts'},{ref:'director',label:'Art director',meaning:'The art director evaluates concepts'}]},assistantText:'Who first uses the tool in the studio?',focusRef:'question'};
}
beforeAll(async()=>{store=await import('../server/db.js');budget=await import('../server/budget.js');const {buildApp}=await import('../server/index.js');app=await buildApp();await app.ready();});
afterAll(async()=>{vi.unstubAllGlobals();await app.close();store.db.close();fs.rmSync(directory,{recursive:true,force:true});});
beforeEach(async()=>{
 llmCalls=0;ttsCalls=0;malformed=false;transform=plan=>plan;
 vi.stubGlobal('fetch',vi.fn(async(url:string,options:any)=>{
  if(url.endsWith('/audio/speech')){ttsCalls++;return new Response(new Uint8Array([0,0,1,0]),{headers:{'content-type':'audio/pcm'}});}
  llmCalls++;const body=JSON.parse(options.body);expect(url).toBe('https://api.openai-next.com/v1/messages');expect(options.headers['x-api-key']).toBe('fake-test-key');expect(options.headers['anthropic-version']).toBe('2023-06-01');expect(body.model).toBe('claude-opus-5-5');expect(body.response_format).toBeUndefined();expect(body.system).toContain('supplied structured response schema');expect(body.tools[0].input_schema.type).toBe('object');expect(body.system).not.toContain(JSON.stringify(body.tools[0].input_schema));
  const input=JSON.parse(body.messages[0].content).context;
  return new Response(JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:malformed?'not JSON':JSON.stringify(transform(makePlan(input),input))}]}),{headers:{'content-type':'application/json'}});
 }));
 const guest=await app.inject({method:'POST',url:'/api/guest',remoteAddress:`127.0.0.${++guestCounter}`,payload:{}});cookie=guest.headers['set-cookie'].split(';')[0];
 const result=await app.inject({method:'POST',url:'/api/projects',headers:{cookie},payload:{title:'ELSE test',language:'en'}});expect(result.statusCode).toBe(201);project=result.json();
 await app.inject({method:'POST',url:`/api/projects/${project.id}/lease`,headers:{cookie},payload:{clientId}});
});
const current=()=>store.getProject(store.db.prepare('SELECT owner_id FROM projects WHERE id=?').get(project.id).owner_id,project.id);
const branch=()=>current().branches.find((b:any)=>b.is_main);
const command=async(type:string,payload:any={},extra:any={})=>app.inject({method:'POST',url:`/api/projects/${project.id}/commands`,headers:{cookie,'x-else-client-id':clientId},payload:{type,payload,clientId,branchId:branch().id,expectedRevision:branch().revision,operationId:crypto.randomUUID(),...extra}});
const turn=async(extra:any={})=>app.inject({method:'POST',url:`/api/projects/${project.id}/text-turns`,headers:{cookie,'x-else-client-id':clientId},payload:{text:'I want a concept tool for small studios.',language:'en',branchId:branch().id,expectedRevision:branch().revision,operationId:crypto.randomUUID(),muted:true,clientId,...extra}});

describe('persisted final pipeline and security',()=>{
 it('exports an immutable owner-only report with full speech and deletes it with its conversation',async()=>{
  const ownerId=store.db.prepare('SELECT owner_id FROM projects WHERE id=?').get(project.id).owner_id;
  const session=store.createSession(ownerId,project.id,branch().id);
  const words='Complete transcript with no export cutoff. '.repeat(200);
  store.saveSpeechSegment(ownerId,project.id,session.id,'0',words,true,'B');
  const snapshot=branch().snapshot;
  snapshot.field={focusId:'topic',cells:{topic:{id:'topic',x:0,y:0,title:'Photoshoot',summary:'Friday is confirmed.',question:'',visited:true}},plan:{title:'Autumn photoshoot',summary:'A Friday shoot.',decisions:[{text:'Friday confirmed.',sourceQuote:'Friday confirmed'}],nextSteps:[],openQuestions:['What is the budget?']}};
  store.db.prepare('UPDATE branches SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot),branch().id);
  const created=await app.inject({method:'POST',url:`/api/projects/${project.id}/reports`,headers:{cookie},payload:{}});
  expect(created.statusCode).toBe(201);
  const {id,url}=created.json();expect(url).toBe(`/report/${id}`);
  const read=()=>app.inject({url:`/api/reports/${id}`,headers:{cookie}});
  const before=await read();expect(before.headers['cache-control']).toBe('private, no-store');
  expect(before.json().report).toMatchObject({title:'Autumn photoshoot',decisions:['Friday confirmed.'],openQuestions:['What is the budget?'],inProgress:true,transcript:[{text:words,speaker:'B',sessionId:session.id}]});
  store.saveSpeechSegment(ownerId,project.id,session.id,'0','Later correction',true);
  await app.inject({method:'POST',url:'/api/projects',headers:{cookie},payload:{title:'New conversation'}});
  expect((await read()).json()).toEqual(before.json());
  const guest=await app.inject({method:'POST',url:'/api/guest',remoteAddress:`127.0.0.${++guestCounter}`,payload:{}});
  const other=guest.headers['set-cookie'].split(';')[0];
  expect((await app.inject({url:`/api/reports/${id}`})).statusCode).toBe(401);
  expect((await app.inject({url:`/api/reports/${id}`,headers:{cookie:other}})).statusCode).toBe(404);
  expect((await app.inject({method:'POST',url:`/api/projects/${project.id}/reports`,headers:{cookie:other},payload:{}})).statusCode).toBe(404);
  await app.inject({method:'DELETE',url:`/api/projects/${project.id}`,headers:{cookie}});
  expect((await read()).statusCode).toBe(404);
 });
 it('does not create a report for an empty conversation',async()=>{
  const result=await app.inject({method:'POST',url:`/api/projects/${project.id}/reports`,headers:{cookie},payload:{}});
  expect(result.statusCode).toBe(400);expect(result.json().error).toBe('empty_conversation');
 });
 it('stores full speech across sessions and restricts transcript history to its owner',async()=>{
  const ownerId=store.db.prepare('SELECT owner_id FROM projects WHERE id=?').get(project.id).owner_id;
  const one=store.createSession(ownerId,project.id,branch().id),two=store.createSession(ownerId,project.id,branch().id);
  const words='Complete speech without a display-length cutoff. '.repeat(20);
  store.saveSpeechSegment(ownerId,project.id,one.id,'0','Complete speech',false,'UNKNOWN');
  store.saveSpeechSegment(ownerId,project.id,one.id,'0',words,true,'A');
  store.saveSpeechSegment(ownerId,project.id,one.id,'0','Stale partial',false,'UNKNOWN');
  store.saveSpeechSegment(ownerId,project.id,two.id,'0','Another sentence after resuming.',true,'B');
  const history=await app.inject({url:`/api/projects/${project.id}/transcript`,headers:{cookie}});
  expect(history.json().segments.map((segment:any)=>segment.text)).toEqual([words,'Another sentence after resuming.']);
  expect(history.json().segments.map((segment:any)=>segment.speaker)).toEqual(['A','B']);
  expect(history.json().segments.map((segment:any)=>segment.sessionId)).toEqual([one.id,two.id]);
  expect(store.speechContextFor(ownerId,project.id,`${one.id}:0`).map((segment:any)=>segment.text)).toEqual([words]);
  const stranger=await app.inject({method:'POST',url:'/api/guest',remoteAddress:`127.0.0.${++guestCounter}`,payload:{}});
  const denied=await app.inject({url:`/api/projects/${project.id}/transcript`,headers:{cookie:stranger.headers['set-cookie'].split(';')[0]}});
  expect(denied.statusCode).toBe(404);
  expect((await app.inject({url:`/api/projects/${project.id}/transcript`})).statusCode).toBe(401);
  await app.inject({method:'DELETE',url:`/api/projects/${project.id}`,headers:{cookie}});
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM speech_segments WHERE project_id=?').get(project.id).count).toBe(0);
 });
 it('saves validated final + question; D10 restores server snapshot; D14 mute never calls TTS',async()=>{
  const result=await turn();expect(result.statusCode,result.body).toBe(200);const data=result.json();expect(data.snapshot.revision).toBe(1);expect(data.snapshot.pendingQuestionId).toBeTruthy();expect(llmCalls).toBe(1);expect(ttsCalls).toBe(0);expect(data.replyId).toBeNull();
  const restored=await app.inject({method:'GET',url:`/api/projects/${project.id}`,headers:{cookie}});expect(restored.json().branches[0].snapshot).toEqual(data.snapshot);
 });
 it('B09 repeats a command without another transaction',async()=>{
  const operationId=crypto.randomUUID(),root=Object.keys(branch().snapshot.nodes)[0];
  const a=await command('edit_node',{nodeId:root,title:'Changed',body:'Changed idea'},{operationId,expectedRevision:0});
  const b=await command('edit_node',{nodeId:root,title:'Changed',body:'Changed idea'},{operationId,expectedRevision:0});
  expect(a.statusCode,a.body).toBe(200);expect(b.json()).toEqual(a.json());expect(branch().revision).toBe(1);
 });
 it('B05 rejects an old manual revision; B06 undo/redo increase revisions',async()=>{
  const root=Object.keys(branch().snapshot.nodes)[0];await command('edit_node',{nodeId:root,body:'updated'});
  expect((await command('edit_node',{nodeId:root,body:'stale'},{expectedRevision:0})).statusCode).toBe(409);
  const undone=await command('undo');expect(undone.json().snapshot.revision).toBe(2);expect(undone.json().snapshot.nodes[root].body).toBe('');
  const redone=await command('redo');expect(redone.json().snapshot.revision).toBe(3);expect(redone.json().snapshot.nodes[root].body).toBe('updated');
 });
 it('B01/B02/B10 fork snapshots retain independent content and main can switch',async()=>{
  const root=Object.keys(branch().snapshot.nodes)[0];await command('edit_node',{nodeId:root,body:'Subscription'});
  const source=branch().id;const alternative=(await command('create_branch',{label:'Per project',forkNodeId:root})).json().snapshot;
  await command('edit_node',{nodeId:root,body:'Parent changed'});
  expect(current().branches.find((b:any)=>b.id===alternative.branchId).snapshot.nodes[root].body).toBe('Subscription');
  const switched=await command('switch_branch',{branchId:alternative.branchId});expect(switched.json().snapshot.branchId).toBe(alternative.branchId);
  await command('set_main',{branchId:alternative.branchId});expect(branch().id).toBe(alternative.branchId);expect(current().branches.find((b:any)=>b.id===source)).toBeTruthy();
 });
 it('D13 invalid quotes repair once and leave graph unchanged',async()=>{
  transform=plan=>{plan.statements[0].sourceRefs[0].quote='never said';return plan;};
  const result=await turn();expect(result.statusCode).toBe(422);expect(llmCalls).toBe(2);expect(branch().revision).toBe(0);expect(store.db.prepare('SELECT COUNT(*) n FROM transcripts WHERE project_id=?').get(project.id).n).toBe(1);
 });
 it('D02 malformed JSON repair is bounded and atomic',async()=>{malformed=true;const result=await turn();expect(result.statusCode).toBe(422);expect(llmCalls).toBe(2);expect(branch().revision).toBe(0);});
 it('B07 locked root cannot be bypassed with null targetId',async()=>{
  const root=Object.keys(branch().snapshot.nodes)[0];await command('set_locked',{nodeId:root,locked:true});transform=plan=>{plan.statements[0].targetId=null;return plan;};const result=await turn();expect(result.statusCode).toBe(422);expect(branch().snapshot.nodes[root].body).toBe('');
 });
 it('D05 forged cookies and another owner cannot read projects or audio',async()=>{
  const guest=await app.inject({method:'POST',url:'/api/guest',remoteAddress:`127.0.0.${++guestCounter}`,payload:{}});const otherCookie=guest.headers['set-cookie'].split(';')[0];
  expect((await app.inject({url:`/api/projects/${project.id}`,headers:{cookie:otherCookie}})).statusCode).toBe(404);
  expect((await app.inject({url:`/api/projects/${project.id}`,headers:{cookie:'else_owner=forged'}})).statusCode).toBe(401);
  const data=(await turn({muted:false})).json();expect(data.replyId).toBeTruthy();expect(ttsCalls).toBe(0);
  expect((await app.inject({url:`/api/replies/${data.replyId}/audio`,headers:{cookie:otherCookie}})).statusCode).toBe(404);expect(ttsCalls).toBe(0);
 });
 it('D12 deletion cascades and old export/project IDs fail',async()=>{
  await turn();expect((await app.inject({url:`/api/projects/${project.id}/export`,headers:{cookie}})).statusCode).toBe(200);
  expect((await app.inject({method:'DELETE',url:`/api/projects/${project.id}`,headers:{cookie}})).statusCode).toBe(200);
  expect((await app.inject({url:`/api/projects/${project.id}`,headers:{cookie}})).statusCode).toBe(404);
  expect(store.db.prepare('SELECT COUNT(*) n FROM transcripts WHERE project_id=?').get(project.id).n).toBe(0);
 });
 it('rejects hostile origins before mutation',async()=>{expect((await app.inject({method:'POST',url:'/api/projects',headers:{cookie,origin:'https://attacker.example'},payload:{title:'bad'}})).statusCode).toBe(403);});
 it('opens AssemblyAI sessions without consuming the LLM budget',async()=>{
  const previous=process.env.DAILY_LLM_BUDGET_USD;
  try{
   process.env.DAILY_LLM_BUDGET_USD='0.01';
   store.db.prepare('DELETE FROM budget_reservations').run();
   budget.reserveBudget(0.01,'final');
   const before=budget.budgetStatus().reservedUsd;
   const result=await app.inject({method:'POST',url:`/api/projects/${project.id}/sessions`,headers:{cookie},payload:{clientId,branchId:branch().id}});
   expect(result.statusCode,result.body).toBe(201);
   expect(budget.budgetStatus().reservedUsd).toBe(before);
  }finally{
   if(previous===undefined)delete process.env.DAILY_LLM_BUDGET_USD;else process.env.DAILY_LLM_BUDGET_USD=previous;
  }
 });
});

describe('blind spot pivot', () => {
 it('persists nine cells, moves voice-selected focus, fills only new space, restores and undoes the camera', async () => {
  transform = (plan, input) => ({ ...plan, statements: [], links: [], issues: [], question: null, assistantText: '', focusRef: null,
   field: { updates: [], targetId: null, title: 'Photoshoot planning', summary: 'Planning a photoshoot.', sourceQuote: input.text,
    plan: {title:'Photoshoot plan',summary:'Planning a photoshoot.',decisions:[],nextSteps:[],openQuestions:['Who will model?']},
    neighbors: ['Model booking','Studio','Budget','Dates','Usage rights','Creative direction','Crew','Contingencies'].map(title => ({ title, question: `What do we need to clarify about ${title.toLowerCase()}?` })) } });
  const first = await turn({ text: 'We are planning a photoshoot.' });
  expect(first.statusCode, first.body).toBe(200);
  const original = first.json().snapshot.field;
  expect(Object.keys(original.cells)).toHaveLength(9);
  const model = Object.values(original.cells).find((cell: any) => cell.title === 'Model booking') as any;
  transform = (plan, input) => {
   expect(input.conversationField.focusId).toBe(original.focusId);
   expect(input.conversationField.plan).toEqual(original.plan);
   expect(input.conversationField.cells.find((cell: any) => cell.id === model.id).vacancies).toBe(5);
   return { ...plan, statements: [], links: [], issues: [], question: null, assistantText: '', focusRef: null,
    field: { updates: [], targetId: model.id, title: 'Model booking', summary: 'Two models are needed.', sourceQuote: input.text,
     plan: {title:'Photoshoot plan',summary:'A photoshoot with two models.',decisions:[{text:'Two models are needed.',sourceQuote:'book two models'}],nextSteps:[{text:'Book two models.',sourceQuote:'book two models'}],openQuestions:['Are both models available?']},
     neighbors: ['Availability','Agency','Rates','Releases','Backup models'].map(title => ({ title, question: `What about ${title.toLowerCase()}?` })) } };
  };
  const second = await turn({ text: 'Now let us book two models.' });
  expect(second.statusCode, second.body).toBe(200);
  const moved = second.json().snapshot.field;
  expect(moved.plan.nextSteps).toEqual([{text:'Book two models.',sourceQuote:'book two models'}]);
  expect(moved.focusId).toBe(model.id);
  expect(Object.keys(moved.cells)).toHaveLength(14);
  for (const cell of Object.values(original.cells) as any[]) expect(moved.cells[cell.id]).toMatchObject({ x: cell.x, y: cell.y });
  const restored = (await app.inject({ url: `/api/projects/${project.id}`, headers: { cookie } })).json().branches[0].snapshot.field;
  expect(restored).toEqual(moved);
  expect((await command('undo')).json().snapshot.field).toEqual(original);
  expect((await command('redo')).json().snapshot.field).toEqual(moved);
 });
 it('rejects a field with missing questions after one repair without saving a partial grid', async () => {
  transform = (plan, input) => ({ ...plan, field: { updates: [], targetId: null, title: 'Photoshoot', summary: 'Planning a shoot.', sourceQuote: input.text, neighbors: [] } });
  const result = await turn();
  expect(result.statusCode, result.body).toBe(422);
  expect(llmCalls).toBe(2);
  expect(branch().snapshot.field).toBeUndefined();
  expect(branch().revision).toBe(0);
 });
});

it('can cancel an unopened voice session and immediately start another',async()=>{
 const first=(await app.inject({method:'POST',url:`/api/projects/${project.id}/sessions`,headers:{cookie},payload:{clientId,branchId:branch().id}})).json();
 const cancelled=await app.inject({method:'DELETE',url:`/api/sessions/${first.id}`,headers:{cookie}});
 expect(cancelled.statusCode,cancelled.body).toBe(200);
 const second=await app.inject({method:'POST',url:`/api/projects/${project.id}/sessions`,headers:{cookie},payload:{clientId,branchId:branch().id}});
 expect(second.statusCode,second.body).toBe(201);
 await app.inject({method:'DELETE',url:`/api/sessions/${second.json().id}`,headers:{cookie}});
});

it.each([true,false])('validates compact Gemini neighbor counts before saving (repair succeeds: %s)',async(repairSucceeds)=>{
 vi.stubEnv('LLM_PROVIDER','openrouter');
 vi.stubEnv('OPENROUTER_API_KEY','router-test-credential');
 vi.stubEnv('LLM_MODEL','google/gemini-3.8-flash');
 vi.stubGlobal('fetch',vi.fn(async(_url:string,options:any)=>{
  llmCalls++;
  const body=JSON.parse(options.body),input=JSON.parse(body.messages[1].content).context;
  expect(body.response_format.json_schema.schema.properties.field.anyOf).toHaveLength(2);
  const count=llmCalls===2&&repairSucceeds?8:7;
  const field={targetId:null,title:'Shoot planning',summary:'Plan a shoot.',sourceQuote:input.text,updates:[],plan:{title:'Shoot planning',summary:'Plan a shoot.',decisions:[],nextSteps:[],openQuestions:[]},neighbors:Array.from({length:count},(_,i)=>({title:`Question ${i}`,question:'What needs clarifying?'}))};
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({field})}}]}));
 }));
 try {
  const result=await turn();
  expect(llmCalls).toBe(2);
  expect(result.statusCode).toBe(repairSucceeds?200:422);
  expect(branch().revision).toBe(repairSucceeds?1:0);
  if(repairSucceeds)expect(Object.keys(branch().snapshot.field.cells)).toHaveLength(9);
  else expect(branch().snapshot.field).toBeUndefined();
 } finally {vi.unstubAllEnvs();}
});

it.each(['openai','openrouter'])('normalizes and persists the narrow field response through %s',async(provider)=>{
 vi.stubEnv('LLM_PROVIDER',provider);
 vi.stubEnv('OPENROUTER_API_KEY','fake-router-test-key');
 vi.stubEnv('LLM_MODEL','google/gemini-3.8-flash');
 vi.stubGlobal('fetch',vi.fn(async(url:string,options:any)=>{
  const body=JSON.parse(options.body),input=JSON.parse((provider==='openrouter'?body.messages:body.input)[1].content).context;
  const format=provider==='openrouter'?body.response_format.json_schema:body.text.format;
  expect(format.strict).toBe(true);
  expect(format.schema.required).toEqual(['field']);
  if(provider==='openrouter'){
   expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
   expect(options.headers.Authorization).toBe('Bearer fake-router-test-key');
   expect(body.model).toBe('google/gemini-3.8-flash');
  }
  const field={targetId:null,title:'Conversation planning',summary:input.text,sourceQuote:input.text,updates:[],plan:{title:'Conversation planning',summary:input.text,decisions:[],nextSteps:[],openQuestions:[]},neighbors:Array.from({length:8},(_,i)=>({title:`Angle ${i+1}`,question:`What should we clarify for angle ${i+1}?`}))};
  return new Response(JSON.stringify(provider==='openrouter'
   ?{choices:[{finish_reason:'stop',message:{content:JSON.stringify({field})}}]}
   :{output:[{content:[{type:'output_text',text:JSON.stringify({field})}]}]}));
 }));
 try{
  const result=await turn();expect(result.statusCode,result.body).toBe(200);
  expect(Object.keys(result.json().snapshot.field.cells)).toHaveLength(9);
  expect(result.json().plan.statements).toEqual([]);
  const restored=await app.inject({url:`/api/projects/${project.id}`,headers:{cookie}});
  expect(restored.json().branches[0].snapshot.field).toEqual(result.json().snapshot.field);
 }finally{vi.unstubAllEnvs();}
});
