# Decision: User supplies their own OpenAI key, kept in memory by default
Status: Accepted
Date: 2026-09-26 (initial commit 3997f5d)

## Context
With no backend (001), the app has nowhere to keep a key of its own. The brief required the key to come from the user and never be hard-coded, committed, logged, fully displayed or sent anywhere but OpenAI. It said to prefer keeping it in memory, and that any persistence must be explicit and optional, with a way to clear it.

## Decision
`src/settings.ts` keeps the key in React state. It's written to `localStorage` (`transcriber.openaiApiKey`) only if the user ticks "Remember on this device", and "Clear API key" removes it. The UI shows only a masked form (`maskApiKey`). The key is sent only as `Authorization: Bearer …` to OpenAI, with `credentials: 'omit'` and no referrer.

## Alternatives considered
- **Always persisting the key:** not chosen, since the brief preferred memory-only.
- **Persisting it encrypted:** no record in the repo that this was evaluated.

## Consequences
- By default the key is gone after a reload, so resuming means entering it again. The e2e test checks this.
- If the user opts in, the key sits unencrypted in `localStorage`, and the UI says so.
- Any script running on the page's origin could read the key. That makes the no-third-party-scripts rule (001) a security requirement, not just a privacy preference.

## Revisit when
- Users need the key to survive reloads more safely than plain `localStorage`.
- OpenAI offers short-lived, browser-scoped credentials suitable for this endpoint.
