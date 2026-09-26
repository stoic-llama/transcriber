# Decision: One chunk at a time, with one-chunk prefetch
Status: Accepted
Date: 2026-09-26 (initial commit 3997f5d)

## Context
The brief asked for one transcription request at a time in the MVP, for simpler rate-limit handling, simpler resume logic, lower memory use and simpler progress tracking, with the queue built so limited concurrency could come later.

## Decision
`TranscriptionQueue` (`src/transcription/transcriptionQueue.ts`) processes the remaining chunks strictly in `id` order, one request at a time. To keep ffmpeg busy while the network waits, the next chunk's audio is encoded while the current one is being transcribed, so at most two chunk blobs are in memory. Pause stops after the chunk in flight. Cancel aborts the in-flight request and puts that chunk back to `pending`. The per-chunk logic (`processChunk`) is separate from the loop.

## Alternatives considered
- **Parallel transcription:** deferred by the brief. Not implemented.

## Consequences
- Throughput is limited to one request at a time. In a mocked test run, a 2-hour file finished in about 30 s, so real-world speed is set by OpenAI's response time.
- A prefetched chunk is thrown away if the user pauses or cancels.
- Adding concurrency would need a pool around `processChunk`, a rethink of the prefetch, and rate-limit coordination. It still wouldn't parallelise ffmpeg (see 003).

## Revisit when
- Total transcription time becomes a user complaint and the user's rate limits allow parallel requests.
