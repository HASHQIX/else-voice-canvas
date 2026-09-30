import assert from 'node:assert/strict';
import fs from 'node:fs';
import { db } from '../server/db.ts';
import { generateFinal } from '../server/providers.ts';
import { applyField, validateField } from '../server/field.ts';
import { fieldContext } from '../shared/field.ts';

// Synthetic conversation only; run with DATABASE_PATH=:memory: so no saved
// conversation or production reservation ledger is read or changed.
assert.equal(process.env.DATABASE_PATH, ':memory:');
const earlier = 'We are planning an autumn photoshoot. We need two models. I will contact the agency about availability. Friday is only tentative. The budget and studio are undecided. The backdrop color can wait.';
let field = applyField(undefined, {
  targetId: null, title: 'Photoshoot planning', summary: 'An autumn shoot with bookings still open.', sourceQuote: 'planning an autumn photoshoot',
  neighbors: ['Models', 'Budget', 'Studio', 'Date', 'Backdrop', 'Crew', 'Usage rights', 'Equipment'].map(title => ({ title, question: `What do we need to confirm about ${title.toLowerCase()}?` })),
  plan: { title: 'Autumn photoshoot', summary: 'Planning an autumn photoshoot with two models.', decisions: [{ text: 'Two models are needed.', sourceQuote: 'We need two models' }], nextSteps: [{ text: 'Contact the agency about availability.', sourceQuote: 'I will contact the agency about availability' }], openQuestions: ['Which backdrop color?', 'Are the models available?', 'Is Friday confirmed?', 'What is the budget?', 'Which studio?'] },
}, 'priorities-1');
const turns = [
  'I contacted the agency and both models are booked. Friday is confirmed. The budget is still undecided and that is blocking the studio choice. We need to settle the budget before anything else. I will call the studio once the budget is agreed. Backdrop color can wait.',
  'Correction: Friday is not confirmed and neither are the models. The agency has not confirmed anything; my previous update was premature. I still need to confirm their availability. The budget is still our first blocker; let us resolve it before choosing a studio.',
];
const sources = [{ id: 'priorities-1', text: earlier }];
const results = [];
try {
  for (const [index, text] of turns.entries()) {
    const turnId = `priorities-${index + 2}`;
    const started = Date.now();
    const proposal = await generateFinal(text, 'en', { conversationField: fieldContext(field), currentTurnId: turnId, sources });
    assert.ok(proposal.field?.plan, 'Meaningful speech updates the working plan');
    validateField(proposal.field, field, text, sources.map(source => source.text));
    field = applyField(field, proposal.field, turnId);
    results.push({ turn: index + 1, elapsedMs: Date.now() - started, plan: field.plan });
    sources.push({ id: turnId, text });
  }
  assert.match(results[0].plan.openQuestions[0], /budget/i, 'The explicit blocker leads the questions');
  assert.ok(!results[0].plan.nextSteps.some(entry => /contact.*agency/i.test(entry.text)), 'A completed action leaves Next steps');
  assert.ok(results[0].plan.decisions.some(entry => /models.*booked|booked.*models/i.test(entry.text)), 'Confirmed booking is recorded as settled');
  assert.match(results[1].plan.openQuestions[0], /budget/i, 'An earlier blocker survives a topic correction');
  assert.ok(results[1].plan.openQuestions.some(text => /Friday|date|availability|models/i.test(text)), 'Retracted confirmations reopen a question');
  const evidence = { testedAt: new Date().toISOString(), synthetic: true, provider: process.env.LLM_PROVIDER, model: process.env.LLM_MODEL, results };
  fs.writeFileSync('validation/field-priorities-result.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  db.close();
}
