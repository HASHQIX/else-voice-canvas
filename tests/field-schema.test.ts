import { expect, it } from 'vitest';
import AjvModule from 'ajv';
import { asFinalPlan, fieldModelSchema } from '../server/field-schema.js';
import { applyField, validateField } from '../server/field.js';
import { fieldContext } from '../shared/field.js';
const Ajv = AjvModule.default || AjvModule;
const ajv = new Ajv({ strict: false });
it('constrains each focus destination to the exact vacant neighbor count', () => {
 const validate=ajv.compile(fieldModelSchema({newTopicVacancies:8,cells:[{id:'existing',vacancies:0},{id:'neighbor',vacancies:5}]}));
 const field={targetId:null as string|null,title:'Topic',summary:'Summary',sourceQuote:'Quote',updates:[],plan:{title:'Overall conversation',summary:'What we know.',decisions:[],nextSteps:[],openQuestions:['What is still unknown?']},neighbors:Array.from({length:8},(_,i)=>({title:`Topic ${i}`,question:'Question?'}))};
 expect(validate({field})).toBe(true);
 expect(validate({field:{...field,neighbors:[]}})).toBe(false);
 expect(validate({field:{...field,targetId:'existing',neighbors:[]}})).toBe(true);
 expect(validate({field:{...field,targetId:'neighbor',neighbors:field.neighbors.slice(0,5)}})).toBe(true);
 expect(validate({field:{...field,targetId:'invented'}})).toBe(false);
 expect(validate({field:null})).toBe(true);
 const {plan,...withoutPlan}=field;
 expect(validate({field:withoutPlan})).toBe(false);
 expect(validate({field:{...field,plan:{...plan,nextSteps:[{text:'x'.repeat(241),sourceQuote:'A quote'}]}}})).toBe(false);
 expect(validate({field:{...field,plan:{...plan,nextSteps:[{text:'Book models.'}]}}})).toBe(false);
 expect(validate({field:{...field,plan:{...plan,decisions:Array(13).fill('A decision')}}})).toBe(false);
});
it('rejects an unrelated model response instead of treating it as a saved no-change',()=>{
 expect(()=>asFinalPlan({something:'else'})).toThrow('Expected a field response');
 expect(()=>asFinalPlan({field:{title:'A topic'}})).toThrow('cumulative conversation plan');
 expect(asFinalPlan({field:null})).toMatchObject({intent:'no_change',field:null,statements:[]});
});

it('keeps a single Gemini plan shape as the conversation reaches its 250-cell limit',()=>{
 const cells=Array.from({length:250},(_,i)=>({id:`cell-${i}`,vacancies:i%9}));
 const schema=fieldModelSchema({newTopicVacancies:7,cells},{compact:true});
 const validate=ajv.compile(schema);
 const proposal={targetId:'cell-249',title:'Topic',summary:'Summary',sourceQuote:'Quote',updates:[],neighbors:[],plan:{title:'Plan',summary:'Summary',decisions:[],nextSteps:[],openQuestions:[]}};
 expect(schema.properties.field.anyOf).toHaveLength(2);
 expect(validate({field:proposal})).toBe(true);
 // Target membership is checked against saved state, not a growing provider enum.
 expect(validate({field:{...proposal,targetId:'unknown'}})).toBe(true);
 expect(schema).toEqual(fieldModelSchema({newTopicVacancies:3,cells:cells.slice(0,9)},{compact:true}));
 expect(validate({field:{...proposal,plan:undefined}})).toBe(false);
 expect(validate({field:{...proposal,neighbors:Array(9).fill({title:'Topic',question:'Question?'})}})).toBe(false);
 expect(validate({field:null})).toBe(true);
 expect(validate({field:{...proposal,plan:{...proposal.plan,nextSteps:[{text:'An action without a quote'}]}}})).toBe(false);
 expect(ajv.compile(fieldModelSchema({newTopicVacancies:8,cells:[]},{compact:true}))({field:proposal})).toBe(false);
});

it('enforces exact vacancy counts and supporting quotes after compact schema parsing',()=>{
 const proposal={targetId:null as string|null,title:'Photoshoot',summary:'An editorial shoot.',sourceQuote:'Plan a shoot',updates:[],neighbors:Array.from({length:8},(_,i)=>({title:`Topic ${i}`,question:'What should we clarify?'})),plan:{title:'Shoot plan',summary:'An editorial shoot.',decisions:[],nextSteps:[],openQuestions:[]}};
 const field=applyField(undefined,proposal,'turn');
 const context=fieldContext(field),target=context.cells.find(cell=>cell.vacancies===5)!;
 const candidate={...proposal,targetId:target.id,title:'New details',neighbors:proposal.neighbors.slice(0,4)};
 expect(ajv.compile(fieldModelSchema(context,{compact:true}))({field:candidate})).toBe(true);
 expect(()=>validateField(candidate,field,'Plan a shoot.')).toThrow('exactly 5');
 const correct={...candidate,neighbors:Array.from({length:5},(_,i)=>({title:`New question ${i}`,question:'What is missing?'}))};
 expect(()=>validateField(correct,field,'Plan a shoot.')).not.toThrow();
 expect(()=>validateField({...correct,targetId:'unknown'},field,'Plan a shoot.')).toThrow('Unknown field focus');
 expect(()=>validateField({...correct,sourceQuote:'Made up'},field,'Plan a shoot.')).toThrow('quote');
});
