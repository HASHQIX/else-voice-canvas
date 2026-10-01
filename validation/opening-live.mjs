// Configured LLM, synthetic conversation; normal application budget accounting.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { structuredResponse } from '../server/providers.ts';
import { fastContext } from '../server/fast-context.ts';
import { fastProposal } from '../server/fast-schema.ts';
import { applyField, validateField } from '../server/field.ts';
import { db } from '../server/db.ts';

const results = [];
let field;
const history = [];
try {
  for (const text of [
    'We are planning an editorial photoshoot for our autumn clothing collection. We need two models for one full day. The studio, date, usage rights and budget are not decided yet.',
    'Let us focus on booking the models. We need to check their availability and usage fees before choosing anyone.',
  ]) {
    history.push({ text, speaker: 'Person 1', sessionId: 'synthetic-opening' });
    const input = fastContext(field, text, history), start = performance.now();
    let raw, proposal, error;
    const repairs = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      raw = await structuredResponse('fast', input, undefined, error ? { proposal: raw, errors: error.message } : undefined);
      try {
        proposal = fastProposal(raw, !field).field;
        assert.ok(proposal, 'Meaningful synthetic speech must generate a field');
        validateField(proposal, field, text, [], true);
        error = undefined;
        break;
      } catch (issue) { error = issue; repairs.push(issue.message); }
    }
    if (error) throw error;
    const saved = applyField(field, proposal, `synthetic-opening-${history.length}`);
    if (!field) {
      assert.equal(proposal.neighbors.length, 8);
      assert.equal(Object.keys(saved.cells).length, 9);
    } else {
      assert.ok(proposal.neighbors.length <= 3);
      for (const cell of Object.values(field.cells)) {
        assert.ok(saved.cells[cell.id], 'Previously saved cards remain available');
        assert.deepEqual([saved.cells[cell.id].x, saved.cells[cell.id].y], [cell.x, cell.y]);
      }
    }
    results.push({ isInitial: !field, elapsedMs: Math.round(performance.now() - start),
      generatedQuestions: proposal.neighbors.length, totalCells: Object.keys(saved.cells).length, repairs, proposal });
    field = saved;
  }
  fs.writeFileSync('validation/opening-live-result.json', JSON.stringify({ testedAt: new Date().toISOString(),
    provider: process.env.LLM_PROVIDER, model: process.env.LLM_MODEL,
    mode: 'Real configured LLM; synthetic text only; no microphone/STT or UI timing included; no user project edited', results }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, results: results.map(({ proposal, ...result }) => result) }));
} finally { db.close(); }
