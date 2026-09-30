import crypto from 'node:crypto';
import { nextTopicPosition, vacantNeighbors, type ConversationField, type FieldProposal } from '../shared/field.js';
import { DomainError, normalized } from './validation.js';

export function validateField(proposal: FieldProposal, field: ConversationField | undefined, text: string, sources: string[] = []) {
  const target = proposal.targetId && field && Object.hasOwn(field.cells, proposal.targetId) ? field.cells[proposal.targetId] : undefined;
  if (proposal.targetId !== null && !target) throw new DomainError('invalid_plan', 'Unknown field focus');
  if (!normalized(proposal.sourceQuote) || !normalized(text).includes(normalized(proposal.sourceQuote))) {
    throw new DomainError('invalid_plan', 'The current topic needs a quote from this turn');
  }
  const center = target || nextTopicPosition(field);
  const vacancies = vacantNeighbors(field, center);
  if (proposal.neighbors.length !== vacancies.length) {
    throw new DomainError('invalid_plan', `This focus needs exactly ${vacancies.length} new questions`);
  }
  const titles = new Set(Object.values(field?.cells || {})
    .filter(cell => Math.abs(cell.x - center.x) <= 1 && Math.abs(cell.y - center.y) <= 1)
    .map(cell => normalized(cell.title).toLowerCase()));
  titles.add(normalized(proposal.title).toLowerCase());
  for (const neighbor of proposal.neighbors) {
    const title = normalized(neighbor.title).toLowerCase();
    if (!title || !normalized(neighbor.question) || titles.has(title)) {
      throw new DomainError('invalid_plan', 'Blind spots must be distinct, nonempty questions');
    }
    titles.add(title);
  }
  if (!normalized(proposal.title) || !normalized(proposal.summary)) throw new DomainError('invalid_plan', 'The current topic cannot be empty');
  if (proposal.plan) {
    const evidence = [text, ...sources].map(normalized);
    for (const entry of [...proposal.plan.decisions, ...proposal.plan.nextSteps]) {
      const quote = normalized(entry.sourceQuote);
      if (!normalized(entry.text) || !quote || !evidence.some(source => source.includes(quote))) {
        throw new DomainError('invalid_plan', 'Plan decisions and next steps need exact supporting quotes from the conversation. Put unsupported suggestions in openQuestions, or leave the lists empty.');
      }
    }
  }
  const updates = new Set<string>();
  for (const update of proposal.updates || []) {
    if (!field || !Object.hasOwn(field.cells, update.targetId) || update.targetId === proposal.targetId || updates.has(update.targetId)) {
      throw new DomainError('invalid_plan', 'Invalid or duplicate related topic update');
    }
    if (!normalized(update.summary) || !normalized(update.sourceQuote) || !normalized(text).includes(normalized(update.sourceQuote))) {
      throw new DomainError('invalid_plan', 'Related topic updates need a quote from this turn');
    }
    updates.add(update.targetId);
  }
  if (Object.keys(field?.cells || {}).length + vacancies.length + (target ? 0 : 1) > 250) {
    throw new DomainError('field_limit', 'This conversation is full. Start a new conversation to keep exploring.', 429);
  }
}

export function applyField(field: ConversationField | undefined, proposal: FieldProposal, turnId: string): ConversationField {
  const next: ConversationField = field ? structuredClone(field) : { focusId: '', cells: {} };
  const existing = proposal.targetId ? next.cells[proposal.targetId] : undefined;
  const position = existing || nextTopicPosition(field);
  const vacancies = vacantNeighbors(field, position);
  const id = existing?.id || crypto.randomUUID();
  next.cells[id] = {
    id, x: position.x, y: position.y, title: existing?.title || proposal.title,
    question: existing?.question || '', summary: proposal.summary, visited: true,
    sourceRef: { turnId, quote: proposal.sourceQuote },
  };
  next.focusId = id;
  if (proposal.plan) next.plan = structuredClone(proposal.plan);
  for (const update of proposal.updates || []) {
    const cell = next.cells[update.targetId];
    cell.summary = update.summary;
    cell.visited = true;
    cell.sourceRef = { turnId, quote: update.sourceQuote };
  }
  vacancies.forEach((position, index) => {
    const question = proposal.neighbors[index];
    const id = crypto.randomUUID();
    next.cells[id] = { id, ...position, ...question, summary: '', visited: false };
  });
  return next;
}
