import AjvModule from 'ajv';
import { finalSchema, DomainError, normalized } from './validation.js';
import type { ConversationPlan, FieldProposal } from '../shared/field.js';
const Ajv = AjvModule.default || AjvModule;
const ajv = new Ajv({ strict: false, allErrors: true });
const field = structuredClone(finalSchema.properties.field.anyOf[1]);
delete field.properties.plan;
field.required = field.required.filter((name: string) => name !== 'plan');
field.properties.neighbors.maxItems = 3;
field.properties.updates.maxItems = 2;
field.properties.questionUpdates = { type: 'array', maxItems: 2, items: {
  type: 'object', properties: { targetId: { type: 'string', minLength: 1 }, question: { type: 'string', minLength: 1, maxLength: 160 } },
  required: ['targetId', 'question'], additionalProperties: false,
} };
field.required.push('questionUpdates');
export const fastSchema = { type: 'object', properties: { field: { anyOf: [{ type: 'null' }, field] } }, required: ['field'], additionalProperties: false };
export const initialFastSchema = structuredClone(fastSchema);
initialFastSchema.properties.field.anyOf[1].properties.neighbors.minItems = 1;
initialFastSchema.properties.field.anyOf[1].properties.neighbors.maxItems = 8;
export const recapSchema = { type: 'object', properties: { plan: structuredClone(finalSchema.properties.field.anyOf[1].properties.plan) }, required: ['plan'], additionalProperties: false };
const checkFast = ajv.compile(fastSchema), checkInitialFast = ajv.compile(initialFastSchema), checkRecap = ajv.compile(recapSchema);
export function fastProposal(value: unknown, initial = false): { field: FieldProposal | null } {
  const check = initial ? checkInitialFast : checkFast;
  if (!check(value)) throw new DomainError('invalid_plan', `Fast field schema: ${ajv.errorsText(check.errors)}`);
  return value as { field: FieldProposal | null };
}
export function recapProposal(value: unknown, evidence: string[]): ConversationPlan {
  if (!checkRecap(value)) throw new DomainError('invalid_plan', `Recap schema: ${ajv.errorsText(checkRecap.errors)}`);
  const plan = (value as { plan: ConversationPlan }).plan;
  const quotes = evidence.map(normalized);
  for (const entry of [...plan.decisions, ...plan.nextSteps]) {
    const quote = normalized(entry.sourceQuote);
    if (!quote || !quotes.some(text => text.includes(quote))) throw new DomainError('invalid_plan', 'Recap entries need exact supporting quotes');
  }
  return plan;
}
