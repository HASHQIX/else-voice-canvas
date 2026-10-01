import { chromium } from '@playwright/test';
import { applyField } from '../server/field.ts';
import { buildConversationReport, reportToText } from '../shared/report.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const initial = {
 targetId: null, title: 'Photoshoot planning', summary: 'An editorial shoot for the autumn collection. Let’s work through the details.', sourceQuote: 'an editorial shoot',
 plan: {title:'Autumn photoshoot',summary:'Plan an editorial shoot for the autumn collection. The date and bookings are still open.',decisions:[],nextSteps:[],openQuestions:['What is the total budget?','Is the studio available?']},
 neighbors: [
  ['Model booking', 'Have the models confirmed their availability?'], ['Studio booking', 'Does the space work for your lighting and set?'],
  ['Budget', 'What’s the total budget, including the unexpected?'], ['Dates & timing', 'Are the shoot date and delivery deadline agreed?'],
  ['Usage rights', 'Where will the images appear, and for how long?'], ['Creative direction', 'Does everyone share the same visual reference?'],
  ['Crew & equipment', 'Who’s handling styling, lighting and production?'], ['A backup plan', 'What happens if a model or location falls through?'],
 ].map(([title, question]) => ({title, question})),
};
const field = applyField(undefined, initial, 'test-turn-1');
const model = Object.values(field.cells).find(cell => cell.title === 'Model booking');
const moved = applyField(field, { targetId: model.id, title: model.title, summary: 'Two models for a full-day shoot. Availability is still to be confirmed.', sourceQuote: 'book two models',
 plan: {...initial.plan,summary:'An autumn editorial shoot with two models for a full day. Availability and studio booking still need confirming.',decisions:[{text:'Two models are needed for a full day.',sourceQuote:'book two models for a full day'}],nextSteps:[{text:'Contact the agency about availability.',sourceQuote:'Contact the agency about availability'}],openQuestions:['Are both models available?','Is the studio available?']},
 neighbors: [['Availability','Are both models free for the full day?'],['Agency contact','Who is handling the booking?'],['Day rates','Does the fee include overtime?'],['Model releases','Who will prepare and sign the releases?'],['Backup models','Do we have an alternative if someone cancels?']].map(([title, question]) => ({title,question})) }, 'test-turn-2');
