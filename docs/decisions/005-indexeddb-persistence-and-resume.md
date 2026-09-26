# Decision: IndexedDB per-chunk persistence; resume by re-selecting the file
Status: Accepted
Date: 2026-09-26 (initial commit 3997f5d)

## Context
Long jobs have to survive crashes, reloads and closed tabs without re-transcribing finished work. The brief required IndexedDB, saving after every chunk, no long-term storage of large media blobs, deleting a job's data along with the job, and identifying files by more than their name, without hashing a multi-GB file in a way that freezes the UI.

## Decision
- IndexedDB database `local-transcriber` (`src/storage/db.ts`) with two stores: `jobs` (indexed by fingerprint) and `chunks` (key `[jobId, id]`). Saving one chunk is a small write rather than a rewrite of the whole job.
- Every chunk state change is written before the queue moves on. On startup, `recoverInterruptedJobs` resets `processing` chunks to `pending` and `transcribing` jobs to `paused`.
- **No media is stored.** To resume, the user selects the original file again, and it's matched by fingerprint.
- **Fingerprint** (`src/utils/fileHash.ts`): SHA-256 over size, `lastModified`, type, and three 1 MiB samples (start, middle, end). The name is excluded, so a renamed copy still matches.
- `deleteJob` removes the job and its chunks in one transaction.

## Alternatives considered
- **Hashing the whole file:** rejected in the `fileHash.ts` comment. It's slow and reads every byte.
- **Storing chunk audio for resume:** ruled out by the brief's instruction not to keep large media blobs indefinitely.

## Consequences
- A crash loses at most the chunk in flight.
- Resume always needs the user to pick the file again.
- The fingerprint misses an edit that changes only unsampled bytes while keeping both size and modification time. This was judged acceptable for resume matching.
- Storage isn't behind an interface. The queue and job factory call `src/storage/*` directly, and tests use `fake-indexeddb`.

## Revisit when
- Picking the file again becomes a real usability problem.
- Sync across devices or browsers is needed, which is out of scope under 001.
