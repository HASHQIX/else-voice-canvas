import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AssemblyAIStream } from '../server/providers.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'else-live-test-'));
process.env.DATABASE_PATH = path.join(directory, 'test.sqlite');
process.env.SESSION_SECRET = 'isolated-live-test-session-secret';
process.env.DAILY_LLM_BUDGET_USD = '100';
process.env.VECTRUST_API_KEY = 'fake-test-key';
process.env.ASSEMBLYAI_API_KEY = 'fake-test-key';
process.env.LLM_PROVIDER = 'anthropic';
process.env.NODE_ENV = 'test';
let app: any, store: any, stream: AssemblyAIStream;
const until = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Live pipeline did not reach the expected state');
};
beforeAll(async () => {
  const providers = await import('../server/providers.js');
  vi.spyOn(providers.AssemblyAIStream.prototype, 'connect').mockImplementation(function (this: AssemblyAIStream) { stream = this; this.ready = true; this.onReady({ id: 'test-stt' }); });
  vi.spyOn(providers.AssemblyAIStream.prototype, 'close').mockImplementation(function (this: AssemblyAIStream) { this.ready = false; });
  store = await import('../server/db.js');
  app = await (await import('../server/index.js')).buildApp();
  await app.ready();
});
afterAll(async () => { await app.close(); store.db.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); fs.rmSync(directory, { recursive: true, force: true }); });

it('commits a background thought while speech continues, then processes retained speech against the new field', async () => {
  let release: (() => void) | undefined;
  const finalInputs: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: any) => {
    const body = JSON.parse(options.body), input = JSON.parse(body.messages[0].content).context;
    if (body.tools[0].name === 'else_preview') return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'else_preview', input: { ideaTitle: 'Photoshoot', ideaSummary: '', draftItems: [] } }] }));
    finalInputs.push(input);
    if (finalInputs.length === 1) await new Promise<void>((resolve, reject) => {
      release = resolve;
      options.signal.addEventListener('abort', () => reject(new Error('Unexpected cancellation of a completed thought')), { once: true });
    });
    const target = input.conversationField.cells.find((cell: any) => cell.title === 'Model booking');
    const titles = target ? ['Availability', 'Agency', 'Rates', 'Releases', 'Backups'] : ['Model booking', 'Studio', 'Budget', 'Dates', 'Rights', 'Direction', 'Crew', 'Contingencies'];
    const plan = { language: 'en', intent: 'develop', statements: [], links: [], issues: [], question: null, branchIntent: null, assistantText: '', focusRef: null,
      field: { targetId: target?.id || null, title: target?.title || 'Photoshoot planning', summary: input.text, sourceQuote: input.text, updates: [], neighbors: titles.map(title => ({ title, question: `What about ${title}?` })) } };
    return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'else_final', input: plan }] }));
  }));
  const guest = await app.inject({ method: 'POST', url: '/api/guest', payload: {} });
  const cookie = guest.headers['set-cookie'].split(';')[0];
  const project = (await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: { title: 'Live test' } })).json();
  const session = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/sessions`, headers: { cookie }, payload: { branchId: project.branches[0].id, clientId: 'live-test' } })).json();
  const ws = await app.injectWS(`/api/live/${session.id}`, { headers: { cookie } });
  const messages: any[] = [];
  ws.on('message', (data: Buffer) => messages.push(JSON.parse(data.toString())));
  ws.send(JSON.stringify({ protocolVersion: 1, type: 'fork.start', sessionId: session.id, payload: { muted: true } }));
  await until(() => messages.some(message => message.type === 'fork.ready'));
  const firstText = 'We are planning an editorial photoshoot for autumn.';
  const nextText = 'Let us book two models for a full day.';
  stream.onTranscript({ text: 'We are planning', final: false, segmentId: '1', speaker:'UNKNOWN' });
  stream.onTranscript({ text: firstText, final: true, segmentId: '1', speaker:'A' });
  await until(() => Boolean(release));
  stream.onSpeechStarted();
  stream.onTranscript({ text: nextText, final: true, segmentId: '2', speaker:'B' });
  release!();
  await until(() => messages.filter(message => message.type === 'fork.committed').length === 2);
  const commits = messages.filter(message => message.type === 'fork.committed');
  expect(finalInputs.map(input => input.text)).toEqual([firstText, nextText]);
  expect(finalInputs[0].speakerTurns).toEqual([{text:firstText,speaker:'Person 1',sessionId:session.id}]);
  expect(finalInputs[1].speakerTurns).toEqual([{text:firstText,speaker:'Person 1',sessionId:session.id},{text:nextText,speaker:'Person 2',sessionId:session.id}]);
  expect(commits[0].payload.snapshot.field.cells[commits[0].payload.snapshot.field.focusId].title).toBe('Photoshoot planning');
  const field = commits[1].payload.snapshot.field;
  expect(field.cells[field.focusId].title).toBe('Model booking');
  expect(Object.keys(field.cells)).toHaveLength(14);
  expect(messages.filter(message => message.type === 'fork.error')).toEqual([]);
  expect(messages.some(message => message.type === 'fork.transcript' && message.payload.text === nextText)).toBe(true);
  const transcript=await app.inject({url:`/api/projects/${project.id}/transcript`,headers:{cookie}});
  expect(transcript.statusCode).toBe(200);
  expect(transcript.json().segments.map((segment:any)=>segment.text)).toEqual([firstText,nextText]);
  expect(transcript.json().segments.every((segment:any)=>segment.final)).toBe(true);
  expect(transcript.json().segments.map((segment:any)=>segment.speaker)).toEqual(['A','B']);
  expect(transcript.json().segments.every((segment:any)=>segment.sessionId===session.id)).toBe(true);
  expect(messages.filter(message=>message.type==='fork.speech_segment')).toHaveLength(3);
  ws.close();
});
