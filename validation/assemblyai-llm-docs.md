# AssemblyAI provider research (2026-09-30)

Research was read from official AssemblyAI documentation only. No API key, `.env`, or paid provider request was used.

## Decision for ELSE

The app does **not** use AssemblyAI LLM Gateway. AssemblyAI remains the realtime STT/audio provider. The external planner LLM is selected by `LLM_PROVIDER=anthropic` and defaults to Anthropic Messages (`claude-opus-5-5`). `OPENAI` remains an explicit alternative adapter only.

## LLM Gateway reference (not used by runtime)

Official pages:

- https://www.assemblyai.com/docs/llm-gateway/quickstart
- https://www.assemblyai.com/docs/llm-gateway/chat-completions
- https://www.assemblyai.com/docs/llm-gateway/structured-outputs
- https://www.assemblyai.com/docs/llm-gateway/available-models
- https://www.assemblyai.com/docs/llm-gateway/api-reference/list-available-models

The Gateway is OpenAI SDK compatible. The US endpoint is:

`POST https://llm-gateway.assemblyai.com/v1/chat/completions`

The EU endpoint is:

`POST https://llm-gateway.eu.assemblyai.com/v1/chat/completions`

Authentication uses `Authorization: <YOUR_API_KEY>` (the quickstart examples also show lowercase `authorization`). The request requires `model` plus either `messages` or `prompt`; `max_tokens` is optional and documented as range `[1, context_length)`. `stream: true` is supported for OpenAI models only and returns SSE. Responses include `request_id`, `choices`, and `usage`; persist the request ID for support/debugging.

Model discovery is a public, unauthenticated endpoint:

`GET https://llm-gateway.assemblyai.com/v1/models`

The EU equivalent uses `llm-gateway.eu.assemblyai.com`. The catalog page lists model IDs, supported parameters, context length, pricing, and regions. The current catalog includes `claude-opus-5-5`, `claude-sonnet-4-6`, `gpt-4.1`, `gpt-5-mini`, and others. Catalog data is date-sensitive; do not hard-code pricing from this document.

### Structured output contract

Gateway structured output is requested using:

```json
{
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "example",
      "schema": {"type": "object", "properties": {}, "required": [], "additionalProperties": false},
      "strict": true
    }
  }
}
```

`response_format.json_schema.name`, `.schema`, and `.strict` are documented. `post_processing_steps: [{"type":"json-repair"}]` can repair common malformed JSON; if repair fails, the Gateway returns HTTP 500 and does not pass raw malformed output through. Structured output support is model-specific: the model catalog must list `response_format`; the docs explicitly state it is supported by OpenAI (GPT-4.1/GPT-5.x), Gemini, and Claude families and not by gpt-oss models. Schemas should use `additionalProperties:false` at each object level. The docs do not state a single universal token/size limit for schemas; limits come from each model's context and max completion constraints.

## Voice Agent language caveat

Official Voice Agent docs:

- https://www.assemblyai.com/docs/voice-agents/voice-agent-api/supported-languages
- https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices
- https://www.assemblyai.com/docs/voice-agents/voice-agent-api/connect-your-own-llm

The managed Voice Agent API officially speaks six output languages: English, Italian, Spanish, German, Portuguese, and French. Russian is not listed as an output language. Russian is therefore not used as the managed Voice Agent TTS path for ELSE. The Voice Agent API can point at an OpenAI-compatible custom LLM endpoint, but that would still leave managed Voice Agent output-language limitations, so ELSE keeps custom STT → external LLM → separate TTS architecture.

## Runtime change in this repository

`server/providers.ts` now sends planner requests to the configured Anthropic-compatible endpoint (the VECTRUST deployment uses `ANTHROPIC_BASE_URL=https://api.openai-next.com`) at `POST ${ANTHROPIC_BASE_URL}/v1/messages`. It authenticates with `x-api-key: VECTRUST_API_KEY`, sends `anthropic-version: 2023-06-01`, `model: LLM_MODEL`, and supplies the contract schema as a forced Anthropic `tool_use` input. The server still performs Ajv/domain validation and allows one bounded repair request; a text-JSON fallback handles compatible endpoints that do not return a tool block. The OpenAI Responses adapter remains available only when `LLM_PROVIDER=openai`.
