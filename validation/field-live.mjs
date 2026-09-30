import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildApp } from '../server/index.ts';
import { db } from '../server/db.ts';
const originalFetch=globalThis.fetch;
const proposals=[];
globalThis.fetch=async (...args)=>{const response=await originalFetch(...args);const data=await response.clone().json().catch(()=>null);if(data?.content)proposals.push(data.content);else if(data?.choices)proposals.push(data.choices);return response;};
const app=await buildApp();
let cookie, project;
const evidence=[];
try {
 const guest=await app.inject({method:'POST',url:'/api/guest',payload:{accessCode:process.env.DEMO_ACCESS_CODE}});
 assert.equal(guest.statusCode,200);
 cookie=guest.headers['set-cookie'].split(';')[0];
 const created=await app.inject({method:'POST',url:'/api/projects',headers:{cookie},payload:{title:'Temporary pivot validation',language:'en'}});
 assert.equal(created.statusCode,201);project=created.json();
 let snapshot=project.branches[0].snapshot;
 for (const text of [
  'We are planning an editorial photoshoot for our autumn collection. We need to work out the practical details before we commit to a date.',
  'Let us focus on booking the models. We need two models for a full day, but nobody has contacted an agency yet.',
  'The studio is already booked for Friday. For the models, we still need to agree on their rates and availability.',
 ]) {
  const began=Date.now();
  const result=await app.inject({method:'POST',url:`/api/projects/${project.id}/text-turns`,headers:{cookie},payload:{text,language:'en',branchId:snapshot.branchId,expectedRevision:snapshot.revision,operationId:crypto.randomUUID(),muted:true,clientId:'pivot-smoke'}});
  assert.equal(result.statusCode,200,result.body);
  const next=result.json().snapshot;
  assert.ok(next.field,'A meaningful conversation must produce a field');
  assert.ok(next.field.plan?.summary,'Each real update includes a cumulative conversation plan');
  assert.ok(Array.isArray(next.field.plan.decisions)&&Array.isArray(next.field.plan.nextSteps)&&Array.isArray(next.field.plan.openQuestions));
  const focus=next.field.cells[next.field.focusId];
  const neighbors=Object.values(next.field.cells).filter(cell=>Math.abs(cell.x-focus.x)<=1&&Math.abs(cell.y-focus.y)<=1&&cell.id!==focus.id);
  assert.equal(neighbors.length,8);
  if(snapshot.field)for(const cell of Object.values(snapshot.field.cells)){assert.equal(next.field.cells[cell.id].x,cell.x);assert.equal(next.field.cells[cell.id].y,cell.y)}
  evidence.push({input:text,elapsedMs:Date.now()-began,focus:focus.title,summary:focus.summary,plan:next.field.plan,totalCells:Object.keys(next.field.cells).length,neighbors:neighbors.map(cell=>({title:cell.title,question:cell.question,summary:cell.summary,visited:cell.visited}))});
  snapshot=next;
  console.log(JSON.stringify({focus:focus.title,cells:Object.keys(next.field.cells).length,elapsedMs:Date.now()-began}));
 }
 fs.writeFileSync('validation/field-live-result.json',JSON.stringify({testedAt:new Date().toISOString(),provider:process.env.LLM_PROVIDER||'openrouter',model:process.env.LLM_MODEL,mode:'real configured planner; synthetic conversation; no microphone input',turns:evidence},null,2)+'\n');
} finally {
 fs.writeFileSync('validation/field-live-proposals.json',JSON.stringify(proposals,null,2)+'\n');
 if(project&&cookie)await app.inject({method:'DELETE',url:`/api/projects/${project.id}`,headers:{cookie}});
 await app.close(); db.close();
}
