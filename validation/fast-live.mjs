// Real configured LLM, synthetic speech only. Uses the normal budget ledger.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { structuredResponse } from '../server/providers.ts';
import { db } from '../server/db.ts';
import { fastContext } from '../server/fast-context.ts';
import { fastProposal, recapProposal } from '../server/fast-schema.ts';
import { fieldContext } from '../shared/field.ts';
import { applyField, validateField } from '../server/field.ts';
const nativeFetch = globalThis.fetch;
const requests = [];
globalThis.fetch = async (url, options) => {
  const body = JSON.parse(options.body), start = performance.now();
  const response = await nativeFetch(url, options);
  const data = await response.clone().json().catch(() => null);
  requests.push({ kind: body.response_format?.json_schema?.name || body.tools?.[0]?.name,
    requestBytes: Buffer.byteLength(options.body), inputChars: JSON.stringify(body.messages || body.input).length,
    elapsedMs: Math.round(performance.now() - start), status: response.status, usage: data?.usage });
  return response;
};
const results = [];
async function analyze(kind, text, field, history) {
  const input = kind === 'fast' ? fastContext(field, text, history) : { text, language: 'en', currentTurnId: 'synthetic-current',
    conversationField: fieldContext(field), snapshot: { nodes: {}, navigation: [], dependencies: [], pendingQuestionId: null },
    sources: history.slice(-12).map((turn, i) => ({ id: `synthetic-${i}`, text: turn.text })), speakerTurns: history };
  const start = performance.now(); let result, error, proposal; const repairs = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    proposal = await structuredResponse(kind, input, undefined, error ? { proposal, errors: error.message } : undefined);
    try {
      result = kind === 'fast' ? fastProposal(proposal, !field) : proposal;
      assert.ok(result.field, 'Meaningful speech must produce a field');
      validateField(result.field, field, text, history.map(turn => turn.text), kind === 'fast');
      error = null; break;
    } catch (issue) { error = issue; repairs.push({ error: issue.message, proposal }); }
  }
  if (error) throw error;
  return { kind, elapsedMs: Math.round(performance.now() - start), contextBytes: Buffer.byteLength(JSON.stringify(input)), repairs, field: result.field };
}
try {
  const startText = 'We are planning an editorial photoshoot for our autumn collection. We need two models for a full day, but no studio is booked and the budget is still open.';
  const history = [{ text: startText, speaker: 'Person 1', sessionId: 'synthetic-session' }];
  let previous, fullField;
  for (const kind of ['final', 'fast']) {
    const result = await analyze(kind, startText, undefined, history);
    results.push({ scenario: 'First thought', ...result });
    console.log(JSON.stringify({ scenario: 'First thought', kind, elapsedMs: result.elapsedMs, contextBytes: result.contextBytes }));
    if (kind === 'final') fullField = applyField(undefined, result.field, 'synthetic-1');
    else previous = applyField(undefined, result.field, 'synthetic-1');
  }
  // Same existing field for both variants, with 64 earlier distant topics.
  for (let i = 0; i < 64; i++) fullField.cells[`historical-${i}`] = { id: `historical-${i}`, x: 20 + i % 8, y: 20 + Math.floor(i / 8),
    title: `Earlier topic ${i}`, summary: 'An earlier tentative discussion; no action was agreed.', question: 'What still needs checking?', visited: true };
  const nextText = 'Let us focus on booking the models. We need to check their Friday availability and usage fees before we choose anyone.';
  const expandedHistory = [...Array.from({ length: 18 }, (_, i) => ({ text: `Earlier discussion ${i}: no dates or commitments were confirmed.`, speaker: 'Person 1', sessionId: 'synthetic-session' })), ...history,
    { text: nextText, speaker: 'Person 2', sessionId: 'synthetic-session' }];
  for (const kind of ['final', 'fast']) {
    const result = await analyze(kind, nextText, fullField, expandedHistory);
    results.push({ scenario: '73 saved cells', ...result });
    console.log(JSON.stringify({ scenario: '73 saved cells', kind, elapsedMs: result.elapsedMs, contextBytes: result.contextBytes }));
  }
  const correction = 'Actually Friday is not confirmed. Nobody has booked the studio or contacted the models yet. We still need to decide on a budget.';
  const result = await analyze('fast', correction, previous, [...history, { text: correction, speaker: 'Person 1', sessionId: 'synthetic-session' }]);
  results.push({ scenario: 'Correction', ...result });
  const recapStart = performance.now();
  const recap = recapProposal(await structuredResponse('recap', { previousPlan: fullField.plan,
    turns: [{ id: 'synthetic-correction', text: correction }], topics: [] }),
    [correction, ...(fullField.plan?.decisions || []).map(entry => entry.sourceQuote), ...(fullField.plan?.nextSteps || []).map(entry => entry.sourceQuote)]);
  results.push({ scenario: 'Background recap after correction', kind: 'recap', elapsedMs: Math.round(performance.now() - recapStart), plan: recap });
  console.log(JSON.stringify({ scenario: 'Correction and recap', summary: result.field.summary, recap }));
} finally {
  fs.writeFileSync('validation/fast-live-result.json', JSON.stringify({ testedAt: new Date().toISOString(), provider: process.env.LLM_PROVIDER,
    model: process.env.LLM_MODEL, mode: 'Real LLM; synthetic transcript; no microphone or STT latency included. Final uses new nonduplicated schema prompt, so comparison is conservative.',
    results, requests }, null, 2) + '\n');
  globalThis.fetch = nativeFetch; db.close();
}
