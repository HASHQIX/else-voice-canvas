import { chromium } from '@playwright/test';
import fs from 'node:fs';
import assert from 'node:assert/strict';

// Supply a synthetic English PCM WAV; this never records the user's microphone.
const audio = process.argv[2];
if (!audio || !fs.existsSync(audio)) throw new Error('Pass the path to a synthetic English PCM WAV as the first argument.');
const browser = await chromium.launch({ headless:true, channel:'chrome', args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${audio}%noloop`,'--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport:{width:1440,height:1000},permissions:['microphone'] });
const request = context.request;
const origin='http://127.0.0.1:5173';
let project;
try {
 const guest=await request.post(`${origin}/api/guest`,{data:{accessCode:process.env.DEMO_ACCESS_CODE}});assert.equal(guest.status(),200);
 const response=await request.post(`${origin}/api/projects`,{data:{title:'Temporary real voice validation',language:'en'}});assert.equal(response.status(),201);project=await response.json();
 await context.addInitScript(id=>localStorage.setItem('else.project',id),project.id);
 const page=await context.newPage();
 const wire=[],errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.on('websocket',socket=>socket.on('framereceived',({payload})=>{if(typeof payload==='string'){const message=JSON.parse(payload);wire.push({type:message.type,payload:message.payload});}}));
 await page.goto(origin);
 await page.getByRole('button',{name:'Pause microphone',exact:true}).waitFor({timeout:20000});
 await page.locator('.field-cell.current').waitFor({timeout:90000});
 await page.waitForTimeout(1000);
 assert.equal(await page.locator('.field-cell[data-visible=true]').count(),9);
 assert.ok(wire.some(message=>message.type==='fork.transcript'&&message.payload.text));
 assert.ok(wire.some(message=>message.type==='fork.committed'));
 const title=await page.locator('.field-cell.current h2').innerText();
 const questions=await page.locator('.field-cell:not(.current)[data-visible=true] .cell-copy').allInnerTexts();
 await page.screenshot({path:'validation/field-real-voice.png'});
 await page.getByRole('button',{name:'Pause microphone',exact:true}).click();
 await page.getByRole('button',{name:'Resume microphone',exact:true}).waitFor({timeout:70000});
 const historyResponse=await request.get(`${origin}/api/projects/${project.id}/transcript`);
 assert.equal(historyResponse.status(),200);
 const {segments}=await historyResponse.json();
 assert.ok(segments.length>0,'Real speech is saved independently of the planner');
 assert.deepEqual(await page.locator('.transcript-scroll [data-segment-id]').allTextContents(),[...segments].reverse().map(segment=>segment.text),'The sidebar shows the complete saved speech newest first after stopping');
 await page.reload();
 await page.locator('.transcript-scroll [data-segment-id]').first().waitFor();
 for(const segment of segments)assert.equal(await page.locator(`[data-segment-id="${segment.id}"]`).textContent(),segment.text,'Reload restores recognized words');
 await page.getByRole('button',{name:'Pause microphone',exact:true}).waitFor();
 await page.getByRole('button',{name:'Pause microphone',exact:true}).click();
 await page.getByRole('button',{name:'Resume microphone',exact:true}).waitFor({timeout:70000});
 assert.deepEqual(errors,[]);
 const evidence={testedAt:new Date().toISOString(),mode:'Real browser AudioWorklet capture of synthetic English speech, real AssemblyAI and configured planner',title,questions,transcripts:wire.filter(message=>message.type==='fork.transcript').map(message=>message.payload.text),errors:wire.filter(message=>message.type==='fork.error').map(message=>message.payload)};
 fs.writeFileSync('validation/field-voice-result.json',JSON.stringify(evidence,null,2)+'\n');
 assert.deepEqual(evidence.errors,[]);
 console.log(JSON.stringify({title,visibleCells:9,transcripts:evidence.transcripts.length,savedSegments:segments.length,historyRestored:true,voiceErrors:evidence.errors.length}));
} finally {
 if(project)await request.delete(`${origin}/api/projects/${project.id}`);
 await browser.close();
}
