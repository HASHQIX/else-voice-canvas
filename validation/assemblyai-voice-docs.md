# AssemblyAI voice capability check

Checked against the official AssemblyAI documentation on 2026-09-30. No API key was read and no paid API request was made. The documentation pages were fetched without authentication; the page contents and URLs below are the evidence used.

## Decision-relevant findings

### One AssemblyAI key can provide a complete voice loop

The managed Voice Agent API is explicitly an end-to-end speech-in/speech-out service: STT, LLM reasoning, TTS, turn detection, interruption handling, and tool calling are provided through one WebSocket. It uses an AssemblyAI key, and the browser should receive a short-lived token minted by the server rather than the permanent key.

- Product overview: https://www.assemblyai.com/docs/voice-agents/voice-agent-api
- Browser token flow: https://www.assemblyai.com/docs/voice-agents/voice-agent-api/browser-integration
- API endpoint and authentication: `wss://agents.assemblyai.com/v1/ws`; server connection uses `Authorization: Bearer <ASSEMBLYAI_API_KEY>`. Browser connections use `?token=<single-use-token>`.
- Token endpoint: `GET https://agents.assemblyai.com/v1/token`; documented token lifetime is 1-600 seconds and session cap is 60-10800 seconds.

The key distinction from the existing ELSE STT adapter is that the Voice Agent API audio protocol is JSON events containing base64 audio. It is not the raw-binary v3 Streaming STT protocol. The documented default is mono signed PCM16 at 24 kHz for both input and output; output may instead be 8 kHz PCMU or PCMA.

- Audio format: https://www.assemblyai.com/docs/voice-agents/voice-agent-api/audio-format
- Events: https://www.assemblyai.com/docs/voice-agents/voice-agent-api/events-reference

The first client message is `session.update`; wait for `session.ready` before sending `input.audio`. User input is sent as `{ "type": "input.audio", "audio": "<base64 PCM16>" }`. Spoken output arrives as `reply.audio` with PCM bytes in the `data` field. Intentional shutdown is `{ "type": "session.end" }`, followed by `session.ended`; simply closing the socket leaves a 30-second resumable, billable grace period.

### AssemblyAI does not offer standalone TTS

The official FAQ is explicit: AssemblyAI does not offer a separate text-to-speech endpoint. TTS is available as part of the Voice Agent API pipeline.

- FAQ: https://www.assemblyai.com/docs/faq/do-you-offer-voice-to-voice-or-text-to-speech-tts

Therefore, with only one AssemblyAI key, the application cannot call an AAI standalone endpoint to synthesize an arbitrary saved `assistantText` outside a Voice Agent session. Arbitrary text can be made spoken through the managed agent's `reply.create` event (see below), but it is still a Voice Agent reply and is subject to that session's configured output voice/language.

### Russian output is not officially supported by Voice Agent TTS

The current official output-language table lists only six output languages: English, Italian, Spanish, German, Portuguese, and French. Russian is absent. Russian appears neither as an official output language nor as a recommended voice. The input table includes many languages, but input recognition and spoken output are separate capabilities.

- Supported languages: https://www.assemblyai.com/docs/voice-agents/voice-agent-api/supported-languages
- Voices: https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices

Current documented voices are:

| Output | Voice IDs |
| --- | --- |
| English (US/UK) | `alba`, `eve`, `george`, `jane`, `jean`, `mary`, `michael`, `anna`, `charles`, `paul`, `vera` |
| Italian | `giovanni` |
| Spanish | `lola` |
| German | `juergen` |
| Portuguese | `rafael` |
| French | `estelle` |

The docs list Hindi, Turkish, Dutch, Swedish, Norwegian, Danish, Finnish, Vietnamese, Arabic, Hebrew, Japanese, and Chinese as future/roadmap native-accent output languages. Russian is not listed in that roadmap table. Do not promise Russian spoken responses from AAI without a direct provider confirmation or a successful capability test.

### The same key can fund a managed or gateway LLM, but this does not add Russian TTS

Voice Agent `llm` configuration can point to AssemblyAI's LLM Gateway (`https://llm-gateway.assemblyai.com/v1`) and use the same AssemblyAI key as the gateway `api_key`. The docs describe this as an OpenAI-compatible chat-completions endpoint. This solves the "no OpenAI account" constraint for reasoning, but it does not change Voice Agent output voices or add standalone TTS.

- Bring-your-own / Gateway LLM: https://www.assemblyai.com/docs/voice-agents/voice-agent-api/connect-your-own-llm
- LLM Gateway: https://www.assemblyai.com/docs/llm-gateway/quickstart

The custom-LLM `llm` entry is a single public HTTPS endpoint and only one entry is currently accepted. The gateway example uses the same `ASSEMBLYAI_API_KEY` for both the AssemblyAI API request and the gateway model request.

## Custom orchestration options supported by the official protocol

### Client-side tools are the supported application callback

