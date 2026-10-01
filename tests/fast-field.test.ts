import { expect, it } from 'vitest';
import { fastContext, recentTurns } from '../server/fast-context.js';
import { fastProposal, recapProposal } from '../server/fast-schema.js';
import { applyField, validateField } from '../server/field.js';
import type { ConversationField, FieldProposal } from '../shared/field.js';

const words = 'We need two models, but the studio is not booked.';
const proposal: FieldProposal = { targetId: null, title: 'Editorial shoot', summary: 'Two models needed; studio unbooked.', sourceQuote: words,
  updates: [], questionUpdates: [], neighbors: ['Models', 'Studio', 'Budget'].map(title => ({ title, question: `What about ${title}?` })) };
const opening: FieldProposal = { ...proposal, neighbors: ['Models', 'Studio', 'Budget', 'Dates', 'Rights', 'Crew', 'Style', 'Backup'].map(title => ({ title, question: `What about ${title}?` })) };

it('allows a sparse opening rather than forcing filler, while bounding later batches', () => {
  expect(fastContext(undefined, words, []).conversationField.isInitial).toBe(true);
  expect(fastProposal({ field: null }, true)).toEqual({ field: null });
  const parsed = fastProposal({ field: opening }, true);
  validateField(parsed.field!, undefined, words, [], true);
  const saved = applyField(undefined, parsed.field!, 'opening');
  expect(Object.keys(saved.cells)).toHaveLength(9);
  expect(fastContext(saved, words, []).conversationField.isInitial).toBe(false);
  expect(fastProposal({ field: proposal }, true).field?.neighbors).toHaveLength(3);
  validateField(proposal, undefined, words, [], true);
  expect(Object.keys(applyField(undefined, proposal, 'sparse').cells)).toHaveLength(4);
  expect(() => fastProposal({ field: { ...proposal, neighbors: [] } }, true)).toThrow('schema');
  expect(() => validateField({ ...proposal, neighbors: [] }, undefined, words, [], true)).toThrow('at least one');
  expect(() => fastProposal({ field: { ...opening, neighbors: [...opening.neighbors, { title: 'Extra', question: 'What is missing?' }] } }, true)).toThrow('schema');
  expect(() => fastProposal({ field: opening })).toThrow('schema');
  const partial = applyField(undefined, { ...proposal, neighbors: [] }, 'legacy');
  expect(() => validateField({ ...opening, targetId: partial.focusId }, partial, words, [], true)).toThrow('at most 3');
});

it('bounds field context independently of history size and recalls matching older topics', () => {
  const field: ConversationField = { focusId: '0', cells: {} };
  for (let i = 0; i < 250; i++) field.cells[String(i)] = { id: String(i), x: i % 25, y: Math.floor(i / 25),
    title: i === 249 ? 'Studio booking' : `Topic ${i}`, summary: '', question: 'What remains unclear?', visited: i % 2 === 0 };
  const turns = Array.from({ length: 100 }, (_, i) => ({ text: `Statement ${i}: ${'x'.repeat(480)} is not confirmed.`, speaker: 'Person 1', sessionId: 'session' }));
  const context = fastContext(field, words, turns);
  expect(context.text).toBe(words);
  expect(context.conversationField.cells.length).toBeLessThanOrEqual(12);
  expect(context.conversationField.cells.some(cell => cell.id === '249')).toBe(true);
  expect(context.speakerTurns.reduce((n, turn) => n + turn.text.length, 0)).toBeLessThanOrEqual(2400);
  expect(context.speakerTurns.every(turn => turn.text.endsWith('is not confirmed.'))).toBe(true);
  expect(context).not.toHaveProperty('sources');
  expect(context).not.toHaveProperty('snapshot');
  expect(JSON.stringify(context).length).toBeLessThan(6000);
  expect(recentTurns([{ text: 'x'.repeat(3000) + ' not agreed' }])).toEqual([]);
});

it('accepts three incremental questions, preserves history and refreshes only unanswered neighbors', () => {
  const parsed = fastProposal({ field: proposal });
  // Older partial fields can still be extended without replaying the opening.
  const legacy = applyField(undefined, { ...proposal, neighbors: [] }, 'legacy');
  validateField({ ...parsed.field!, targetId: legacy.focusId }, legacy, words, [], true);
  const original = applyField(undefined, proposal, 'one');
  const model = Object.values(original.cells).find(cell => cell.title === 'Models')!;
  const nextProposal = { ...proposal, targetId: original.focusId, neighbors: [{ title: 'Rights', question: 'Where will images run?' }],
    questionUpdates: [{ targetId: model.id, question: 'Are both models available on Friday?' }] };
  validateField(nextProposal, original, words, [], true);
  const after = applyField(original, nextProposal, 'two');
  expect(Object.keys(after.cells)).toHaveLength(5);
  for (const cell of Object.values(original.cells)) expect(after.cells[cell.id]).toMatchObject({ id: cell.id, x: cell.x, y: cell.y, title: cell.title });
  expect(original.cells[model.id].question).toBe('What about Models?');
  expect(after.cells[model.id].question).toBe('Are both models available on Friday?');
  expect(() => validateField({ ...nextProposal, questionUpdates: [{ targetId: original.focusId, question: 'Overwrite?' }] }, original, words, [], true)).toThrow('unvisited');
  const distant = structuredClone(original); distant.cells[model.id].x = 30;
  expect(() => validateField(nextProposal, distant, words, [], true)).toThrow('unvisited');
  expect(() => validateField({ ...nextProposal, questionUpdates: [...nextProposal.questionUpdates, ...nextProposal.questionUpdates] }, original, words, [], true)).toThrow('unvisited');
});

it('rejects oversized fast output, a cumulative plan, invented targets and invented source quotes', () => {
  expect(() => fastProposal({ field: { ...proposal, neighbors: [...proposal.neighbors, { title: 'Dates', question: 'When?' }] } })).toThrow('schema');
  expect(() => fastProposal({ field: { ...proposal, plan: {} } })).toThrow('schema');
  expect(() => fastProposal({ field: { ...proposal, questionUpdates: undefined } })).toThrow('schema');
  expect(() => validateField({ ...proposal, targetId: '__proto__' }, undefined, words, [], true)).toThrow('Unknown');
  expect(() => validateField({ ...proposal, sourceQuote: 'studio is booked' }, undefined, words, [], true)).toThrow('quote');
});

it('requires supporting quotes for a recap, including retained prior decisions', () => {
  const plan = { title: 'Editorial shoot', summary: 'Studio unbooked.', decisions: [{ text: 'Studio unbooked.', sourceQuote: 'studio is not booked' }], nextSteps: [], openQuestions: ['Who books it?'] };
  expect(recapProposal({ plan }, [words])).toEqual(plan);
  expect(() => recapProposal({ plan }, ['The models are available.'])).toThrow('supporting quotes');
  expect(() => recapProposal({ plan: { ...plan, nextSteps: [{ text: 'Pay deposit', sourceQuote: '' }] } }, [words])).toThrow();
});

it('clears queued recap work when a compatibility response supplies a complete plan', () => {
  const original = { ...applyField(undefined, proposal, 'one'), planPending: true, planPendingTurnIds: ['one'] };
  const plan = { title: 'Shoot', summary: 'Planning.', decisions: [], nextSteps: [], openQuestions: ['When?'] };
  const updated = applyField(original, { ...proposal, targetId: original.focusId, neighbors: [], plan }, 'two');
  expect(updated).toMatchObject({ plan, planPending: false, planPendingTurnIds: [] });
  expect(original.planPendingTurnIds).toEqual(['one']);
});
