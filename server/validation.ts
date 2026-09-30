import AjvModule from 'ajv';
import fs from 'node:fs';
import path from 'node:path';
import type { Snapshot } from './db.js';

const Ajv = AjvModule.default || AjvModule;
const ajv = new Ajv({allErrors: true, strict: false});
export const previewSchema = JSON.parse(fs.readFileSync(path.resolve('PLAN/contracts/preview.schema.json'), 'utf8'));
export const finalSchema = JSON.parse(fs.readFileSync(path.resolve('PLAN/contracts/final-plan.schema.json'), 'utf8'));
const previewShape = ajv.compile<any>(previewSchema), finalShape = ajv.compile<any>(finalSchema);
export const normalized = (value: string) => value.replace(/\s+/g, ' ').trim();
export class DomainError extends Error {
  statusCode: number;
  constructor(public code: string, message: string, statusCode = 422) { super(message); this.statusCode = statusCode; }
}
function requireValid(ok: unknown, reason: string): asserts ok { if (!ok) throw new DomainError('invalid_plan', reason); }
function bounded(value: string, max: number, field: string) { requireValid(value.length <= max, `${field} exceeds ${max} characters`); }
export function validatePreview(value: any, text: string) {
  requireValid(previewShape(value), `Preview schema: ${ajv.errorsText(previewShape.errors)}`);
  bounded(value.ideaTitle,80,'ideaTitle'); bounded(value.ideaSummary,320,'ideaSummary');
  requireValid(value.draftItems.length <= 3, 'Preview has more than 3 items');
  const slots = new Set<string>();
  for (const item of value.draftItems) {
    requireValid(!slots.has(item.slot), 'Duplicate preview slot'); slots.add(item.slot);
    bounded(item.title,80,'draft title'); bounded(item.body,320,'draft body');
    requireValid(normalized(item.sourceQuote) && normalized(text).includes(normalized(item.sourceQuote)), 'Preview quote is absent from current transcript');
  }
  return value;
}
export function validateFinal(value:any, snapshot:Snapshot, sources:Map<string,string>, currentTurnId:string, branchIds:Set<string>, text:string) {
  requireValid(finalShape(value), `Final schema: ${ajv.errorsText(finalShape.errors)}`);
  requireValid(value.statements.length<=8 && value.links.length<=10 && value.issues.length<=2,'Final plan limits exceeded');
  bounded(value.assistantText,600,'assistantText');
  const refs = new Set<string>();
  function unique(ref:string) { requireValid(ref.length>0 && !refs.has(ref) && !snapshot.nodes[ref],`Duplicate or colliding ref ${ref}`); refs.add(ref); }
  for(const s of value.statements)unique(s.ref);
  for(const issue of value.issues)unique(issue.ref);
  if(value.question){unique(value.question.ref); for(const option of value.question.options)unique(option.ref);}
  const nodeRefs=new Set<string>([...value.statements.map((s:any)=>s.ref),...value.issues.map((i:any)=>i.ref),...(value.question?[value.question.ref]:[])]);
  const resolve=(ref:string|null)=>ref===null||nodeRefs.has(ref)||Boolean(snapshot.nodes[ref]);
  const checkSources=(list:any[], requireCurrent:boolean)=>{
    for(const source of list){const sourceText=sources.get(source.turnId);requireValid(sourceText && normalized(source.quote) && normalized(sourceText).includes(normalized(source.quote)), 'Source quote is missing or belongs to another project');}
    if(requireCurrent)requireValid(list.some(s=>s.turnId===currentTurnId),'Selected user statement requires current user source');
  };
  const targets=new Set<string>();const selectedDomains=new Set<string>(); let ideaCount=0;
  for(const s of value.statements){
    bounded(s.title,80,'statement title'); bounded(s.body,600,'statement body');
    if(s.disposition==='selected'&&['audience','payment'].includes(s.domain)){requireValid(!selectedDomains.has(s.domain),'Multiple selected alternatives in the same domain require separate branches');selectedDomains.add(s.domain);}
    if(s.kind==='idea'){ideaCount++;const root=Object.values(snapshot.nodes).find((n:any)=>n.kind==='idea');requireValid(!root?.locked,'The idea is locked');if(s.targetId)requireValid(snapshot.nodes[s.targetId]?.kind==='idea','An idea may only update the root');}
    if(s.targetId && snapshot.nodes[s.targetId]?.kind==='idea')requireValid(s.kind==='idea','The root kind cannot change');
    if(s.targetId){requireValid(snapshot.nodes[s.targetId],'Statement target is not in current branch'); requireValid(!targets.has(s.targetId),'Multiple mutations target the same node'); targets.add(s.targetId);
      // Only direct manual edit commands may alter locked content; the planner cannot infer consent.
      requireValid(!snapshot.nodes[s.targetId].locked,'A locked node requires an explicit addressed manual command');}
    requireValid(s.requestedLock!==false,'The planner cannot unlock a node');
    checkSources(s.sourceRefs,s.disposition==='selected');
  }
  requireValid(ideaCount<=1,'Only one root idea is permitted');
  for(const l of value.links){requireValid(resolve(l.sourceRef)&&resolve(l.targetRef),'Unresolved semantic link'); bounded(l.label,120,'link label');}
  for(const issue of value.issues){bounded(issue.title,80,'issue title');for(const name of ['rationale','consequence','proposedChange','testSuggestion'])bounded(issue[name],600,name);requireValid(issue.relatedRefs.every(resolve),'Unresolved issue basis');checkSources(issue.sourceRefs,false);}
  if(value.question){const q=value.question;bounded(q.prompt,220,'question prompt');bounded(q.reason,600,'question reason');requireValid([0,2,3].includes(q.options.length),'Question requires zero, two, or three options');requireValid(resolve(q.targetRef)&&q.targetRef!==q.ref,'Unknown or self-referential question target');for(const o of q.options){bounded(o.label,60,'option label');bounded(o.meaning,600,'option meaning');}}
  requireValid(resolve(value.focusRef),'Unknown focus reference');
  if(value.branchIntent){const intent=value.branchIntent; requireValid(intent.sourceBranchId===snapshot.branchId,'Branch source must be current branch');bounded(intent.label,80,'branch label');
    if(intent.action==='create'){requireValid(intent.targetBranchId===null && intent.forkNodeId && snapshot.nodes[intent.forkNodeId],'Invalid fork destination');if(intent.exploreNow)requireValid(/(?:explore|try|go with|investigat|let.s|what if)/i.test(text),'Exploring requires explicit user intent');}
    else {requireValid(intent.targetBranchId && branchIds.has(intent.targetBranchId) && intent.forkNodeId===null,'Invalid branch target');requireValid(!value.statements.length&&!value.links.length&&!value.issues.length&&!value.question,'Navigation must not include content mutations');}
  }
  return value;
}
