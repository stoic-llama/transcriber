# Silence and chunking fixtures

Spoken-word recordings for the word-loss suite, `src/media/silenceChunking.test.ts`. That suite checks that silence detection and chunking never lose a word ([decision 009](../../../docs/decisions/009-overlapping-chunks.md)).

| File | Audio (16 kHz mono WAV) | Scenario |
| --- | --- | --- |
| `short-silence` | ONE TWO THREE · 0.5 s · FOUR FIVE SIX | 1. short silence |
| `normal-silence` | ONE TWO THREE · 2 s · FOUR FIVE SIX | 2. normal silence |
| `long-silence` | ONE TWO THREE · 10 s · FOUR FIVE SIX | 3. long silence (several cuts inside it) |
| `speech-before-silence` | ONE TWO THREE · 1.5 s · FOUR FIVE SIX | 4. a cut within 0.25 s after THREE ends |
| `speech-after-silence` | ONE TWO THREE · 1.5 s · FOUR FIVE SIX | 5. a cut within 0.25 s before FOUR starts |
| `multiple-pauses` | ONE TWO · 1 s · THREE FOUR · 1 s · FIVE SIX | 6. a cut in each pause |
| `boundary` | ONE … TEN, no pause | 7. hard cuts through words (no silence to find, or the detector crashes) |
| `adversarial-boundary` | ONE TWO THREE · 2 s · FOUR FIVE SIX | 8. detected silence widened 0.5 s into the speech on both sides, so the cut lands inside THREE or FOUR |

Every file also has a leading and a trailing 0.25 s of silence.

- **`<name>.txt`: ground truth.** Hand-written and independent of the audio. It was not produced by transcribing anything. Comparison normalises only whitespace, punctuation and letter case.
- **`<name>.wav`: the audio.** Each word is synthesised separately by the offline eSpeak NG voice, trimmed to its audible extent, and placed with 0.08 s gaps inside a phrase and the listed pauses between phrases. The 0.08 s gaps are too short for the silence detector.
- **`<name>.json`: build manifest.** Records where each word and pause was placed. It is known from construction, not from recognition. The test's offline stand-in recogniser uses it to label the words it finds in a chunk's samples.

Regenerate with `node scripts/generate-silence-fixtures.mjs`. It needs `espeak-ng`, for example from `apt-get install espeak-ng`. Keep the phrases in the script in step with the `.txt` files; the suite checks they agree.