The managed Voice Agent API lets the client declare flat-schema function tools in `session.tools`. AssemblyAI emits `tool.call` with a parsed `arguments` object. ELSE can execute a local/server mutation (for example, validate and persist a proposed node/branch) and send `tool.result` with the matching `call_id`; the result must be a JSON string. The docs require sending the result when `reply.done` is the latest event and discarding pending results when the reply was interrupted.

- Client-side tools: https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/client-side-tools
- Tools overview: https://www.assemblyai.com/docs/voice-agents/voice-agent-api/tools/overview
- Tool event details: https://www.assemblyai.com/docs/voice-agents/voice-agent-api/events-reference#tool-call

This is the documented path for giving the managed agent access to ELSE state. A tool such as `propose_structure` can return typed fields (title, summary, audience, branch intent, source quote), while ELSE remains authoritative: validate IDs/quotes/revisions server-side and commit only a valid proposal.

### `reply.create` asks the managed agent to speak now

The Voice Agent protocol has a client-to-server event:

```json
{
  "type": "reply.create",
  "instructions": "Ask one concise next question about the first user of this idea."
}
```

The service then emits a normal `reply.started` -> `reply.audio` -> `transcript.agent` -> `reply.done` sequence. `instructions` is a one-shot instruction layered over the current system prompt; it does not change the system prompt. This is the documented way to request a spoken response without waiting for a new user utterance. It is not a standalone "speak arbitrary PCM/text" API, and the agent still decides the final spoken wording.

- `reply.create` reference: https://www.assemblyai.com/docs/voice-agents/voice-agent-api/events-reference#reply-create

### `system_prompt`, tools, language steering, and volume can be updated

After `session.ready`, `system_prompt`, `input.turn_detection`, keyterms, transcription settings, tools, and output volume are mutable. Greeting, output voice, and output format are immutable for the session. This allows ELSE to update the active board context and expose branch-specific tools without reconnecting, but a Russian voice cannot be selected after connecting (and is not in the documented catalog anyway).

- Inline configuration and mutability: https://www.assemblyai.com/docs/voice-agents/voice-agent-api/session-configuration

## Custom STT + own LLM/TTS path

AssemblyAI also documents a lower-level custom voice-agent pattern: Universal-3.5 Pro Streaming sends `Begin`, partial/final `Turn`, `SpeechStarted`, and `Termination` over `wss://streaming.assemblyai.com/v3/ws`; the application supplies its own LLM and TTS. This is suitable when selecting a specific TTS provider or implementing custom orchestration, but it necessarily requires a separate TTS service for spoken output. It does not make AAI TTS available through the STT key.

- Custom voice-agent guide: https://www.assemblyai.com/docs/voice-agents/universal-3-5-pro-streaming-api
- Streaming WebSocket API: https://www.assemblyai.com/docs/streaming/api-spec/streaming-websocket

The lower-level STT connection uses the raw AssemblyAI key without a Bearer prefix; this differs from Voice Agent API authentication. Its audio is raw PCM16 at the configured STT rate (the project specification uses 16 kHz), whereas Voice Agent API uses base64 JSON PCM16 at 24 kHz by default.

## Consequences for ELSE

1. **English voice loop with one AAI key:** feasible through the managed Voice Agent API. Use server-minted tokens, 24 kHz base64 event audio, `session.ready` gating, client-side tools for board operations, and `reply.create` for a directed next question.
2. **Russian UI/input with spoken Russian replies:** not confirmed and currently contradicted by the official output-language matrix. Keep Russian text replies and an explicit synthetic-voice/unavailable notice unless a direct AAI capability check changes this.
3. **ELSE's existing custom final-plan contract:** can remain server-authoritative. A managed agent tool call may propose typed changes; the server validates them and persists snapshots. Preview extraction can use the AAI LLM Gateway with the same key if its current model/schema behavior is verified, but it does not solve speech synthesis in Russian.
4. **Do not pass arbitrary `assistantText` to a presumed AAI TTS REST endpoint:** the official FAQ says that endpoint does not exist. For spoken English, issue `reply.create` instructions within the live Voice Agent session; for exact arbitrary text or Russian, a second TTS provider is required.

## Uncertainty and required verification

- Documentation confirms the protocol and language catalog, but it does not guarantee that every account/project has identical voice entitlements. A non-paying local smoke test cannot establish billing or account availability.
- The managed agent may respond in an unsupported language in practice, but the official docs do not promise Russian output. Treat any Russian audio observed experimentally as unsupported behavior until AssemblyAI confirms it.
- `reply.create` is documented as generating a normal agent reply from instructions; it is not documented as accepting raw text to read verbatim. Do not use it as an exact-text TTS substitute without a live test and prompt-level safeguards.
- The existing ELSE custom STT adapter is not wire-compatible with Voice Agent API. Migrating requires a separate adapter/protocol path, not merely changing the WebSocket URL.
