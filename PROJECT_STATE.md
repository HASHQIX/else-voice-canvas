# ELSE implementation state

- Objective: deliver the mandatory P0 voice-driven idea board from `PLAN`, using ELSE as the product name.
- Completion criteria: real AssemblyAI Streaming STT, external `claude-opus-5-5` planning, persisted revisions, live semantic draft, final question, board/camera, branches/compare, undo/manual controls, graceful provider failures, and acceptance evidence.

## Completed

- Read `PLAN/README_HANDOFF.md`, the complete specification, contracts, prompts, fixtures, and provider notes.
- Implemented React/React Flow client, Fastify/SQLite server, revisions/events/transcripts, leases, branches, compare, undo/redo, manual edits, export/delete, deterministic layout, camera modes, AudioWorklet PCM16 16 kHz capture, playback cleanup, and failure handling.
- Configured external planner through `VECTRUST_API_KEY`, `ANTHROPIC_BASE_URL=https://api.openai-next.com`, and `LLM_MODEL=claude-opus-5-5`. Anthropic `tool_use` carries the plan schema; Ajv/domain validation remains authoritative with one repair attempt.
- Configured AssemblyAI v3 for English recognition with `language_codes=en`.
- Made the client, server, planner prompts, contracts, and acceptance browser flow English-only. Existing locale overrides are ignored.
- Fixed client readiness to use `providers.llm` and fixed the Vite `/api/` proxy collision with the `/api.ts` client module.
- Configured the private `.env` with `DAILY_LLM_BUDGET_USD=20`; the legacy `DAILY_BUDGET_USD` is empty. The matching example config is in `.env.example`.
- Kept AssemblyAI Streaming STT outside the LLM reservation ledger. Added an integration regression test that fills the configured LLM reservation and verifies an AssemblyAI session can still be created without increasing that reservation.
- Added the voice-first canvas presentation: a new visit creates a hidden `Untitled conversation` project, the empty canvas shows only a centered microphone, and headers, breadcrumbs, grid, controls, inspector, text input, and routine chrome are hidden. Placeholder root nodes stay hidden until real content arrives; committed nodes and LLM questions remain visible.

## Validation

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm test`: 4 files, 26 tests passed, including the full-budget AssemblyAI session regression.
- Runtime check with the private env loaded reports a `$20` daily reservation limit and `$0.43` reserved today; `/readyz` reports `voiceReady:true`.
- The English Vite app responds on port 5173; `node validation/client-check.mjs` confirms the voice-first canvas, a microphone centered at `720,450`, hidden chrome, and no browser console errors.
- Persisted project creation, save/reload, branch creation, and compare behavior remain covered by the integration suite and prior browser evidence; the interactive browser script now targets the requested voice-only presentation.
- AssemblyAI REST auth: HTTP 200.
- AssemblyAI Streaming v3: real `Begin` handshake, real partial/final English transcript, semantic draft, finalization, and termination path passed through the ELSE WebSocket. The end-to-end smoke produced `fork.ready`, `fork.transcript`, `fork.draft`, `fork.committed`, and a substantive `fork.reply`.
- VECTRUST `claude-opus-5-5`: direct HTTP 200; application smoke through `buildApp` produced a persisted revision with four nodes and a pending question.
- Current configuration smoke: `/readyz` reports `voiceReady:true`; one real text turn through `buildApp` committed revision 1, created five nodes and a question, and reserved `$0.06` against the configured `$20` LLM daily cap.
- Latest Jev deep recheck: deterministic typecheck/test stages passed and no flagged findings were returned. It reviewed 4 locations, found 4 uncertain signals, deferred 570 of 572 chunks, and reported 27 excluded/static-only files. Targeted investigation found that IndexedDB stores only acknowledged snapshots and has no recovery read path, so the spec's unsaved-draft recovery behavior is missing; reload of committed work still comes from the server. SQLite schema initialization also has no migration path beyond v1. Acceptance records remain `NOT_RUN`; existing tests cover many, but not all, scenarios. Coverage is incomplete; this is not a full coverage certificate.
- Jev UI recheck could not start because the bounded pass budget is exhausted (`pass_budget_exhausted_use_continue_for_new_pass`); no new Jev requests were made for the presentation-only change.

## Remaining / limitations

- The `$20/day` application limit currently applies to fixed estimated reservations (`$0.01` preview, `$0.06` final, `$0.03` TTS), not provider-reported actual USD spend. The provider response usage is not reconciled, so this configuration does not prove an exact `$20` billing ceiling; gateway-specific model rates are not configured.
- AssemblyAI STT has no application-imposed monetary reservation or cap. Operational safeguards remain: a 10-minute session default, at most three concurrent sessions, and per-IP/request limits.
- The client cache is not a recovery source: it stores acknowledged snapshots only, writes best-effort, and has no read path for separate unsaved text. SQLite schema setup has no versioned migration mechanism beyond setting `user_version=1`.
- Only AssemblyAI and VECTRUST credentials are configured. AssemblyAI documents no standalone TTS endpoint; without an OpenAI TTS key, saved replies remain readable text and audio playback reports `tts_unavailable` without a network call.
- The bundled acceptance fixture remains `NOT_RUN`; live evidence covers the core voice loop and browser workflow, not every A/B/C/D case. No production deployment was performed.

## Next action

- Resolve the remaining Jev uncertainty signals with targeted caller/test evidence, then continue bounded review if broader coverage is needed.
- Verify Vectrust per-token pricing or billing usage support before claiming that the application enforces an exact `$20/day` provider-spend ceiling.
- Run the remaining acceptance cases, including uncovered B03/B04/D01/D03/D04/D06-D08 scenarios, and consider fixing the IndexedDB recovery race and adding schema migrations.
- Address spoken-reply availability; only AssemblyAI and VECTRUST credentials are configured, so the custom pipeline currently returns replies as text.
