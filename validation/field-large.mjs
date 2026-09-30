import assert from 'node:assert/strict';
import fs from 'node:fs';
import { db } from '../server/db.ts';
import { generateFinal } from '../server/providers.ts';
import { validateField, applyField } from '../server/field.ts';
import { fieldContext } from '../shared/field.ts';
import { fieldModelSchema } from '../server/field-schema.ts';

// Synthetic large conversation; no user text or saved project is read or changed.
const cells={};
const rowLengths=[9,7,11,5,9,6,10,8,8];
for(const [y,length] of rowLengths.entries())for(let x=0;x<length;x++){
 const id=crypto.randomUUID();
 cells[id]={id,x,y,title:x===4&&y===4?'Budget':`Shoot detail ${x} ${y}`,question:'What do we need to clarify?',summary:'',visited:false};
}
const target=Object.values(cells).find(cell=>cell.title==='Budget');
const field={cells,focusId:Object.keys(cells)[0],plan:{title:'Editorial photoshoot',summary:'Planning an editorial shoot.',decisions:[],nextSteps:[],openQuestions:['What is the total budget?']}};
const context=fieldContext(field);
const text='Let us focus on the budget. We have 3000 dollars for this photoshoot.';
const began=Date.now();
try {
 const plan=await generateFinal(text,'en',{conversationField:context,currentTurnId:'synthetic-large-turn'});
 assert.ok(plan.field,'A meaningful turn must update the field');
 assert.equal(plan.field.targetId,target.id,'Reuse the existing budget topic');
 validateField(plan.field,field,text);
 const next=applyField(field,plan.field,'synthetic-large-turn');
 for(const cell of Object.values(field.cells))assert.deepEqual([next.cells[cell.id].x,next.cells[cell.id].y],[cell.x,cell.y]);
 const focus=next.cells[next.focusId];
 assert.equal(Object.values(next.cells).filter(cell=>Math.abs(cell.x-focus.x)<=1&&Math.abs(cell.y-focus.y)<=1).length,9);
 const evidence={testedAt:new Date().toISOString(),provider:process.env.LLM_PROVIDER,model:process.env.LLM_MODEL,synthetic:true,cells:Object.keys(cells).length,vacancyCounts:[...new Set(context.cells.map(cell=>cell.vacancies))].sort(),schemaBytes:JSON.stringify(fieldModelSchema(context,{compact:true})).length,elapsedMs:Date.now()-began,focus:focus.title,neighbors:plan.field.neighbors.length,validated:true};
 fs.writeFileSync('validation/field-large-result.json',JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify(evidence));
} finally {db.close();}
