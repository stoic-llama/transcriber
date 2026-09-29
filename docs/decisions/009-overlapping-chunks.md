# Decision: Chunks overlap around every cut; the transcript merge removes the repeat conservatively
Status: Accepted
Date: 2026-09-29

## Context
[004](004-chunking-strategy.md) cut the audio into contiguous, non-overlapping chunks and relied on silence detection to put each cut in a pause. That is not enough to guarantee no words are lost:

- If the 30 s search window contains no pause the detector recognises, the cut is a hard cut at the nominal boundary. This happens with continuous speech, and with any recording whose noise floor sits above the -35 dB threshold, where the detector finds nothing anywhere.
- If the detected silence extends into speech (a quiet word ending, a soft onset, a detector tolerance), the middle of the detected silence can fall inside a word. This is most likely where the search window clips the detection.
- A word cut in two reaches the model as two fragments, and both chunks may drop or garble it.

The deterministic word-loss suite (`src/media/silenceChunking.test.ts`, spoken fixtures in `tests/fixtures/silence/`) demonstrated this against the old planner. With the real silence detector, between 16 and 73 of every ~85 plans per fixture lost at least one word. With a detection widened 0.5 s into the speech on both sides, words inside the widened region were lost in about a third to a half of plans.

## Decision
Defined in `src/config.ts`, `src/media/audioChunker.ts` and `src/transcription/transcript.ts`:
- **Overlap.** Adjacent chunks share `CHUNK_OVERLAP_SECONDS` (4 s) of audio, centred on each cut (`chunksFromCuts`). Cuts are still chosen as in 004. Stored `startTime`/`endTime` are the audio actually sent, so a chunk's cut is the middle of its overlap with the neighbour. The distance between cuts is `maxSeconds − overlap`, so no chunk exceeds `maxSeconds`. A cut closer than half an overlap to the end is skipped, and the previous chunk takes the rest.
- **Guarantee.** Any stretch of speech no longer than the overlap lies entirely inside at least one chunk, wherever the cut lands. Take the last chunk that starts at or before the word: the next chunk starts after the word, and this chunk ends a full overlap after that start. `planChunks` requires `maxSeconds ≥ 3 × overlap`, so cuts are at least one overlap apart and only neighbouring chunks share audio.
- **Merge.** `assembleTranscriptText` removes words both neighbours transcribed (`findOverlap`). A repeat must be a suffix of one chunk equal to a prefix of the next. At most one edge word may be left out on each side, as a possibly half-heard word, and it is taken from the chunk that heard it whole. A match is used only with enough evidence: a run of at least 4 words, or a shorter run whose dropped edge words are visibly fragments of the other chunk's word and that adds up to 3 words. Otherwise nothing is removed. **A duplicated word is preferred to a lost one.**
- Timed segments are kept by the chunk on whose side of the cut their midpoint falls (`assembleSegments`).

## Alternatives considered
- **Trusting silence detection harder** (stricter thresholds, longer minimum pause): does not help when there is no pause, and a wrong detection still cuts a word.
- **Overlap merge by timestamps:** the default models (`gpt-4o-transcribe`, `gpt-transcribe`) return text only, so text alignment is needed anyway. Segment timestamps are used where they exist.
- **Longest-common-run merge anywhere in the overlap window:** implemented first and rejected. It matched a common phrase ("of the") across a pause, and two half-heard fragments ("f" / "f") across a short chunk, deleting real words. Both cases are unit tests now.

## Consequences
- Every chunk after the first sends 4 s more audio (about 0.7 % more upload and cost at 10-minute chunks).
- Where the overlap holds speech but the chunks' words at the edges disagree, or the overlap holds fewer than about three shared words, the transcript can contain a duplicated word or an edge fragment. The word-loss report prints these as insertions. The suite checks that with several shared words, as a 4 s overlap has in normal speech, the merge is exact.
- A phrase of 4 or more words that really is repeated across a pause exactly at a cut would be kept once. This is judged far less likely than the losses it prevents.
- Jobs planned before this change keep their stored, non-overlapping boundaries (see 004), and the merge leaves them alone.
- Words longer than the overlap (4 s) are not guaranteed. No natural speech comes close.

## Revisit when
- A model returns word timestamps: merge by time instead of text.
- Real transcripts show frequent duplicates at chunk boundaries (tune the evidence rule) or long-running words (raise the overlap).
