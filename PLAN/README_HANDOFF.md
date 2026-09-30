# FORK — Developer Handoff v1.0 · English Edition

Source specification date: September 30, 2026. Specification language: English. This package contains requirements and reference assets, NOT a finished application.

This is a full translation of the original handoff, not a new architecture revision. Russian/English application support is still required. User-facing examples and the synthetic fixture dialogue have been translated into English; the sample final-plan fixture therefore uses `language: "en"`. The `ru | en` contracts and Russian-language acceptance requirements are unchanged. Provider references retain the source document's verification date; no new live-provider verification is claimed.

## Where to start

1. Read `spec/FORK_Prototype_Spec_EN.md` in full; P0 is separated from P1.
2. Run real provider smoke tests: AssemblyAI 3.6 RU/EN partial/final, OpenAI strict output, and OpenAI TTS.
3. Implement the first end-to-end voice slice with persistence. Then add live draft, camera, branches, and reliability.
4. Review `contracts/README.md`, the schemas, prompts, and acceptance cases. The application needs runtime validation and tests.

## Core decision

React/TS/Vite + React Flow (HTML/SVG), Node 24/Fastify, SQLite. A complete voice agent: AssemblyAI STT → custom orchestration → OpenAI LLM/TTS. Two server-side keys. This is not a managed-only AssemblyAI Voice Agent API integration; Russian output from the managed API was not officially confirmed in the source specification. Details and official references are in the specification.

No HyperFrames, Remotion, model-generated HTML, video rendering, or video export. A real semantic draft is shown while the user speaks. The committed graph, live draft, and camera are separate states. Alternatives do not erase prior decisions. The camera follows a stable structure instead of rebuilding the entire tree.

## Contents

- `spec/`: complete specification in Markdown, PDF, and editable Word.
- `contracts/`: strict JSON Schema, TypeScript reference types, explanations, and example validation.
- `prompts/`: preview, final, and repair prompts.
- `fixtures/`: a synthetic transcript stream, valid examples, and test specifications marked NOT_RUN.
- `.env.example`: configuration names only, without secrets.
- `VALIDATION.json`: local reference-asset validation results and explicit limits on what was tested.

## Package checks

`python contracts/validate_examples.py` (requires the `jsonschema` package) validates reference JSON and example quotes. This is not a provider or application test. Acceptance cases have not been run: the developer must execute them against the implemented prototype. Performance figures in the specification are targets, not measured results.

## Do not change without discussion

Do not turn FORK into a chat/static mind map, postpone real voice integration, save partials as facts, execute dynamic code from the LLM, publish keys, or delete history when returning to an earlier stage. Deliver a working P0 first; P1 must not delay it.