let snapshot = { schemaVersion: 1, projectId:'browser-project', branchId:'browser-branch', revision:0, nodes:{}, navigation:[], dependencies:[], layout:{}, pendingQuestionId:null };
let savedSpeech=[];
const project = () => ({ id:snapshot.projectId,title:'Untitled conversation',branches:[{id:snapshot.branchId,is_main:1,revision:snapshot.revision,label:'Main',snapshot}] });
const browser = await chromium.launch({ headless:true, channel:'chrome', args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required'] });
try {
 const context = await browser.newContext({ viewport:{width:1440,height:1000}, permissions:['microphone'] });
 await context.addInitScript(() => {
  const matchMedia = window.matchMedia.bind(window);
  const fullscreen = matchMedia('(display-mode: fullscreen)');
  Object.defineProperty(fullscreen, 'matches', {get: () => !!window.__nativeFullscreen});
  window.__fullscreenMedia = fullscreen;
  window.matchMedia = query => query === '(display-mode: fullscreen)' ? fullscreen : matchMedia(query);
  window.__tracks = []; window.__permissionRequests = 0;
  const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async constraints => { window.__permissionRequests++; const stream = await get(constraints); window.__tracks.push(...stream.getTracks()); return stream; };
 });
 const page = await context.newPage();
 page.setDefaultTimeout(35000);
 let sessionsCreated=0,cancelledSessions=0,delaySession=false,releaseSession;
 let projectsCreated=0,failProject=false,delayProject=false,releaseProject;
 const sessionProjects=[];
 const reports=new Map();
 let failExport=false;
 const errors=[]; page.on('pageerror',error => errors.push(error.message));
 const assertCoreVisible = async () => {
  await page.waitForFunction(() => {
   const frame=document.querySelector('.field-viewport').getBoundingClientRect();
   const cards=[...document.querySelectorAll('.field-cell[data-visible=true]')];
   const bounds=cards.map(cell=>cell.getBoundingClientRect());
   const inset=parseFloat(getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--field-inset'));
   return cards.length===9&&[
    Math.min(...bounds.map(r=>r.left))-frame.left,
    frame.right-Math.max(...bounds.map(r=>r.right)),
    Math.min(...bounds.map(r=>r.top))-frame.top,
    frame.bottom-Math.max(...bounds.map(r=>r.bottom))
   ].every(value=>Math.abs(value-inset)<1);
  });
  const cards = await page.locator('.field-cell[data-visible=true]').evaluateAll(cells => cells.map(cell => {
   const r=cell.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};
  }));
  const screen=await page.locator('.field-viewport').boundingBox();
  assert.equal(cards.length,9);
  assert.ok(cards.every(card=>card.left>=screen.x&&card.right<=screen.x+screen.width&&card.top>=screen.y+12&&card.bottom<=screen.y+screen.height-12),'All nine main cells stay fully visible inside the canvas');
  const insets=[Math.min(...cards.map(card=>card.left))-screen.x,screen.x+screen.width-Math.max(...cards.map(card=>card.right)),Math.min(...cards.map(card=>card.top))-screen.y,screen.y+screen.height-Math.max(...cards.map(card=>card.bottom))];
  assert.ok(insets[0]<=40&&insets.every(inset=>Math.abs(inset-insets[0])<1),`The nine main cells have equal compact margins: ${insets.join(', ')}`);
  const copyLeft=await page.locator('.field-cell[data-visible=true] .cell-copy').evaluateAll(elements=>Math.min(...elements.map(element=>element.getBoundingClientRect().left)));
  const logo=await page.locator('.app-logo').boundingBox();
  assert.ok(Math.abs(logo.x-copyLeft)<1,'The logo aligns with the left column card text at every viewport size');
 };
 await page.route('**/readyz',route=>route.fulfill({json:{voiceReady:true}}));
 await context.route('**/api/reports/*',route=>{
  const id=new URL(route.request().url()).pathname.split('/').at(-1);
  const report=reports.get(id);
  return route.fulfill({status:report?200:404,json:report?{report}:{error:'not_found'}});
 });
 await page.route(/\/api\//, async route => {
  const url=new URL(route.request().url());
  let json={};
  if(url.pathname.endsWith('/reports')&&route.request().method()==='POST') {
   if(failExport)return route.fulfill({status:503,json:{error:'export_failed',message:'Could not export the conversation. Please try again.'}});
   const id=`browser-report-${reports.size+1}`;
   reports.set(id,buildConversationReport(snapshot.field,savedSpeech,new Date().toISOString(),true));
   json={id,url:`/report/${id}`};
  }
  else if(url.pathname==='/api/projects'&&route.request().method()==='POST') {
   projectsCreated++;
   if(failProject)return route.fulfill({status:503,json:{error:'reset_failed',message:'Could not start a new conversation.'}});
   if(delayProject)await new Promise(resolve=>{releaseProject=resolve});
   snapshot={schemaVersion:1,projectId:'fresh-project',branchId:'fresh-branch',revision:0,nodes:{},navigation:[],dependencies:[],layout:{},pendingQuestionId:null};
   savedSpeech=[];
   json=project();
  }
  else if(url.pathname==='/api/projects') json={projects:[{id:snapshot.projectId}]};
  else if(url.pathname.endsWith('/transcript')) json={segments:savedSpeech};
  else if(url.pathname.endsWith('/lease')) json={writable:true};
  else if(url.pathname.endsWith('/sessions')) {sessionsCreated++;sessionProjects.push(url.pathname.split('/')[3]);if(delaySession)await new Promise(resolve=>{releaseSession=resolve});json={id:'browser-session',expiresAt:new Date(Date.now()+(sessionsCreated===1?91000:600000)).toISOString()};}
  else if(url.pathname==='/api/sessions/browser-session'&&route.request().method()==='DELETE')cancelledSessions++;
  else if(url.pathname===`/api/projects/${snapshot.projectId}`) json=project();
  return route.fulfill({json});
 });
 let socket;
 const emit=(type,payload={})=>{
  if(type==='fork.speech_segment') savedSpeech=[...savedSpeech.filter(segment=>segment.id!==payload.segment.id),payload.segment];
  socket.send(JSON.stringify({protocolVersion:1,type,sessionId:'browser-session',contextEpoch:0,payload}));
 };
 await page.routeWebSocket(/\/api\/live\//, ws => {
  socket=ws;
  ws.onMessage(raw=>{
   if(typeof raw !== 'string')return;
   const message=JSON.parse(raw);
   if(message.type==='fork.start') emit('fork.ready',{stt:true});
   if(message.type==='fork.stop') ws.close({code:1000,reason:'finished'});
  });
 });
 await page.goto('http://127.0.0.1:5173');
 await page.getByRole('button',{name:'Pause microphone',exact:true}).waitFor();
 const micControl=page.locator('.conversation-plan .plan-microphone-button');
 const micLevel=page.locator('.plan-microphone .microphone-level');
 assert.equal(await micControl.locator('svg path').count(),1,'The bottom microphone control is an upright triangle');
 assert.equal(await micControl.locator('svg').evaluate(svg=>getComputedStyle(svg).fill),'rgb(119, 119, 119)','An active microphone fills the triangle');
 assert.equal(await page.locator('.plan-toggle,.plan-header,.microphone-control,.plan-rail-mark').count(),0,'No collapse square, plan heading or floating microphone remains');
 assert.equal(await micLevel.locator('i').count(),4);
 await page.waitForFunction(()=>Number(document.querySelector('.microphone-level').style.getPropertyValue('--microphone-level'))>0,null,{timeout:5000});
 assert.equal(await page.evaluate(()=>window.__permissionRequests),1,'Auto-start requests microphone once, including React StrictMode');
 assert.equal(await page.locator('.empty-grid > *').count(),9);
 assert.equal(await page.locator('textarea').count(),0);
 assert.equal(await page.locator('.conversation-invitation-caption').textContent(),'Listening. Speak your mind.','An already active microphone does not ask the user to start it');
 assert.equal(await page.locator('.conversation-face path').count(),7,'The welcome tile uses Arrival’s original speaking-face vector');
 assert.equal(await page.getByText('Start anywhere.',{exact:true}).count(),0);
 await page.screenshot({path:'validation/field-empty.png'});
 emit('fork.transcript',{text:'I want to plan an editorial shoot.'});
 await page.locator('.empty-center p').filter({hasText:'I want to plan an editorial shoot.'}).waitFor();
 assert.equal(await page.locator('.conversation-invitation').count(),0,'Real incoming speech replaces the invitation before the first field arrives');
 let fastField = {...structuredClone(field), plan:undefined, planPending:true};
 await page.evaluate(()=>{
  window.__cardArrivals=[];
  window.__arrivalObserver=new MutationObserver(()=>{
   for(const cell of document.querySelectorAll('.field-cell'))if(!window.__cardArrivals.some(entry=>entry.id===cell.dataset.cellId))
    window.__cardArrivals.push({id:cell.dataset.cellId,at:performance.now()});
  });
  window.__arrivalObserver.observe(document.querySelector('.field-content-viewport'),{childList:true,subtree:true});
 });
 emit('fork.committed',{snapshot:{...snapshot,revision:1,field:fastField}});
 await page.waitForFunction(()=>document.querySelectorAll('.field-cell[data-visible=true]').length===9);
 const arrivals=await page.evaluate(()=>{window.__arrivalObserver.disconnect();return window.__cardArrivals});
 assert.equal(arrivals.length,9);
 assert.ok(Math.max(...arrivals.map(entry=>entry.at))-Math.min(...arrivals.map(entry=>entry.at))<50,'The entire first grid arrives in one render without stagger delays');
 const entryAnimations=await page.locator('.card-turn').evaluateAll(cells=>cells.map(cell=>{
  const style=getComputedStyle(cell);return {name:style.animationName,duration:style.animationDuration};
 }));
 assert.ok(entryAnimations.every(animation=>animation.name==='card-flip'&&animation.duration==='0.7s'),'Every opening slot uses a two-sided 3D flip');
 await page.locator('.card-turn').evaluateAll(cells=>cells.forEach(cell=>cell.getAnimations().filter(animation=>animation.animationName==='card-flip').forEach(animation=>{animation.pause();animation.currentTime=500})));
 await page.screenshot({path:'validation/field-opening-enter.png'});
 await page.locator('.card-turn').evaluateAll(cells=>cells.forEach(cell=>cell.getAnimations().filter(animation=>animation.animationName==='card-flip').forEach(animation=>animation.play())));
 await page.waitForFunction(()=>document.querySelectorAll('.field-cell[data-flipping=true]').length===0);
 assert.equal(await page.locator('.plan-clarify li').count(),8,'Eight opening questions appear without waiting for a cumulative plan');
 await page.screenshot({path:'validation/field-opening.png'});
 await page.screenshot({path:'validation/field-fast.png'});
 const pacedField=structuredClone(fastField);
 const pacedQuestions=Object.values(pacedField.cells).filter(cell=>!cell.visited).slice(0,2);
 pacedQuestions.forEach((cell,index)=>{cell.question=`Follow-up ${index+1}: ${cell.question}`});
 await page.evaluate(questions=>{
  window.__pacedArrivals=[];
  window.__pacedObserver=new MutationObserver(()=>{
   for(const question of questions)if(document.querySelector(`[data-cell-id="${question.id}"] .cell-copy p`)?.textContent===question.question&&!window.__pacedArrivals.some(entry=>entry.id===question.id))
    window.__pacedArrivals.push({id:question.id,at:performance.now()});
  });
  window.__pacedObserver.observe(document.querySelector('.field-content-viewport'),{childList:true,characterData:true,subtree:true});
 },pacedQuestions);
 emit('fork.committed',{snapshot:{...snapshot,revision:2,field:pacedField}});
 await page.waitForFunction(()=>window.__pacedArrivals.length===2);
 const subsequentArrivals=await page.evaluate(()=>{window.__pacedObserver.disconnect();return window.__pacedArrivals});
 assert.ok(subsequentArrivals[1].at-subsequentArrivals[0].at>=2400,'Subsequent questions retain the 2.5-second cadence');
 assert.ok(await page.locator('.field-cell[data-flipping=true]').count()<=1,'Only the updated slot is flipping');
 fastField=pacedField;
 const firstQuestion=Object.values(fastField.cells).find(cell=>!cell.visited);
 const firstCard=page.locator(`[data-cell-id="${firstQuestion.id}"]`);
 await firstCard.evaluate(cell=>{window.__stableQuestionSlot=cell});
 const revisionOne=structuredClone(fastField);revisionOne.cells[firstQuestion.id].question='Are both models available Friday?';
 emit('fork.committed',{snapshot:{...snapshot,revision:2,field:revisionOne}});
 await firstCard.locator('p').filter({hasText:'Are both models available Friday?'}).waitFor();
 await firstCard.locator('.card-turn[data-turning=false]').waitFor();
 const readSince=Number(await firstCard.getAttribute('data-readable-since'));
 const revisionTwo=structuredClone(revisionOne);revisionTwo.cells[firstQuestion.id].question='Are both models available Saturday?';
 emit('fork.committed',{snapshot:{...snapshot,revision:3,field:revisionTwo}});
 emit('fork.transcript',{text:'We are still discussing the dates.'});
 await page.waitForTimeout(100);
 assert.equal(await firstCard.locator('p').textContent(),'Are both models available Friday?','A new suggestion gets a reading window during a burst');
 const revisionThree=structuredClone(revisionTwo);revisionThree.cells[firstQuestion.id].question='Are both models available Sunday?';
 emit('fork.committed',{snapshot:{...snapshot,revision:4,field:revisionThree}});
 await firstCard.locator('p').filter({hasText:'Are both models available Sunday?'}).waitFor();
 assert.ok(await page.evaluate(since=>performance.now()-since>=10000,readSince),'The previous completed face was held for at least ten seconds');
 assert.ok(await firstCard.evaluate(cell=>cell===window.__stableQuestionSlot),'Refining a question retains its physical slot');
 await firstCard.locator('.card-turn[data-turning=false]').waitFor();
 assert.ok(await firstCard.locator('h2,p').evaluateAll(elements=>elements.every(element=>getComputedStyle(element).opacity==='1'&&getComputedStyle(element).filter==='none'&&!element.getAnimations().length)),'After a flip the text is readable with no continuing animation');
 snapshot={...snapshot,revision:1,field}; emit('fork.committed',{snapshot});
 await page.locator('.field-cell[data-visible=true]').first().waitFor();
 await page.waitForFunction(()=>document.querySelectorAll('.field-cell[data-visible=true]').length===9,null,{timeout:25000}).catch(async error=>{
  console.error('Field diagnostic',await page.locator('.field-cell').evaluateAll(cells=>cells.map(cell=>({title:cell.querySelector('h2')?.textContent,visible:cell.dataset.visible,x:cell.dataset.worldX,y:cell.dataset.worldY}))),errors);
  throw error;
 });
 await page.waitForTimeout(2350);
 const geometry=await page.locator('.field-cell[data-visible=true]').evaluateAll(cells=>cells.map(cell=>{const r=cell.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,id:cell.dataset.cellId,worldX:cell.dataset.worldX,worldY:cell.dataset.worldY}}));
 assert.equal(geometry.length,9);
 assert.equal(await page.locator('.field-cell h2').count(),9);
 assert.equal(await page.locator('.field-cell p').count(),9);
 assert.equal(await page.locator('.cell-heading,.cell-footer,.focus-live,.cell-number,.empty-caption,.app-footer,.brand-description,.language').count(),0,'The canvas contains no repeated labels, bottom captions or decorative text');
 assert.ok(await page.locator('.field-cell p').evaluateAll(elements=>elements.every(element=>{const style=getComputedStyle(element);return style.webkitLineClamp==='2'&&element.clientHeight<=parseFloat(style.lineHeight)*2+1})),'Every caption takes at most two lines');
 assert.ok(geometry.every(box=>Math.abs(box.w-geometry[0].w)<1&&Math.abs(box.h-geometry[0].h)<1));
 const frame=await page.locator('.field-viewport').boundingBox();
 const screen=page.viewportSize();
 const rail=await page.locator('.conversation-plan').boundingBox();
 assert.ok(rail&&rail.y===0&&rail.height===screen.height&&Math.abs(rail.width-Math.min(screen.width*.24,480))<1&&rail.x+rail.width===screen.width,'The fixed sidebar is 20% wider and spans the right edge');
 assert.ok(frame.x===0&&frame.y===0&&frame.width===rail.x&&frame.height===screen.height,'The canvas fills all space beside the sidebar rail');
 const bounds={left:Math.min(...geometry.map(box=>box.x)),right:Math.max(...geometry.map(box=>box.x+box.w)),top:Math.min(...geometry.map(box=>box.y)),bottom:Math.max(...geometry.map(box=>box.y+box.h))};
 const gridWindow=await page.locator('.field-grid-viewport').boundingBox();
 const contentWindow=await page.locator('.field-content-viewport').boundingBox();
 assert.deepEqual(gridWindow,contentWindow,'Grid and cards share one nine-cell window');
 assert.ok(Math.abs(gridWindow.x-bounds.left)<1&&Math.abs(gridWindow.y-bounds.top)<1&&Math.abs(gridWindow.x+gridWindow.width-bounds.right)<1&&Math.abs(gridWindow.y+gridWindow.height-bounds.bottom)<1,'Only the nine main cells occupy the grid window');
 assert.equal(await page.locator('.field-content-viewport').evaluate(element=>getComputedStyle(element).overflow),'hidden','Adjoining cards cannot peek outside the nine-cell window');
 const gridStyle=await page.locator('.field-grid-viewport').evaluate(element=>{const style=getComputedStyle(element);return {overflow:style.overflow,mask:style.maskImage,composite:style.maskComposite}});
 assert.ok(gridStyle.overflow==='hidden'&&gridStyle.mask.includes('1px')&&gridStyle.composite.includes('intersect'),`The outer boundaries disappear and the inner line ends fade: ${JSON.stringify(gridStyle)}`);
 assert.equal(await page.locator('.field-rules').count(),0,'No stationary grid can intersect a moving camera');
 assert.equal(await page.locator('.field-world-grid').count(),1,'A single grid draws all shared boundaries');
 await assertCoreVisible();

 // Native desktop fullscreen can report the area behind browser chrome as usable.
 // Exercise that geometry at different page zooms, then restore the real viewport.
 for (const [zoom, reserved] of [[1,0],[1.25,0],[.8,0],[1.25,100]]) {
  await page.evaluate(({zoom,reserved}) => {
   Object.defineProperty(window,'outerWidth',{configurable:true,value:innerWidth*zoom});
   Object.defineProperty(window,'outerHeight',{configurable:true,value:innerHeight*zoom+reserved});
   window.__nativeFullscreen=true;
   window.__fullscreenMedia.dispatchEvent(new Event('change'));
   window.dispatchEvent(new Event('resize'));
  },{zoom,reserved});
  const expected=Math.max(0,88-reserved)/zoom;
  await page.waitForFunction(expected=>Math.abs(document.querySelector('.app-shell').getBoundingClientRect().top-expected)<1,expected);
  await assertCoreVisible();
  const header=await page.locator('.app-logo').boundingBox();
  const footer=await page.locator('.plan-footer').boundingBox();
  assert.ok(header.y>=expected-.1&&Math.abs(footer.y+footer.height-screen.height)<1,`Fullscreen keeps the brand below the browser overlay and the footer inside the window: ${JSON.stringify({expected,header,footer,screen})}`);
 }
 await page.evaluate(() => {
  delete window.outerWidth; delete window.outerHeight;
  window.__nativeFullscreen=false;
  window.__fullscreenMedia.dispatchEvent(new Event('change'));
  window.dispatchEvent(new Event('resize'));
 });
 await page.waitForFunction(()=>document.querySelector('.app-shell').getBoundingClientRect().top===0);
 await assertCoreVisible();

 await page.screenshot({path:'validation/field-desktop.png'});
 const sidebar=page.getByRole('complementary',{name:'Conversation plan'});
 assert.ok(await sidebar.locator('.plan-body').isVisible(),'The sidebar is always open');
 const planBox=await sidebar.boundingBox();
 const brandBox=await page.locator('.app-logo').boundingBox();
 assert.equal(await page.getByRole('link',{name:'ELSE home'}).count(),1,'The logo is shown once at the top-left of the app');
 assert.equal(await page.locator('.app-logo .brand').textContent(),'ELSE');
 assert.equal(await sidebar.locator('.plan-tagline').count(),0,'The heading has no tagline');
 assert.ok(brandBox.y>=10&&brandBox.y+brandBox.height<=32,'The small logo fits inside the top canvas margin');
 const expandedMic=await micControl.boundingBox();
 const micBottomInset=planBox.y+planBox.height-expandedMic.y-expandedMic.height;
 assert.ok(expandedMic.x>=planBox.x&&expandedMic.x<planBox.x+28&&micBottomInset>=12&&micBottomInset<=16,'The microphone toggle sits at the bottom-left of the sidebar');
 assert.equal(await sidebar.getByText('Saved with your conversation',{exact:true}).count(),0,'The microphone replaces the saved conversation caption');
 const newConversationControl=sidebar.getByRole('button',{name:'New conversation',exact:true});
 const newConversationBox=await newConversationControl.boundingBox();
 const startBox=await sidebar.locator('.plan-start').boundingBox();
 assert.ok(newConversationBox.y>=planBox.y&&newConversationBox.y<planBox.y+20,'New conversation is pinned at the top of the sidebar');
 assert.equal(await newConversationControl.locator('span').textContent(),'NEW CONVERSATION');
 assert.equal(await newConversationControl.locator('svg path').count(),0,'The arrow is a separate action from New conversation');
 const exportControl=sidebar.getByRole('button',{name:'Summary',exact:true});
 assert.equal(await exportControl.locator('svg path').count(),1,'The top-right arrow exports the conversation');
 const exportBox=await exportControl.boundingBox();
 assert.ok(exportBox.x>=newConversationBox.x+newConversationBox.width&&exportBox.y===newConversationBox.y,'Export occupies its own target in the top-right');
 assert.equal(await sidebar.locator('.plan-footer .new-conversation').count(),0,'The footer contains only microphone controls');
 assert.equal(await sidebar.locator('.plan-start').evaluate(element=>getComputedStyle(element).borderBottomWidth),'1px','A thin divider separates the header from speech');
 assert.ok(await newConversationControl.isEnabled(),'A new conversation can begin while the microphone is active');
 const now=sidebar.locator('.plan-priorities');
 const content=sidebar.locator('.plan-content');
 const transcriptBlock=sidebar.locator('.plan-transcript');
 const history=sidebar.locator('.plan-history');
 const transcriptToggle=transcriptBlock.locator('summary');
 const historyToggle=history.locator('summary');
 assert.equal(await sidebar.getByRole('tab').count(),0,'The sidebar uses blocks without Now or tabs');
 assert.ok(await transcriptBlock.evaluate(element=>element.open),'The live transcript is expanded by default');
 assert.equal(await sidebar.locator('details').count(),2,'Only Transcript and History can collapse');
 assert.ok(!(await history.evaluate(element=>element.open)),'History starts collapsed');
 assert.ok(!(await sidebar.getByText(initial.plan.summary,{exact:true}).isVisible()),'The recap does not compete with the next question');
 assert.deepEqual(await now.locator(':scope>.plan-section').evaluateAll(sections=>sections.map(section=>section.getAttribute('aria-label'))),['To clarify'],'Empty steps and settled lists do not add noise');
 assert.equal(await sidebar.locator('.plan-clarify>ul li').first().textContent(),initial.plan.openQuestions[0],'The most important question is first');
 assert.ok(await sidebar.locator('.plan-microphone-status').getByText('Microphone on',{exact:true}).isVisible());
 await page.evaluate(()=>{
  window.__focusHeading=document.querySelector('.field-cell.current h2');
  window.__focusEntrance=window.__focusHeading.getAnimations()[0];
  window.__focusSlot=document.querySelector('.field-cell.current');
  window.__focusTurn=document.querySelector('.field-cell.current .card-turn');
 });
 const firstSpeech='We need two models for Friday. '+ 'The studio is booked, and we still need to agree on the full-day rates and availability. '.repeat(4);
 const segment={id:'speech-session:1',text:'We need two models',final:false,createdAt:'2026-09-30T10:00:00.000Z',speaker:'UNKNOWN',sessionId:'speech-session'};
 emit('fork.speech_segment',{segment});
 await page.waitForFunction(()=>document.querySelector('[data-segment-id="speech-session:1"]'));
 assert.ok(await now.isVisible(),'Incoming speech leaves the priorities visible');
 await page.locator('[data-segment-id="speech-session:1"]').filter({hasText:segment.text}).waitFor();
 assert.equal(await page.locator('[data-segment-id="speech-session:1"] .transcript-speaker').textContent(),'Unknown','Uncertain voices have the requested neutral label');
 await page.evaluate(()=>{window.__speechEntrance=document.querySelector('[data-segment-id="speech-session:1"]').getAnimations()[0]});
 emit('fork.speech_segment',{segment:{...segment,text:firstSpeech,final:true,speaker:'A'}});
 await page.waitForFunction(text=>document.querySelector('[data-segment-id="speech-session:1"] .transcript-words')?.textContent===text,firstSpeech);
 assert.equal(await page.locator('[data-segment-id="speech-session:1"] .transcript-speaker').textContent(),'Person 1','Speaker attribution replaces Unknown on the same utterance');
 assert.equal(await page.locator('[data-segment-id="speech-session:1"]').count(),1,'Interim corrections replace the paragraph');
 assert.ok(await page.evaluate(()=>window.__speechEntrance&&document.querySelector('[data-segment-id="speech-session:1"]').getAnimations()[0]===window.__speechEntrance),'ASR corrections do not restart the phrase entrance');
 assert.ok(await page.evaluate(()=>document.querySelector('.field-cell.current h2')===window.__focusHeading&&window.__focusHeading.getAnimations()[0]===window.__focusEntrance),'Speech does not make existing card text blink or reanimate');
 assert.ok(await page.evaluate(()=>document.querySelector('.field-cell.current .card-turn')===window.__focusTurn),'Speech alone does not flip the current card');
 assert.equal(await page.locator('[data-segment-id="speech-session:1"]').evaluate(element=>getComputedStyle(element).webkitLineClamp),'none','Speech is not line-clamped');
 const secondSpeech={id:'speech-session:2',text:'Friday is confirmed.',final:true,createdAt:'2026-09-30T10:00:01.000Z',speaker:'B',sessionId:'speech-session'};
 emit('fork.speech_segment',{segment:secondSpeech});
 await page.locator('[data-segment-id="speech-session:2"]').waitFor();
 assert.deepEqual(await page.locator('.transcript-scroll .transcript-words').allTextContents(),[secondSpeech.text,firstSpeech],'New speech appears above the earlier history');
 assert.deepEqual(await page.locator('.transcript-scroll .transcript-speaker').allTextContents(),['Person 2','Person 1'],'Each participant is labeled consistently in newest-first speech');
 assert.equal(await page.locator('.transcript-scroll').evaluate(element=>element.scrollTop),0,'The transcript follows new speech at the top');
 const speechBeforeRecap=await page.locator('.transcript-scroll .transcript-words').allTextContents();
 const boardBeforeRecap=await page.locator('.field-board').boundingBox();
 snapshot={...snapshot,revision:snapshot.revision+1,field:{...field,planPending:false,plan:{...field.plan,summary:'A refreshed background summary.'}}};
 emit('fork.plan',{snapshot});
 await page.waitForFunction(()=>document.querySelector('.plan-overview p')?.textContent==='A refreshed background summary.');
 assert.deepEqual(await page.locator('.transcript-scroll .transcript-words').allTextContents(),speechBeforeRecap,'A background plan preserves all ongoing speech');
 assert.deepEqual(await page.locator('.field-board').boundingBox(),boardBeforeRecap,'A recap does not move the fixed grid');
 assert.ok(await page.getByRole('button',{name:'Pause microphone',exact:true}).isVisible(),'A recap keeps the microphone active');
 emit('fork.plan',{snapshot:{...snapshot,projectId:'obsolete-project',revision:999,field:{...field,plan:{...field.plan,summary:'WRONG PROJECT'}}}});
 emit('fork.plan',{snapshot:{...snapshot,revision:0,field:{...field,plan:{...field.plan,summary:'STALE REVISION'}}}});
 await page.waitForTimeout(50);
 assert.equal(await page.locator('.plan-overview p').textContent(),'A refreshed background summary.','Late foreign or stale recaps cannot replace the active conversation');
 assert.equal(await sidebar.locator('.plan-topics article').count(),1,'Unvisited suggestions are not counted as discussed topics');
 const transcriptType=await page.locator('.transcript-scroll p').first().evaluate(element=>{const style=getComputedStyle(element);return {line:parseFloat(style.lineHeight),size:parseFloat(style.fontSize)}});
 assert.ok(transcriptType.line/transcriptType.size<1.45,'Nested transcript keeps compact line spacing');
 await transcriptToggle.click();
 await page.waitForFunction(()=>!document.querySelector('.plan-transcript').open);
 emit('fork.speech_segment',{segment:{...secondSpeech,text:'Friday is confirmed. Both models are available.'}});
 await page.waitForFunction(()=>document.querySelector('[data-segment-id="speech-session:2"]').textContent.endsWith('available.'));
 assert.ok(!(await transcriptBlock.evaluate(element=>element.open)),'Incoming speech never reopens a collapsed transcript');
 assert.ok(!(await sidebar.locator('.transcript-scroll').isVisible()),'Collapsed speech is hidden');
 await transcriptToggle.press('Enter');
 await page.locator('[data-segment-id="speech-session:2"]').waitFor();
 emit('fork.speech_segment',{segment:secondSpeech});
 await page.waitForFunction(text=>document.querySelector('[data-segment-id="speech-session:2"] .transcript-words').textContent===text,secondSpeech.text);
 await page.screenshot({path:'validation/field-transcript-tab.png'});
 await content.evaluate(element=>{element.scrollTop=0});
 const titleBox=await sidebar.locator('.plan-clarify h3').boundingBox();
 const topicBox=await sidebar.locator('.plan-context').boundingBox();
 const prioritiesBox=await now.boundingBox();
 const transcriptBox=await transcriptBlock.boundingBox();
 const historyBox=await history.boundingBox();
 assert.ok(topicBox.y>=startBox.y+startBox.height&&topicBox.y<startBox.y+startBox.height+24&&titleBox.y>topicBox.y,'The topic appears directly below the header, before the priorities');
 assert.ok(transcriptBox.y>=prioritiesBox.y+prioritiesBox.height&&historyBox.y>=transcriptBox.y+transcriptBox.height,'Transcript follows priorities and History follows Transcript');
 assert.equal(await now.locator('.plan-context h2').textContent(),field.cells[field.focusId].title,'The current topic provides a brief context');
 await page.screenshot({path:'validation/field-plan.png'});
 const coverSpeech='We need two models for Friday. The studio is booked; rates and availability are still open.';
 emit('fork.speech_segment',{segment:{...segment,text:coverSpeech,final:true,speaker:'A'}});
 await page.waitForFunction(text=>document.querySelector('[data-segment-id="speech-session:1"] .transcript-words').textContent===text,coverSpeech);
 await page.setViewportSize({width:1600,height:900});
 await assertCoreVisible();
 await page.waitForFunction(()=>[...document.querySelectorAll('.field-cell h2,.field-cell p')].every(element=>{const style=getComputedStyle(element);return style.opacity==='1'&&(style.filter==='none'||style.filter==='blur(0px)')}));
 await page.evaluate(()=>document.activeElement?.blur());
 fs.mkdirSync('submission',{recursive:true});
 await page.screenshot({path:'submission/cover.png'});
 emit('fork.speech_segment',{segment:{...segment,text:firstSpeech,final:true,speaker:'A'}});
 await page.waitForFunction(text=>document.querySelector('[data-segment-id="speech-session:1"] .transcript-words').textContent===text,firstSpeech);
 await page.setViewportSize({width:1440,height:1000});
 await assertCoreVisible();
 const longField=structuredClone(field);
 longField.cells[longField.focusId].title='Two-week Japan trip next spring';
 longField.cells[longField.focusId].summary='Planning a two-week trip to Japan next spring. Dates are not set and no hotels are booked. The goal is to work through the practical details together.';
 longField.plan.openQuestions=Array.from({length:12},(_,i)=>`Question ${i+1}: Which practical details still need to be discussed together before confirming dates, bookings, availability and the final plan?`);
 emit('fork.committed',{snapshot:{...snapshot,field:longField}});
 await page.waitForTimeout(100);
 await page.waitForFunction(()=>document.querySelector('.field-cell.current').dataset.flipping==='false');
 const stableCopy=await page.locator('.field-cell.current').evaluate(cell=>({
  sameSlot:cell===window.__focusSlot,
  titleOpacity:getComputedStyle(cell.querySelector('h2')).opacity,
  captionOpacity:getComputedStyle(cell.querySelector('p')).opacity,
  animations:cell.querySelector('h2').getAnimations().length+cell.querySelector('p').getAnimations().length,
 }));
 assert.deepEqual(stableCopy,{sameSlot:true,titleOpacity:'1',captionOpacity:'1',animations:0},'The topic completes its flip in the same center slot');
 assert.equal(await page.locator('[data-segment-id="speech-session:1"] .transcript-words').textContent(),firstSpeech,'All recognized words stay visible after an update is saved');
 assert.ok(await page.locator('.field-cell.current .cell-copy').evaluate(element=>element.scrollHeight<=element.clientHeight+1),'The desktop center fits a two-line title and conversation summary');
 assert.equal(await page.locator('.field-cell.current p').textContent(),'Planning a two-week trip to Japan next spring.','Older multi-sentence summaries show a single sentence on the canvas');
 assert.equal(await sidebar.locator('.plan-clarify>ul li').count(),12,'All questions remain in their priority order without collapsing');
 assert.equal(await sidebar.locator('.plan-clarify li:visible').count(),12,'No questions are hidden behind a disclosure control');
 await historyToggle.click();
 await sidebar.locator('.plan-topics article').first().waitFor();
 assert.equal(await sidebar.locator('.plan-topics article').first().locator('p').textContent(),longField.cells[longField.focusId].summary,'Full topic summaries are available in History without extra clicks');
 await page.screenshot({path:'validation/field-history-tab.png'});
 assert.ok(await transcriptBlock.evaluate(element=>element.open),'Opening History keeps Transcript open');
 await historyToggle.press('Enter');
 await page.waitForFunction(()=>!document.querySelector('.plan-history').open);
 assert.ok(await content.evaluate(element=>{element.scrollTop=350;return element.scrollTop>0}),'All blocks share a scrolling sidebar');
 assert.deepEqual(await micControl.boundingBox(),expandedMic,'Scrolling the plan never moves the microphone control');
 await content.evaluate(element=>{element.scrollTop=0});


 const fixedBefore=await page.locator('.field-cell').evaluateAll(cells=>cells.map(cell=>{const r=cell.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}));
 snapshot={...snapshot,revision:2,field:moved}; emit('fork.committed',{snapshot});
 await page.locator('.field-cell.current h2').filter({hasText:'Model booking'}).waitFor();
 assert.equal(await page.locator('.field-camera').count(),0,'Focus changes have no camera layer');
 assert.deepEqual(await page.locator('.field-cell').evaluateAll(cells=>cells.map(cell=>{const r=cell.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})),fixedBefore,'Every slot stays in place through a focus change');
 assert.equal(await page.locator('.field-cell h2').count(),9,'Old questions keep every slot filled');
 const centerTurn=page.locator('.field-cell.current .card-turn');
 assert.equal(await centerTurn.locator('.card-front[aria-hidden=true]').count(),1,'The old face remains during the first half');
 assert.equal(await centerTurn.locator('.card-back h2').textContent(),'Model booking','The new topic is on the reverse face');
 await centerTurn.evaluate(element=>{const animation=element.getAnimations()[0];animation.pause();animation.currentTime=500});
 assert.equal(await centerTurn.locator('.card-back').evaluate(element=>getComputedStyle(element).backfaceVisibility),'hidden','Backfaces do not show mirrored text');
 assert.match(await centerTurn.evaluate(element=>getComputedStyle(element).transform),/^matrix3d/);
 await page.screenshot({path:'validation/field-flip-mid.png'});
 await centerTurn.evaluate(element=>element.getAnimations().forEach(animation=>animation.play()));
 await page.waitForFunction(()=>document.querySelector('.field-cell.current').dataset.flipping==='false');
 const current=await page.locator('.field-cell.current').boundingBox(), viewport=await page.locator('.field-viewport').boundingBox();
 assert.ok(Math.abs(current.x+current.width/2-(viewport.x+viewport.width/2))<1);
 assert.ok(Math.abs(current.y+current.height/2-(viewport.y+viewport.height/2))<1);
 assert.equal(await page.locator('.field-cell').count(),9);
 assert.equal(await page.locator('.field-cell h2').count(),9);
 await assertCoreVisible();
 const displayed=await page.locator('.field-cell').evaluateAll(cells=>cells.map(cell=>({id:cell.dataset.cellId,x:Number(cell.dataset.worldX),y:Number(cell.dataset.worldY)})));
 for(const cell of displayed) assert.deepEqual([cell.x,cell.y],[moved.cells[cell.id].x,moved.cells[cell.id].y]);
 assert.equal(Object.keys(moved.cells).length,14,'Saved history is retained outside the nine screen slots');
 await page.screenshot({path:'validation/field-fixed-topics.png'});

 assert.ok(await sidebar.getByText(moved.plan.nextSteps[0].text,{exact:true}).isVisible(),'The running plan updates from committed conversation data');
 assert.deepEqual(await now.locator(':scope>.plan-section').evaluateAll(sections=>sections.map(section=>section.getAttribute('aria-label'))),['To clarify','Next steps','Settled'],'Open questions and actions lead; confirmed points follow');
 assert.ok(!(await history.evaluate(element=>element.open)),'Focus changes do not reopen History');
 assert.equal(await sidebar.locator('.plan-topics article').count(),2);
 const originalProject=await page.evaluate(()=>localStorage.getItem('else.project'));
 const originalSessionCount=sessionsCreated;
 const popupPromise=context.waitForEvent('page');
 await exportControl.click();
 const reportPage=await popupPromise;
 await reportPage.waitForURL('**/report/browser-report-1');
 await reportPage.getByRole('heading',{level:1,name:moved.plan.title}).waitFor();
 assert.equal(await page.evaluate(()=>localStorage.getItem('else.project')),originalProject,'Export never starts a new conversation');
 assert.equal(projectsCreated,0);
 assert.equal(sessionsCreated,originalSessionCount,'The report tab never creates a voice session');
 assert.equal(await reportPage.evaluate(()=>window.__permissionRequests),0,'The exported report never requests microphone access');
 assert.ok(await page.getByRole('button',{name:'Pause microphone',exact:true}).isVisible(),'Export keeps the original conversation listening');
 assert.deepEqual(await reportPage.locator('.report-section h2').allTextContents(),['Settled · priority order','Still open · priority order','Next steps · priority order','Summary','Topics discussed','Full transcript']);
 assert.deepEqual(await reportPage.locator('.report-transcript>div>p').allTextContents(),[firstSpeech,secondSpeech.text],'The complete transcript is last and oldest first');
 assert.deepEqual(await reportPage.locator('.report-transcript .transcript-speaker').allTextContents(),['Person 1','Person 2'],'Summary preserves speaker attribution');
 await reportPage.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copiedReport=text}}})});
 await reportPage.getByRole('button',{name:'Copy report',exact:true}).click();
 await reportPage.getByRole('status').filter({hasText:'Report copied.'}).waitFor();
 assert.equal(await reportPage.evaluate(()=>window.__copiedReport),reportToText(reports.get('browser-report-1')),'Copy includes the entire report, not only the visible portion');
 await reportPage.screenshot({path:'validation/conversation-report.png',fullPage:true});
 await reportPage.reload();
 await reportPage.getByRole('heading',{level:1,name:moved.plan.title}).waitFor();
 assert.deepEqual(await reportPage.locator('.report-transcript>div>p').allTextContents(),[firstSpeech,secondSpeech.text],'The new report link survives reload');
 await reportPage.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Denied')}}})});
 await reportPage.getByRole('button',{name:'Copy report',exact:true}).click();
 await reportPage.getByRole('status').filter({hasText:'Copy is unavailable'}).waitFor();
 await reportPage.close();
 failExport=true;
 const failedPopup=context.waitForEvent('page');
 await exportControl.click();
 const failedReport=await failedPopup;
 await page.getByRole('status').filter({hasText:'Could not export the conversation'}).waitFor();
 assert.ok(failedReport.isClosed(),'A failed export closes its loading tab');
 assert.ok(await exportControl.isEnabled(),'Export can be retried after a failure');
 failExport=false;
 await page.evaluate(()=>{window.__open=window.open;window.open=()=>null});
 await exportControl.click();
 await page.getByRole('link',{name:'Open report ↗'}).waitFor();
 assert.equal(await page.getByRole('link',{name:'Open report ↗'}).getAttribute('href'),'/report/browser-report-2','A blocked popup offers a direct report link');
 await page.evaluate(()=>{window.open=window.__open});
 await page.getByRole('button',{name:'Dismiss export message'}).click();
 const resolved=structuredClone(moved);
 resolved.plan.openQuestions=['Is the studio available?'];
 resolved.plan.nextSteps=[];
 resolved.plan.decisions.push({text:'Both models confirmed for Friday.',sourceQuote:'Both models confirmed for Friday'});
 emit('fork.committed',{snapshot:{...snapshot,field:resolved}});
 await sidebar.getByText('Both models confirmed for Friday.',{exact:true}).waitFor();
 assert.deepEqual(await sidebar.locator('.plan-clarify li').allTextContents(),resolved.plan.openQuestions,'Answered questions disappear from the working list');
 assert.equal(await sidebar.locator('.plan-next').count(),0,'Completed actions do not remain in Next steps');
 assert.ok(await sidebar.locator('.plan-settled').getByText('Both models confirmed for Friday.',{exact:true}).isVisible(),'The resulting confirmed point is shown as settled');
 emit('fork.committed',{snapshot:{...snapshot,field}});
 await page.locator('.field-cell.current h2').filter({hasText:'Photoshoot planning'}).waitFor();
 await page.waitForTimeout(150);
 emit('fork.committed',{snapshot});
 await page.locator('.field-cell.current h2').filter({hasText:'Model booking'}).waitFor();
 await page.waitForFunction(()=>document.querySelector('.field-cell.current').dataset.flipping==='false');
 assert.equal(await page.locator('.field-cell h2').count(),9,'Rapid focus changes retain all occupied slots');
 assert.deepEqual(await page.locator('.field-cell').evaluateAll(cells=>cells.map(cell=>{const r=cell.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})),fixedBefore,'Rapid topic changes never shift the grid');
 snapshot={...snapshot,revision:snapshot.revision+1,field:{...snapshot.field,planPending:true}};
 emit('fork.committed',{snapshot});
 await page.getByRole('button',{name:'Pause microphone',exact:true}).click();
 await page.getByRole('button',{name:'Resume microphone',exact:true}).waitFor();
 snapshot={...snapshot,revision:snapshot.revision+1,field:{...snapshot.field,planPending:false}};
 await page.waitForFunction(()=>!document.querySelector('.plan-refresh-status'),null,{timeout:8000});
 assert.ok(await page.getByRole('button',{name:'Resume microphone',exact:true}).isVisible(),'A plan completing after socket closure is polled without restarting capture');
 assert.equal(await micControl.locator('svg').evaluate(svg=>getComputedStyle(svg).fill),'none','Pausing returns the triangle to its outline');
 assert.equal(await micLevel.evaluate(element=>getComputedStyle(element).opacity),'0.35','The inactive indicator is dimmed');
 assert.ok(await page.evaluate(()=>window.__tracks.every(track=>track.readyState==='ended')),'Pause releases all microphone tracks');
 await page.waitForTimeout(1000);
 assert.ok(await sidebar.locator('.plan-microphone-status').getByText('Microphone off',{exact:true}).isVisible());
 await page.screenshot({path:'validation/field-plan-paused.png'});
 await page.getByRole('button',{name:'Resume microphone',exact:true}).click();
 await page.getByRole('button',{name:'Pause microphone',exact:true}).waitFor();
 assert.equal(await micLevel.evaluate(element=>getComputedStyle(element).opacity),'1','Starting capture activates the sound indicator');
 assert.equal(await sidebar.locator('.plan-microphone-status').textContent(),'Microphone on');
 await page.getByRole('button',{name:'Pause microphone',exact:true}).click();
 await page.getByRole('button',{name:'Resume microphone',exact:true}).waitFor();
 assert.equal(await sidebar.locator('.plan-microphone-status').textContent(),'Microphone off');
 assert.ok(await page.evaluate(()=>window.__tracks.every(track=>track.readyState==='ended')),'The expanded stop control releases all microphone tracks');
 await page.reload();
 await page.getByRole('button',{name:'Pause microphone',exact:true}).waitFor();
 assert.equal(await page.locator('.field-cell.current h2').textContent(),'Model booking');
 assert.ok(await sidebar.getByText(moved.plan.nextSteps[0].text,{exact:true}).isVisible(),'Reload retains the saved conversation plan');
 assert.equal(await page.locator('[data-segment-id="speech-session:1"] .transcript-words').textContent(),firstSpeech,'Reload restores the complete transcript');
 assert.deepEqual(await page.locator('.transcript-scroll .transcript-words').allTextContents(),[secondSpeech.text,firstSpeech],'Reload retains newest-first order');
 assert.deepEqual(await page.locator('.transcript-scroll .transcript-speaker').allTextContents(),['Person 2','Person 1'],'Reload restores saved voices');
 await page.setViewportSize({width:2560,height:1200});
 await page.waitForTimeout(1000);
 assert.equal((await sidebar.boundingBox()).width,480,'The expanded panel stops growing at 480px on a wide display');
 await assertCoreVisible();
 await page.setViewportSize({width:390,height:844});
 await page.waitForTimeout(1000);
 assert.equal(await page.locator('.field-cell[data-visible=true]').count(),9);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const mobileFrame=await page.locator('.field-viewport').boundingBox();
 assert.ok(Math.abs(mobileFrame.width-390*.76)<1,'The mobile canvas uses the remaining width');
 const mobilePlan=await sidebar.boundingBox();
 assert.ok(mobilePlan.y===0&&mobilePlan.height===844&&Math.abs(mobilePlan.width-390*.24)<1,'The sidebar stays fixed on mobile');
 await assertCoreVisible();
 await page.screenshot({path:'validation/field-mobile.png'});
 await page.waitForTimeout(1000);
 assert.ok(Math.abs((await sidebar.boundingBox()).width-390*.24)<1,'The sidebar uses the wider proportion on mobile too');
 await assertCoreVisible();
 await page.screenshot({path:'validation/field-plan-mobile.png'});
 await page.getByRole('button',{name:'Pause microphone',exact:true}).click();
 await page.getByRole('button',{name:'Resume microphone',exact:true}).waitFor();
 assert.ok(sessionsCreated>=2,'The microphone session renews automatically before expiry');
 delaySession=true;
 await page.getByRole('button',{name:'Resume microphone',exact:true}).click();
 for(let i=0;i<100&&!releaseSession;i++)await page.waitForTimeout(20);
 assert.ok(releaseSession,'A session creation request is pending');
 await page.getByRole('button',{name:'Cancel microphone connection',exact:true}).click();
 releaseSession();
 for(let i=0;i<100&&!cancelledSessions;i++)await page.waitForTimeout(20);
 assert.equal(cancelledSessions,1,'Cancelling during session creation releases the unopened server session');
 assert.ok(await page.evaluate(()=>window.__tracks.every(track=>track.readyState==='ended')));
 delaySession=false;
 await page.getByRole('button',{name:'Resume microphone',exact:true}).click();
 await page.getByRole('button',{name:'Pause microphone',exact:true}).waitFor();
 await page.emulateMedia({reducedMotion:'reduce'});
 emit('fork.committed',{snapshot:{...snapshot,field}});
 await page.waitForFunction(()=>document.querySelector('.field-cell.current h2')?.textContent==='Photoshoot planning');
 assert.equal(await page.locator('.field-cell').count(),9,'Reduced motion presents the whole latest field immediately');
 assert.equal(await page.locator('.field-camera').count(),0,'There is no translating camera');
 assert.equal(await page.locator('.field-cell[data-flipping=true]').count(),0,'Reduced motion disables flips');
 assert.ok(await page.locator('.field-cell[data-visible=true] h2,.field-cell[data-visible=true] p,.transcript-scroll p').evaluateAll(elements=>elements.every(element=>getComputedStyle(element).animationName==='none'&&getComputedStyle(element).opacity==='1')),'Reduced-motion mode keeps every word visible without entrance animations');
 assert.ok(await page.locator('.cell-update').evaluateAll(elements=>elements.every(element=>getComputedStyle(element).opacity==='0')),'Disabled animations do not leave permanent update highlights');
 assert.equal(await page.locator('.field-cell.current').evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(48, 48, 48)','Reduced motion keeps the dark center visible');
 failProject=true;
 await newConversationControl.click();
 await page.getByRole('alert').filter({hasText:'Could not start a new conversation.'}).waitFor();
 assert.equal(await page.locator('.field-cell.current h2').textContent(),'Photoshoot planning','A failed reset preserves the existing field');
 assert.equal(await page.locator('.transcript-scroll [data-segment-id]').count(),2,'A failed reset preserves the transcript for retry');
 assert.ok(await page.evaluate(()=>window.__tracks.every(track=>track.readyState==='ended')),'Reset stops the previous microphone even if creating a fresh conversation fails');
 failProject=false;
 await page.getByRole('button',{name:'Resume microphone',exact:true}).click();
 await page.getByRole('button',{name:'Pause microphone',exact:true}).waitFor();
 await page.emulateMedia({reducedMotion:'no-preference'});
 // Let the media-query change reach React before sending paced field updates.
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const beforeReset=structuredClone(field), resetQuestion=Object.values(beforeReset.cells).find(cell=>!cell.visited);
 resetQuestion.question='A question that is still being read.';
 emit('fork.committed',{snapshot:{...snapshot,field:beforeReset}});
 const resetCard=page.locator(`[data-cell-id="${resetQuestion.id}"] p`);
 await resetCard.filter({hasText:resetQuestion.question}).waitFor();
 const queuedBeforeReset=structuredClone(beforeReset);
 queuedBeforeReset.cells[resetQuestion.id].question='This queued question belongs only to the old conversation.';
 emit('fork.committed',{snapshot:{...snapshot,field:queuedBeforeReset}});
 await page.waitForTimeout(50);
 assert.equal(await resetCard.textContent(),resetQuestion.question,'A replacement is pending when reset starts');
 delayProject=true;
 await newConversationControl.click();
 for(let i=0;i<100&&!releaseProject;i++)await page.waitForTimeout(20);
 assert.ok(releaseProject,'The new conversation request is pending');
 assert.ok(await newConversationControl.isDisabled(),'Repeated clicks cannot create duplicate conversations');
 assert.ok(await page.evaluate(()=>window.__tracks.every(track=>track.readyState==='ended')),'All old capture tracks stop before the new conversation opens');
 releaseProject();
 await page.waitForFunction(()=>localStorage.getItem('else.project')==='fresh-project');
 await page.getByRole('button',{name:'Pause microphone',exact:true}).waitFor();
 assert.equal(await page.locator('.field-cell').count(),0,'New conversation clears all old cards');
 await page.waitForTimeout(3200);
 assert.equal(await page.locator('.field-cell').count(),0,'An old queued card cannot reappear after a conversation reset');
 assert.equal(await page.locator('.empty-grid > *').count(),9);
 assert.equal(await page.locator('.transcript-scroll [data-segment-id]').count(),0,'New conversation clears the full transcript');
 assert.equal(await sidebar.locator('.plan-topics article').count(),0,'New conversation clears the recap and discussed topics');
 assert.ok(await transcriptBlock.evaluate(element=>element.open),'A fresh conversation starts with Transcript open');
 assert.ok(!(await history.evaluate(element=>element.open)),'A fresh conversation starts with History closed');
 assert.ok(await exportControl.isDisabled(),'An empty conversation cannot produce a misleading report');
 assert.equal(await page.evaluate(()=>localStorage.getItem('else.project')),'fresh-project');
 assert.equal(sessionProjects.at(-1),'fresh-project','The microphone restarts with the new conversation context');
 assert.equal(projectsCreated,2,'Only the failed attempt and one successful retry were submitted');
 await page.getByRole('button',{name:'Pause microphone',exact:true}).click();
 await page.getByRole('button',{name:'Resume microphone',exact:true}).waitFor();
 await page.setViewportSize({width:1440,height:1000});
 const emptyMicrophone=page.getByRole('button',{name:'Tap to begin a conversation',exact:true});
 assert.ok(await emptyMicrophone.isEnabled(),'An empty paused conversation offers a microphone button');
 const requestsBefore=await page.evaluate(()=>window.__permissionRequests);
 const invitationStyle=await emptyMicrophone.evaluate(button=>{
  const caption=button.querySelector('.conversation-invitation-caption');
  const svg=button.querySelector('svg');
  return {duration:getComputedStyle(caption).animationDuration,animation:getComputedStyle(caption).animationName,
   fill:getComputedStyle(svg).fill,stroke:getComputedStyle(svg).stroke,width:svg.getBoundingClientRect().width};
 });
 assert.equal(invitationStyle.duration,'3s','The onboarding caption breathes over three seconds');
 assert.equal(invitationStyle.animation,'invitation-pulse');
 assert.equal(invitationStyle.stroke,'none','Global microphone button styles do not alter the source vector');
 assert.equal(invitationStyle.fill,'rgb(247, 246, 242)');
 assert.ok(Math.abs(invitationStyle.width-58*.65)<.1,'The speaking face is 35% smaller on desktop');
 await page.screenshot({path:'validation/field-empty-paused.png'});
 await page.screenshot({path:'validation/field-invitation-desktop.png'});
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await page.locator('.conversation-invitation-caption').evaluate(element=>getComputedStyle(element).animationName),'none','Reduced motion leaves the invitation steady');
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.setViewportSize({width:390,height:844});
 await page.waitForFunction(()=>Math.abs(document.querySelector('.empty-center').getBoundingClientRect().width*3-document.querySelector('.field-content-viewport').getBoundingClientRect().width)<1);
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const invitationFits=await emptyMicrophone.evaluate(button=>{
  const tile=button.closest('.empty-center');
  const bounds=tile.getBoundingClientRect();
  return tile.scrollHeight<=tile.clientHeight&&[button,...button.children].every(element=>{
   const rect=element.getBoundingClientRect();
   return rect.left>=bounds.left&&rect.right<=bounds.right&&rect.top>=bounds.top&&rect.bottom<=bounds.bottom;
  });
 });
 assert.ok(invitationFits,'The full caption and speaking face fit inside the mobile center tile');
 assert.ok(Math.abs(await page.locator('.conversation-face').evaluate(svg=>svg.getBoundingClientRect().width)-44*.65)<.1,'The speaking face is also 35% smaller on mobile');
 await page.screenshot({path:'validation/field-invitation-mobile.png'});
 await page.setViewportSize({width:1440,height:1000});
 delaySession=true;
 releaseSession=undefined;
 await emptyMicrophone.focus();
 await emptyMicrophone.press('Enter');
 await page.getByRole('button',{name:'Cancel microphone connection',exact:true}).waitFor();
 assert.equal(await page.locator('.conversation-invitation-caption').textContent(),'Connecting microphone','The start invitation changes while microphone startup is pending');
 for(let i=0;i<100&&!releaseSession;i++)await page.waitForTimeout(20);
 assert.ok(releaseSession,'Keyboard activation enters the existing session creation flow');
 delaySession=false;
 releaseSession();
 await page.getByRole('button',{name:'Pause microphone',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.__permissionRequests),requestsBefore+1,'The empty-state button requests microphone access through the existing capture flow');
 assert.equal(await emptyMicrophone.count(),0,'The empty-state button disappears when listening starts');
 assert.equal(await page.locator('.conversation-invitation-caption').textContent(),'Listening. Speak your mind.');
 await page.getByRole('button',{name:'Pause microphone',exact:true}).click();
 await emptyMicrophone.waitFor();
 assert.deepEqual(errors,[]);
 console.log('PASS: fixed nine-slot grid, 3D flips, ten-second reading windows, paced replacements, microphone and history, pause/reset/renewal cleanup, reports and desktop/mobile geometry; no page errors');
 await context.close();
 const denied=await browser.newContext();
 await denied.addInitScript(()=>{window.__deniedRequests=0;navigator.mediaDevices.getUserMedia=async()=>{window.__deniedRequests++;throw new DOMException('Denied','NotAllowedError')}});
 const deniedPage=await denied.newPage();
 await deniedPage.route(/\/api\//,route=>{const url=route.request().url();return route.fulfill({json:url.endsWith('/projects')?{projects:[{id:snapshot.projectId}]}:url.endsWith('/transcript')?{segments:savedSpeech}:url.endsWith('/lease')?{writable:true}:url.endsWith(`/projects/${snapshot.projectId}`)?project():{}})});
 await deniedPage.goto('http://127.0.0.1:5173');
 await deniedPage.getByRole('alert').filter({hasText:'Allow microphone access'}).waitFor();
 assert.ok(await deniedPage.getByRole('button',{name:'Resume microphone'}).isEnabled());
 const deniedMicrophone=deniedPage.getByRole('button',{name:'Tap to begin a conversation',exact:true});
 assert.ok(await deniedMicrophone.isEnabled(),'Permission denial exposes the empty-state retry button');
 await deniedMicrophone.click();
 await deniedPage.waitForFunction(()=>window.__deniedRequests===2);
 await deniedPage.getByRole('alert').filter({hasText:'Allow microphone access'}).waitFor();
 assert.ok(await deniedMicrophone.isEnabled(),'A denied retry stays recoverable');
 console.log('PASS: empty-state microphone start and permission denial retry; fixed slots and two-sided flips with readable settled text');
 await denied.close();
 fs.writeFileSync('validation/field-invitation-result.json',JSON.stringify({testedAt:new Date().toISOString(),mode:'Chromium with synthetic microphone and mocked provider events; no paid provider calls',
  caption:'Tap to begin a conversation',pulseSeconds:3,iconSource:'Arrival welcome screen',iconScale:.65,
  checks:['idle invitation','active and connecting copy','real interim text replaces invitation','keyboard start','permission retry by click','reduced motion','desktop/mobile fit','existing voice and field regression suite'],pageErrors:errors},null,2)+'\n');
 fs.writeFileSync('validation/field-presentation-result.json',JSON.stringify({testedAt:new Date().toISOString(),mode:'Chromium with synthetic WebSocket speech and field snapshots; no paid provider calls',
  firstBatchArrivalsMs:arrivals.map(entry=>Math.round(entry.at-arrivals[0].at)),
  subsequentQuestionGapMs:Math.round(subsequentArrivals[1].at-subsequentArrivals[0].at),
  checks:['complete opening grid','700ms two-sided flips','stationary nine-slot layout','no gaps on sparse focus neighborhoods','ten-second hold after completion','2.5-second spacing between eligible slots','newest pending text','interrupted focus changes','reduced motion','queue cleared on reset','desktop/mobile geometry','35% smaller face','voice/transcript/recap/report lifecycle'],pageErrors:errors},null,2)+'\n');
} finally { await browser.close(); }
