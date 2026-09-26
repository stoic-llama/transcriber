# AGENTS.md

How to work in this repository. Project knowledge lives in `docs/`; this file only says where to look and how to behave.

## Orientation

- **What and why:** [`docs/project-intent.md`](docs/project-intent.md): purpose, constraints, non-goals.
- **How it works:** [`docs/architecture/index.md`](docs/architecture/index.md): components, boundaries, data flow.
- **What's already decided:** [`docs/decisions/`](docs/decisions/): one numbered record per architectural decision (`NNN-short-description.md`). Skim the file names first.
- **Running and deploying:** [`README.md`](README.md).
- **Tunables** (limits, bitrates, retry policy): `src/config.ts`.

## Before making changes

1. Understand the relevant existing code and its data flow.
2. Read the relevant section of the architecture doc.
3. Check `docs/decisions/` for decisions that constrain the change.
4. Prefer existing patterns over new abstractions.

The hard constraint: this is a static, browser-only app. No backend, proxy, analytics or telemetry, ever, without a new decision record (see [001](docs/decisions/001-browser-only-static-app.md)).

## Architectural changes

Before a significant architectural change:

1. Search the existing decision records.
2. Work out whether an existing decision already addresses the problem.
3. If the change conflicts with an existing decision, say so explicitly before implementing. Don't quietly work around it.
4. If a genuinely new decision is needed, add `docs/decisions/NNN-short-description.md` in the same format as the existing records. To reverse a decision, mark the old record `Superseded by NNN` instead of deleting it.

## Documentation

- Document durable knowledge, not implementation trivia.
- Update `docs/architecture/index.md` when system structure or data flow changes.
- Create or update a decision record when an important architectural choice is made.
- If a bug reveals a non-obvious architectural constraint or a reusable lesson, record it in the most relevant architecture doc or decision record. There is no separate lessons file.
- Keep this file short.

## Verification

Run before pushing: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`. For changes to media processing, resume or the UI flow, also run the browser smoke test (`npm run e2e`, setup in the README). Unit tests must not make real network calls.
