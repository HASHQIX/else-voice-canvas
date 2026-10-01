import { DomainError, finalSchema } from './validation.js';

/** Narrow model contract; the existing persistence protocol stays server-owned. */
export function fieldModelSchema(context: { newTopicVacancies: number; cells: Array<{ id: string; vacancies: number }> }, options: { compact?: boolean } = {}) {
  if (options.compact) {
    // Gemini rejects large unions and growing UUID enums. Keep a constant shape;
    // validateField still checks target membership and the vacancy limit
    // before persistence, using the existing repair path on a mismatch.
    const shape = structuredClone(finalSchema.properties.field.anyOf[1]);
    shape.required.push('plan');
    if (!context.cells.length) shape.properties.targetId = { type: 'null' };
    return { type: 'object', properties: { field: { anyOf: [{ type: 'null' }, shape] } }, required: ['field'], additionalProperties: false };
  }
  const groups = new Map<number, Array<string | null>>();
  groups.set(context.newTopicVacancies, [null]);
  for (const cell of context.cells) {
    const ids = groups.get(cell.vacancies) || [];
    ids.push(cell.id); groups.set(cell.vacancies, ids);
  }
  const variants = [...groups].map(([count, ids]) => {
    const shape = structuredClone(finalSchema.properties.field.anyOf[1]);
    // Saved legacy proposals can omit the plan; every new model update supplies it.
    shape.required.push('plan');
    const strings = ids.filter((id): id is string => id !== null);
    shape.properties.targetId = { anyOf: [
      ...(strings.length ? [{ type: 'string', enum: strings }] : []),
      ...(ids.includes(null) ? [{ type: 'null' }] : []),
    ] };
    shape.properties.neighbors.minItems = 0;
    shape.properties.neighbors.maxItems = count;
    return shape;
  });
  return { type: 'object', properties: { field: { anyOf: [{ type: 'null' }, ...variants] } }, required: ['field'], additionalProperties: false };
}

export function asFinalPlan(value: any) {
  // Legacy clients/tests may still supply the complete plan envelope.
  if (!value || typeof value !== 'object' || Object.hasOwn(value, 'statements')) return value;
  if (!Object.hasOwn(value, 'field') || Object.keys(value).some(key => key !== 'field')) {
    throw new DomainError('invalid_plan', 'Expected a field response');
  }
  if (value.field && !value.field.plan) throw new DomainError('invalid_plan', 'A meaningful field update needs a cumulative conversation plan');
  return { language: 'en', intent: value.field ? 'develop' : 'no_change', statements: [], links: [], issues: [], branchIntent: null,
    question: null, assistantText: '', focusRef: null, field: value.field };
}
