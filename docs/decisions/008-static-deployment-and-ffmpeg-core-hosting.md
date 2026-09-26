# Decision: Relative-base static build; GitHub Pages via Actions; ffmpeg core hosting
Status: Accepted
Date: 2026-09-26 (initial commit 3997f5d; deployment lessons from the first deploy the same day)

## Context
The brief required the app to work on GitHub Pages under a sub-path (`/project/`) and on Cloudflare Pages, without assuming it's served from `/`. The ffmpeg core (`ffmpeg-core.wasm`) is ~32 MB. Cloudflare Pages has a 25 MiB per-file limit (noted in `src/config.ts`); GitHub Pages accepts the file.

## Decision
- **Relative asset URLs:** `vite.config.ts` sets `base: './'`, so one build works at any path.
- **ffmpeg core location:** set at build time by `VITE_FFMPEG_CORE_BASE_URL`.
  - Default: jsDelivr, pinned to `@ffmpeg/core@0.12.10`.
  - Self-hosted: `npm run vendor:ffmpeg` copies it into `public/ffmpeg/`, then build with `VITE_FFMPEG_CORE_BASE_URL=./ffmpeg`.
- **GitHub Pages** (`.github/workflows/deploy-pages.yml`): on push to `main` or manual dispatch, runs lint, tests, vendor and build, then deploys with `actions/deploy-pages`. It self-hosts the core, so the live site loads nothing from third parties.
- **Cloudflare Pages:** the README says to use the CDN default, because of the per-file limit.

## Alternatives considered
- **Always self-hosting the core:** doesn't fit Cloudflare Pages' 25 MiB file limit.
- **Always using the CDN:** adds a third-party request. GitHub Pages can avoid it, so the workflow self-hosts.

## Consequences
- **Lesson (observed 2026-09-26): Pages Source must be "GitHub Actions".** With "Deploy from a branch", GitHub's built-in *pages build and deployment* job published the raw repository. It overwrote the workflow's deploy, and the site went blank because the source `index.html` loads `/src/main.tsx`, which exists only under the Vite dev server. Only `dist/` is deployable.
- **Lesson (observed 2026-09-26): the `github-pages` environment's allowed branches don't follow the default branch.** The rule created when Pages was enabled named the default branch of that moment (`claude/browser-transcription-mvp-0g0k9g`). Changing the default to `main` didn't update it, and the deploy failed with "Branch "main" is not allowed to deploy to github-pages due to environment protection rules" until a `main` rule was added under Settings → Environments.
- The CDN default path wasn't exercised in the build environment, where jsDelivr was unreachable. Only the self-hosted path has been tested end to end.
- Pages can't send COOP/COEP headers, which rules out the multi-threaded ffmpeg core (see 003).

## Revisit when
- The app moves to a host with different file-size limits or header control.
- The ffmpeg core version is upgraded. The pinned CDN URL in `src/config.ts` and the `@ffmpeg/core` dev dependency must change together.
