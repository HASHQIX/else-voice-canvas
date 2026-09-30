import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { sockets } = vi.hoisted(() => ({ sockets: [] as any[] }));
vi.mock('../server/budget.js', () => ({ reserveBudget: vi.fn() }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: class extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
    constructor(public url: URL) { super(); sockets.push(this); }
  } };
});
import { AssemblyAIStream } from '../server/providers.js';

let stream: AssemblyAIStream;
beforeEach(() => {
  vi.useFakeTimers(); sockets.length = 0;
  vi.stubEnv('ASSEMBLYAI_API_KEY', 'synthetic-test-value');
  vi.stubEnv('LLM_PROVIDER', 'openrouter');
  vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-test-value');
  vi.stubEnv('DAILY_LLM_BUDGET_USD', '10');
  stream = new AssemblyAIStream();
});
afterEach(() => { stream.close(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

it('enables live speaker labels while retaining the configured recognition model', () => {
  vi.stubEnv('ASSEMBLYAI_STT_MODEL', 'universal-3-6-pro');
  stream.connect();
  expect(sockets[0].url.searchParams.get('speaker_labels')).toBe('true');
  expect(sockets[0].url.searchParams.get('speech_model')).toBe('universal-3-6-pro');
  expect(sockets[0].url.searchParams.has('max_speakers')).toBe(false);
});

it('forwards voice labels and corrections without inventing speakers for uncertain turns', () => {
  stream.onTranscript = vi.fn(); stream.connect();
  for (const label of [undefined, 'A', 'B', 'UNKNOWN', 'bad label']) {
    sockets[0].emit('message', Buffer.from(JSON.stringify({ type:'Turn', transcript:'Friday works.', turn_order:2, end_of_turn:true, speaker_label:label })));
  }
  expect(vi.mocked(stream.onTranscript).mock.calls.map(([event]) => event.speaker)).toEqual(['UNKNOWN','A','B','UNKNOWN','UNKNOWN']);
  expect(vi.mocked(stream.onTranscript).mock.calls.every(([event]) => event.segmentId === '2' && event.text === 'Friday works.')).toBe(true);
});
