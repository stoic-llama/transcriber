# Decision: Browser-only static app with no backend
Status: Accepted
Date: 2026-09-26 (initial commit 3997f5d)

## Context
The MVP brief required the app to be static files deployable to GitHub Pages or Cloudflare Pages, with the user's browser owning the file, the processing, the state and the API key. It explicitly ruled out any server, API proxy, database, server-side storage or processing, and serverless functions. It also said that if OpenAI didn't allow the needed browser request, the right response was to stop and document the limitation, not to add a proxy.

## Decision
The whole application runs in the browser. The browser calls `https://api.openai.com/v1/audio/transcriptions` directly (`src/transcription/OpenAITranscriptionProvider.ts`). There is no server code in the repo, and no analytics or telemetry.

## Alternatives considered
- **A backend or proxy** (to hold a key, bypass CORS or process media): rejected by the brief.

## Consequences
- Easier: free static hosting, a simple privacy story (no infrastructure of our own ever sees media or keys), no ops.
- Harder: each user needs their own OpenAI key (see 002). The app depends on OpenAI keeping cross-origin browser access to the endpoint. All heavy work runs on the client: a ~32 MB ffmpeg core download and CPU for encoding (see 003). A reloaded page can't reopen the user's file on its own (see 005).
- **Unverified:** direct browser → OpenAI calls rely on OpenAI's CORS behaviour, the same pattern the official SDK uses with `dangerouslyAllowBrowser`. When this was written, automated tests had only run against a mocked endpoint, because the build environment couldn't reach api.openai.com.

## Revisit when
- OpenAI stops allowing cross-origin browser requests to the transcription endpoint.
- The product needs server-side features: shared or managed keys, accounts, cross-device sync.
