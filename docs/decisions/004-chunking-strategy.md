# Decision: Size-derived, silence-aligned chunks of CBR MP3, planned once
Status: Accepted
Date: 2026-09-26 (initial commit 3997f5d)

## Context
OpenAI caps uploads at 25 MB. `gpt-4o-transcribe` and `gpt-4o-mini-transcribe` reject audio longer than 1500 s (per OpenAI docs and community reports found in September 2026). The brief asked for chunks sized mainly by encoded size with a configurable safety margin, cuts that avoid splitting sentences, and no blind assumption of a fixed duration.

## Decision
Defined in `src/config.ts` and `src/media/audioChunker.ts`:
- Encode 16 kHz mono **constant-bitrate MP3 at 48 kbps**, so size is predictable: bytes ≈ seconds × bitrate / 8.
- Max chunk length = min(target 20 MB ÷ bitrate ≈ 58 min, the model's limit × 0.9, a preferred max of 10 min). The preferred max is there so a failed request loses less work.
- Each cut moves to the middle of the longest pause (ffmpeg `silencedetect`) in the 30 s before the nominal boundary. If none is found, the cut stays put.
- The plan is computed once at job creation and **stored with the job**. Resume reuses it exactly.
- After encoding, the real size is checked. Anything over 25 MB is re-encoded at 24 kbps, and if it still doesn't fit, only that chunk fails.

## Alternatives considered
- **Fixed-duration chunks:** ruled out by the brief.
- **Uncompressed WAV chunks:** mentioned in the code only as the case where the size limit would dominate. No record of it being evaluated as the chunk format.

## Consequences
- With the default settings the 10-minute preferred max is the limit that applies, so chunks come out around 3.6 MB. The size cap only takes over if the bitrate or format changes.
- Changing chunking constants affects only new jobs. Existing jobs keep their stored boundaries.
- The model is fixed per job (`job.settings.model`; the UI says "A resumed job keeps the model it started with"). The stored plan was computed from that model's duration limit.
- `job.settings.maxChunkSeconds` is recorded for information. Nothing reads it after planning.

## Revisit when
- OpenAI changes its upload or duration limits, or publishes a duration limit for `gpt-transcribe` (unknown when this was written).
- Resume granularity (10 min of work at risk per failure) or request overhead becomes a problem.
