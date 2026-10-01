import { expect, it } from 'vitest';
import { buildConversationReport, reportToText } from '../shared/report.js';
import type { ConversationField } from '../shared/field.js';

it('keeps priority order and exports every corrected utterance in chronological order at the end', () => {
  const field: ConversationField = { focusId: 'topic', cells: { topic: { id: 'topic', x: 0, y: 0, title: 'Shoot', summary: 'A Friday shoot.', question: '', visited: true } }, plan: {
    title: 'Autumn shoot', summary: 'Two models for Friday.', decisions: [{ text: 'Friday confirmed.', sourceQuote: 'Friday confirmed' }, { text: 'Two models.', sourceQuote: 'Two models' }], nextSteps: [{ text: 'Call the studio.', sourceQuote: 'Call the studio' }], openQuestions: ['What is the budget?', 'Which studio?'],
  } };
  const first = { id: 'one', text: 'Partial', final: false, createdAt: '2026-09-30T10:00:00Z' };
  const words = 'Every word remains in this report. '.repeat(100);
  const last = { id: 'two', text: 'Still speaking', final: false, createdAt: '2026-09-30T10:01:00Z' };
  const report = buildConversationReport(field, [last, first, { ...first, text: words, final: true }], '2026-09-30T10:02:00Z', true);
  expect(report.decisions).toEqual(['Friday confirmed.', 'Two models.']);
  expect(report.openQuestions).toEqual(['What is the budget?', 'Which studio?']);
  expect(report.transcript.map(segment => segment.text)).toEqual([words, last.text]);
  const output = reportToText(report);
  const headings = ['SETTLED —', 'STILL OPEN —', 'NEXT STEPS —', '\n\nSUMMARY', 'TOPICS DISCUSSED', 'FULL TRANSCRIPT —'];
  expect(headings.map(heading => output.indexOf(heading))).toEqual(headings.map(heading => output.indexOf(heading)).sort((a, b) => a - b));
  expect(output.slice(output.indexOf('FULL TRANSCRIPT —'))).toContain(words);
  expect(output.endsWith('Still speaking\n[Unfinished speech]')).toBe(true);
  expect(output).toContain('latest speech may still be awaiting analysis');
  field.plan!.decisions[0].text = 'Changed later';
  last.text = 'Changed later';
  expect(report.decisions[0]).toBe('Friday confirmed.');
  expect(report.transcript[1].text).toBe('Still speaking');
});

it('does not invent decisions for a legacy or transcript-only conversation', () => {
  const report = buildConversationReport(undefined, [], '2026-09-30T10:02:00Z');
  expect(report.decisions).toEqual([]);
  expect(reportToText(report)).toContain('No confirmed decisions or facts recorded.');
  expect(reportToText(report)).not.toContain('ongoing conversation');
});

it('marks paused exports as incomplete while a background plan is pending', () => {
  const report = buildConversationReport({ focusId: '', cells: {}, planPending: true }, [], '2026-10-01T10:00:00Z', false);
  expect(report.inProgress).toBe(true);
  expect(reportToText(report)).toContain('latest speech may still be awaiting analysis');
});
it('includes voice labels and unknown attribution in the copyable full transcript',()=>{
 const report=buildConversationReport(undefined,[
  {id:'s:1',text:'What is the budget?',final:true,createdAt:'2026-09-30T10:00:00Z',speaker:'A',sessionId:'s'},
  {id:'s:2',text:'Two thousand.',final:true,createdAt:'2026-09-30T10:00:02Z',speaker:'B',sessionId:'s'},
  {id:'s:3',text:'Right.',final:true,createdAt:'2026-09-30T10:00:03Z',speaker:'UNKNOWN',sessionId:'s'},
 ],'2026-09-30T10:02:00Z');
 expect(reportToText(report)).toContain('Person 1\nWhat is the budget?\n\nPerson 2\nTwo thousand.\n\nUnknown\nRight.');
});
