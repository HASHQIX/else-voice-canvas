import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../server/budget.js', () => ({ reserveBudget: vi.fn() }));
import { providerStatus, structuredResponse } from '../server/providers.js';

const finalInput = { text: 'Plan a photoshoot.', conversationField: { newTopicVacancies: 8, cells: [] } };
const reply = (content: string | null, finish_reason = 'stop') => ({ choices: [{ finish_reason, message: { content } }] });
const respond = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

beforeEach(() => {
  vi.stubEnv('LLM_PROVIDER', 'openrouter');
  vi.stubEnv('LLM_MODEL', '');
  vi.stubEnv('OPENROUTER_BASE_URL', '');
  vi.stubEnv('OPENROUTER_API_KEY', 'router-test-credential');
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('VECTRUST_API_KEY', 'legacy-test-credential');
  vi.stubEnv('ASSEMBLYAI_API_KEY', 'speech-test-credential');
  vi.stubEnv('DAILY_LLM_BUDGET_USD', '20');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

it('selects OpenRouter by default and requires its own key without falling back', async () => {
  vi.stubEnv('LLM_PROVIDER', '');
  expect(providerStatus()).toMatchObject({ llm: true, llmProvider: 'openrouter', llmModel: 'google/gemini-3.8-flash', assemblyai: true, tts: false });
  vi.stubEnv('OPENROUTER_API_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', 'other-test-credential');
  respond(reply('{"field":null}'));
  expect(providerStatus().llm).toBe(false);
  await expect(structuredResponse('final', finalInput)).rejects.toMatchObject({ code: 'provider_unavailable' });
  expect(fetch).not.toHaveBeenCalled();
});

it('sends strict JSON to Gemini, preserving context and repair instructions', async () => {
  respond(reply('{"field":null}'));
  const repair = { proposal: { field: {} }, errors: 'Missing plan' };
  expect(await structuredResponse('final', finalInput, undefined, repair)).toMatchObject({ field: null, intent: 'no_change' });
  const [url, options] = vi.mocked(fetch).mock.calls[0];
  const body = JSON.parse(options!.body as string);
  expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
  expect(options!.headers).toMatchObject({ Authorization: 'Bearer router-test-credential' });
  expect(body).toMatchObject({ model: 'google/gemini-3.8-flash', stream: false, max_tokens: 4000, provider: { require_parameters: true }, reasoning: { effort: 'low', exclude: true } });
  expect(body.response_format.json_schema).toMatchObject({ name: 'else_final', strict: true, schema: { required: ['field'] } });
  expect(JSON.parse(body.messages[1].content)).toEqual({ context: finalInput, ...repair });
  expect(body.messages[0].content).toContain('Return only a JSON object');
  expect(body.messages[0].content).not.toContain('Use the required else_final tool');
});

it('parses previews from chat completions using the preview schema', async () => {
  const preview = { ideaTitle: 'Photoshoot', ideaSummary: 'Plan a shoot.', draftItems: [] };
  respond(reply(JSON.stringify(preview)));
  expect(await structuredResponse('preview', { text: 'Plan a shoot.' })).toEqual(preview);
  const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
  expect(body.response_format.json_schema.name).toBe('else_preview');
  expect(body.max_tokens).toBe(600);
});

it('uses separate small native schemas and token limits without duplicating schema or repair data in the system prompt', async () => {
  respond(reply('{"field":null}'));
  const repair = { proposal: { field: { targetId: 'bad-reference' } }, errors: 'Unknown field focus' };
  await structuredResponse('fast', { text: 'We need a studio.' }, undefined, repair);
  const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
  expect(body.max_tokens).toBe(1200);
  expect(body.response_format.json_schema.name).toBe('else_fast');
  const schema = body.response_format.json_schema.schema;
  expect(schema.properties.field.anyOf[1].properties.neighbors.maxItems).toBe(3);
  expect(schema.properties.field.anyOf[1].properties).not.toHaveProperty('plan');
  expect(body.messages[0].content).not.toContain(JSON.stringify(schema));
  expect(body.messages[0].content).not.toContain('bad-reference');
  expect(JSON.parse(body.messages[1].content)).toMatchObject(repair);
  const plan = { title: 'Shoot', summary: 'Planning.', decisions: [], nextSteps: [], openQuestions: [] };
  respond(reply(JSON.stringify({ plan })));
  expect(await structuredResponse('recap', { previousPlan: null, turns: [] })).toEqual({ plan });
  const recap = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
  expect(recap.max_tokens).toBe(2400);
  expect(recap.response_format.json_schema.name).toBe('else_recap');
});

it('uses a compact schema for large Gemini fields while preserving exact-schema routing for other models',async()=>{
 const input={text:'Plan a shoot.',conversationField:{newTopicVacancies:7,cells:Array.from({length:73},(_,i)=>({id:`cell-${i}`,vacancies:i%8}))}};
 respond(reply('{"field":null}'));
 await structuredResponse('final',input);
 const body=JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
 expect(body.response_format.json_schema.schema.properties.field.anyOf).toHaveLength(2);
 expect(JSON.parse(body.messages[1].content).context).toEqual(input);
 vi.stubEnv('LLM_MODEL','another/model');
 await structuredResponse('final',input);
 const other=JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string);
 expect(other.response_format.json_schema.schema.properties.field.anyOf.length).toBeGreaterThan(2);
});

it.each([
  [null, 'provider_error'],
  [reply('{"field":null}', 'length'), 'provider_incomplete'],
  [reply(null, 'content_filter'), 'provider_refusal'],
  [reply(null, 'error'), 'provider_error'],
  [{ error: { message: 'Upstream error details' } }, 'provider_error'],
  [{ choices: [{ error: { message: 'Upstream error details' }, message: { content: '{"field":null}' } }] }, 'provider_error'],
  [reply(null), 'provider_empty'],
  [reply('not JSON'), 'invalid_plan'],
])('rejects unsuccessful chat response %#', async (body, code) => {
  respond(body);
  await expect(structuredResponse('final', finalInput)).rejects.toMatchObject({ code });
});

it('keeps provider HTTP errors sanitized', async () => {
  respond({ error: { message: 'private provider details' } }, 401);
  await expect(structuredResponse('final', finalInput)).rejects.toMatchObject({ code: 'provider_error', message: 'Analysis service returned 401' });
});

it('honors caller cancellation without retrying or changing providers', async () => {
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  })));
  const result = structuredResponse('final', finalInput, controller.signal);
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('times out a slow OpenRouter request with a recoverable error', async () => {
  const signal = AbortSignal.abort(new DOMException('Timeout', 'TimeoutError'));
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
  vi.stubGlobal('fetch', vi.fn((_url, options) => Promise.reject(options.signal.reason)));
  try {
    await expect(structuredResponse('final', finalInput)).rejects.toMatchObject({ code: 'provider_timeout' });
  } finally { timeout.mockRestore(); }
});
