/**
 * Word-loss tests for silence detection and chunking, using spoken fixtures in
 * tests/fixtures/silence/ (see scripts/generate-silence-fixtures.mjs).
 *
 * The expected transcripts are the hand-written .txt files. Nothing here calls
 * a transcription API: OracleRecognizer (src/test/silenceFixtures.ts) stands in
 * for the model and garbles any word that a chunk edge cuts through, so a word
 * survives only if some chunk contains all of it and the transcript merge keeps it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { CHUNK_OVERLAP_SECONDS } from '../config';
import { getChunks } from '../storage/chunks';
import { instantSleep, seedJob } from '../test/fakes';
import {
  chunkPlanViolations,
  compareTranscripts,
  detectSilences,
  FixtureAudioSource,
  formatReport,
  loadFixture,
  OracleRecognizer,
  type Fixture,
  type FixtureWord,
} from '../test/silenceFixtures';
import { assembleTranscriptText } from '../transcription/transcript';
import { TranscriptionQueue } from '../transcription/transcriptionQueue';
import type { Chunk } from '../types/jobs';
import type { SilenceInterval } from '../types/media';
import { chunksFromCuts, planChunks, type PlannedChunk } from './audioChunker';

const FIXTURES = [
  'short-silence',
  'normal-silence',
  'long-silence',
  'speech-before-silence',
  'speech-after-silence',
  'multiple-pauses',
  'boundary',
  'adversarial-boundary',
] as const;

/**
 * The fixtures are seconds long, so they are chunked at a matching scale. What
 * matters for word safety is overlap vs word length: 0.5 s is just above the
 * longest fixture word (≈0.48 s), the tightest overlap that should still be
 * safe, so the named scenarios use it. The sweeps also run at 1 s.
 */
const TIGHT_OVERLAP = 0.5;
const OVERLAPS = [TIGHT_OVERLAP, 1];

const report: string[] = [];
afterAll(() => {
  if (report.length) console.info(`\nWord-loss report\n  ${report.join('\n  ')}\n`);
});

const fixtures = new Map<string, Fixture>();
function fixture(name: string): Fixture {
  let f = fixtures.get(name);
  if (!f) fixtures.set(name, (f = loadFixture(name)));
  return f;
}

const speechOf = (f: Fixture): SilenceInterval[] => f.words.map((w) => ({ start: w.start, end: w.end }));

/** Where a plan cuts: the middle of each overlap (the shared edge when chunks do not overlap). */
function cutsOf(plan: readonly PlannedChunk[]): number[] {
  return plan.slice(1).map((c, i) => (c.startTime + plan[i].endTime) / 2);
}

function wordAt(f: Fixture, t: number): FixtureWord | undefined {
  return f.words.find((w) => w.start < t && t < w.end);
}

/** The pause the build put between phrases, widened by `by` into the speech on both sides. */
function widenedDetector(f: Fixture, by: number) {
  return (start: number, end: number): SilenceInterval[] =>
    f.pauses
      .map((p) => ({ start: Math.max(start, p.start - by), end: Math.min(end, p.end + by) }))
      .filter((s) => s.end > s.start);
}

async function plan(
  f: Fixture,
  overlap: number,
  span: number,
  detector: (s: number, e: number) => SilenceInterval[] = (s, e) => detectSilences(f, s, e),
): Promise<PlannedChunk[]> {
  return planChunks(f.duration, span + overlap, async (s, e) => detector(s, e), { overlapSeconds: overlap });
}

/** Tries chunk lengths from the smallest allowed upwards and returns the first plan `accept` likes. */
async function findPlan(
  f: Fixture,
  overlap: number,
  accept: (plan: PlannedChunk[]) => boolean,
  detector?: (s: number, e: number) => SilenceInterval[],
): Promise<PlannedChunk[]> {
  for (let span = 2 * overlap; span < f.duration; span += 0.01) {
    const p = await plan(f, overlap, span, detector);
    if (accept(p)) return p;
  }
  throw new Error(`no chunk length produces the ${f.name} scenario at overlap ${overlap}`);
}

/** Runs the real queue (IndexedDB, retries, context prompts) and the real transcript assembly. */
async function transcribeWithQueue(f: Fixture, chunks: PlannedChunk[], source: FixtureAudioSource): Promise<string> {
  const { job } = await seedJob(
    chunks.map((c) => ({ status: 'pending' as const, startTime: c.startTime, endTime: c.endTime })),
    { duration: f.duration },
  );
  const queue = new TranscriptionQueue(job.id, {
    provider: new OracleRecognizer(f, source),
    source,
    retry: { sleep: instantSleep, maxAttempts: 1 },
  });
  expect(await queue.run()).toBe('completed');
  return assembleTranscriptText(await getChunks(job.id));
}

/** Same chunk → recogniser → assembly path without storage, for sweeps over hundreds of plans. */
async function transcribeInMemory(f: Fixture, chunks: PlannedChunk[], source: FixtureAudioSource): Promise<string> {
  const recognizer = new OracleRecognizer(f, source);
  const done: Chunk[] = [];
  for (const c of chunks) {
    const { text } = await recognizer.transcribe(await source.extract(c.startTime, c.endTime));
    done.push({ ...c, jobId: 'sweep', status: 'completed', attempts: 1, transcript: text.trim(), updatedAt: 0 });
  }
  return assembleTranscriptText(done);
}

/** The core assertion: every expected word is present; extras are reported, not failed. */
function expectNoWordLoss(f: Fixture, label: string, chunks: PlannedChunk[], transcript: string) {
  const r = compareTranscripts(f.expected, transcript);
  report.push(formatReport(label, r, transcript));
  const where = chunks.map((c) => `${c.startTime.toFixed(3)}-${c.endTime.toFixed(3)}`).join(', ');
  expect(r.deletions, `${label}: deleted words (chunks ${where})`).toEqual([]);
  expect(r.substitutions, `${label}: substituted words (chunks ${where})`).toEqual([]);
  expect(r.missing).toEqual([]);
}

function expectSafePlan(f: Fixture, chunks: PlannedChunk[], overlap: number, maxSeconds?: number) {
  expect(chunkPlanViolations(chunks, { duration: f.duration, overlap, maxSeconds, speech: speechOf(f) })).toEqual([]);
}

describe('silence fixtures', () => {
  it.each(FIXTURES)('%s: ground truth matches the words the audio was built from', (name) => {
    const f = fixture(name);
    expect(f.expected.trim().split(/\s+/)).toEqual(f.words.map((w) => w.word));
    expect(f.sampleRate).toBe(16_000);
    for (const p of f.pauses) {
      // The silence detector (same rule as ffmpeg silencedetect) finds every built pause.
      const found = detectSilences(f, 0, f.duration);
      expect(found.some((s) => s.start <= p.start + 0.05 && s.end >= p.end - 0.05), `pause ${p.start}-${p.end}`).toBe(true);
    }
  });

  it('the boundary fixture has no pause the detector could cut at', () => {
    const f = fixture('boundary');
    const inner = detectSilences(f, f.words[0].end, f.words.at(-1)!.start);
    expect(inner).toEqual([]);
  });
});

describe('chunking fixtures end to end', () => {
  const overlap = TIGHT_OVERLAP;
  async function run(name: string, label: string, chunks: PlannedChunk[], source?: FixtureAudioSource) {
    const f = fixture(name);
    expectSafePlan(f, chunks, overlap);
    const transcript = await transcribeWithQueue(f, chunks, source ?? new FixtureAudioSource(f));
    expectNoWordLoss(f, `${label} (overlap ${overlap}s)`, chunks, transcript);
  }

  const inPause = (f: Fixture, t: number) => f.pauses.some((p) => p.start < t && t < p.end);

  it('1. short silence (0.5 s): cut lands in the pause', async () => {
    const f = fixture('short-silence');
    const p = await findPlan(f, overlap, (p) => p.length === 2 && inPause(f, cutsOf(p)[0]));
    await run(f.name, 'short-silence', p);
  });

  it('2. normal silence (2 s): cut lands in the pause', async () => {
    const f = fixture('normal-silence');
    const p = await findPlan(f, overlap, (p) => p.length === 2 && inPause(f, cutsOf(p)[0]));
    await run(f.name, 'normal-silence', p);
  });

  it('3. long silence (10 s): several cuts inside one pause', async () => {
    const f = fixture('long-silence');
    const p = await findPlan(f, overlap, (p) => cutsOf(p).length >= 3 && cutsOf(p).every((t) => inPause(f, t)));
    await run(f.name, 'long-silence', p);
  });

  it('4. speech immediately before the silence the cut uses', async () => {
    const f = fixture('speech-before-silence');
    const lastWord = f.words[2]; // THREE
    const gap = (p: PlannedChunk[]) => Math.min(...cutsOf(p).map((t) => (t > lastWord.end ? t - lastWord.end : Infinity)));
    const p = await findPlan(f, overlap, (p) => gap(p) < 0.25);
    expect(gap(p)).toBeLessThan(0.25);
    await run(f.name, 'speech-before-silence', p);
  });

  it('5. speech immediately after the silence the cut uses', async () => {
    const f = fixture('speech-after-silence');
    const nextWord = f.words[3]; // FOUR
    const gap = (p: PlannedChunk[]) =>
      Math.min(...cutsOf(p).map((t) => (t < nextWord.start && inPause(f, t) ? nextWord.start - t : Infinity)));
    const p = await findPlan(f, overlap, (p) => gap(p) < 0.25);
    await run(f.name, 'speech-after-silence', p);
  });

  it('6. multiple pauses: a cut in each pause', async () => {
    const f = fixture('multiple-pauses');
    const p = await findPlan(f, overlap, (p) => f.pauses.every((q) => cutsOf(p).some((t) => q.start < t && t < q.end)));
    await run(f.name, 'multiple-pauses', p);
  });

  it('7. boundary torture: no pause, so the cut is a hard cut through a word', async () => {
    const f = fixture('boundary');
    // Put the nominal cut in the middle of FIVE; the detector finds no pause there.
    const five = f.words[4];
    const span = (five.start + five.end) / 2;
    const p = await plan(f, overlap, span);
    expect(wordAt(f, cutsOf(p)[0])?.word).toBe('FIVE');
    await run(f.name, 'boundary', p);
  });

  it('7b. boundary torture: silence detection fails outright', async () => {
    const f = fixture('boundary');
    const p = await plan(f, overlap, 2 * overlap + 0.37, () => {
      throw new Error('ffmpeg crashed');
    });
    expect(cutsOf(p).some((t) => wordAt(f, t))).toBe(true);
    await run(f.name, 'boundary (detector crashed)', p);
  });

  describe('8. adversarial: detected silence extends 0.5 s into the speech on both sides', () => {
    // Actual: THREE ends at pause.start, FOUR starts at pause.end. Detected: 0.5 s
    // wider each way. Where the search window clips the detection, the "middle of
    // the pause" lands inside THREE or FOUR.
    const widen = 0.5;

    it.each([
      ['THREE', 2],
      ['FOUR', 3],
    ] as const)('cut lands inside %s and the word is still transcribed', async (word, index) => {
      const f = fixture('adversarial-boundary');
      const detector = widenedDetector(f, widen);
      const p = await findPlan(f, overlap, (p) => cutsOf(p).some((t) => wordAt(f, t) === f.words[index]), detector);
      expect(cutsOf(p).some((t) => wordAt(f, t)?.word === word)).toBe(true);
      // The speech inside the wrongly detected silence must be in at least one chunk whole.
      const pause = f.pauses[0];
      const intruded = [
        { start: pause.start - widen, end: pause.start },
        { start: pause.end, end: pause.end + widen },
      ];
      expect(chunkPlanViolations(p, { duration: f.duration, overlap, speech: intruded })).toEqual([]);
      await run(f.name, `adversarial-boundary, cut inside ${word}`, p, new FixtureAudioSource(f, detector));
    });
  });
});

describe('sweeps: every cut position, every chunk length', () => {
  const STEP = 0.01;

  it.each(FIXTURES)('%s: a single cut anywhere in the file loses no word', async (name) => {
    const f = fixture(name);
    const source = new FixtureAudioSource(f);
    let cutsInsideWords = 0;
    for (const overlap of OVERLAPS) {
      let runs = 0;
      let withExtras = 0;
      let worstWer = 0;
      for (let t = STEP; t < f.duration - STEP / 2; t += STEP) {
        const chunks = chunksFromCuts([t], f.duration, overlap);
        if (wordAt(f, t)) cutsInsideWords++;
        const transcript = await transcribeInMemory(f, chunks, source);
        const r = compareTranscripts(f.expected, transcript);
        if (r.missing.length) {
          throw new Error(`cut at ${t.toFixed(2)} s, overlap ${overlap} s lost [${r.missing.join(' ')}]: ${transcript}`);
        }
        runs++;
        if (r.insertions.length) withExtras++;
        worstWer = Math.max(worstWer, r.wer);
      }
      report.push(
        `${name} single-cut sweep (overlap ${overlap}s): ${runs} cut positions, 0 with deletions, ` +
          `${withExtras} with extra words, worst WER ${(worstWer * 100).toFixed(1)}%`,
      );
    }
    expect(cutsInsideWords).toBeGreaterThan(0);
  });

  it('continuous speech with several words in the overlap comes out exact: no loss, no duplicates', async () => {
    // Production overlaps (4 s) hold several words when the cut is in speech;
    // then the merge has enough evidence to remove every duplicate and fragment.
    const f = fixture('boundary');
    const source = new FixtureAudioSource(f);
    const overlap = 2;
    let runs = 0;
    for (let t = overlap; t < f.duration - overlap; t += STEP) {
      const transcript = await transcribeInMemory(f, chunksFromCuts([t], f.duration, overlap), source);
      const r = compareTranscripts(f.expected, transcript);
      if (r.wer !== 0) throw new Error(`cut at ${t.toFixed(2)} s: ${formatReport('boundary', r, transcript)}`);
      runs++;
    }
    report.push(`boundary single-cut sweep (overlap ${overlap}s): ${runs} cut positions, all exact (WER 0%)`);
    expect(runs).toBeGreaterThan(100);
  });

  it.each(FIXTURES)('%s: planned chunks are safe for every chunk length, real and widened detection', async (name) => {
    const f = fixture(name);
    const detectors = [
      { label: 'real', fn: (s: number, e: number) => detectSilences(f, s, e) },
      { label: 'widened 0.5 s', fn: widenedDetector(f, 0.5) },
      { label: 'widened 1 s', fn: widenedDetector(f, 1) },
    ];
    for (const overlap of OVERLAPS) {
      for (const { label, fn } of detectors) {
        const source = new FixtureAudioSource(f, fn);
        for (let span = 2 * overlap; span < f.duration; span += 0.05) {
          const chunks = await plan(f, overlap, span, fn);
          const violations = chunkPlanViolations(chunks, {
            duration: f.duration,
            overlap,
            maxSeconds: span + overlap,
            speech: speechOf(f),
          });
          if (violations.length) throw new Error(`${label}, span ${span.toFixed(2)}: ${violations.join('; ')}`);
          const r = compareTranscripts(f.expected, await transcribeInMemory(f, chunks, source));
          if (r.missing.length) throw new Error(`${label}, span ${span.toFixed(2)} lost [${r.missing.join(' ')}]`);
        }
      }
    }
  });
});

describe('chunk intervals, independent of transcription', () => {
  // These two use the example's own 1-second scale, hence a 1 s overlap.
  it('actual speech 0-4 and 6-10 s, detected silence 3.5-6.5 s: 3.5-4.0 and 6.0-6.5 s stay in a chunk', async () => {
    const overlap = 1;
    const duration = 60;
    const speech = [
      { start: 0, end: 4 },
      { start: 6, end: 10 },
      { start: 10, end: 60 },
    ];
    const detected = [{ start: 3.5, end: 6.5 }];
    // Window [3.5, 7] so the whole wrong detection is visible to the planner.
    const chunks = await planChunks(duration, 7 + overlap, async (s, e) => detected.filter((d) => d.end > s && d.start < e), {
      overlapSeconds: overlap,
      searchSeconds: 3.5,
    });
    expect(cutsOf(chunks)[0]).toBe(5);
    const intruded = [
      { start: 3.5, end: 4.0 },
      { start: 6.0, end: 6.5 },
    ];
    expect(chunkPlanViolations(chunks, { duration, overlap, speech: [...speech.slice(0, 2), ...intruded] })).toEqual([]);
    expect(chunkPlanViolations(chunks, { duration, overlap })).toEqual([]);
  });

  it('a detection shifted into speech moves the cut into a word, which the overlap still covers', async () => {
    const overlap = 1;
    // Real pause 4-6 s; the detection is shifted 1.5 s early (2.5-4.5 s), so its middle, 3.5 s, is inside a word at 3.2-3.9 s.
    const chunks = await planChunks(20, 4.5 + overlap, async () => [{ start: 2.5, end: 4.5 }], { overlapSeconds: overlap });
    expect(cutsOf(chunks)[0]).toBe(3.5);
    expect(chunkPlanViolations(chunks, { duration: 20, overlap, speech: [{ start: 3.2, end: 3.9 }] })).toEqual([]);
  });

  it('holds its invariants for arbitrary silences and lengths (seeded property test)', async () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const overlap = CHUNK_OVERLAP_SECONDS;
    for (let run = 0; run < 300; run++) {
      const duration = 1 + rand() * 7200;
      const maxSeconds = 3 * overlap + rand() * 900;
      const silences: SilenceInterval[] = [];
      for (let t = rand() * 20; t < duration; t += rand() * 60) {
        silences.push({ start: t, end: t + rand() * 5 });
      }
      const chunks = await planChunks(duration, maxSeconds, async (s, e) => silences.filter((x) => x.end > s && x.start < e), {
        overlapSeconds: overlap,
      });
      // Any stretch of speech no longer than the overlap, anywhere, sits wholly inside one chunk.
      const probes = Array.from({ length: 50 }, () => {
        const start = rand() * Math.max(0, duration - overlap);
        return { start, end: Math.min(duration, start + overlap) };
      });
      const violations = chunkPlanViolations(chunks, { duration, overlap, maxSeconds, speech: probes });
      if (violations.length) throw new Error(`run ${run} (duration ${duration}, max ${maxSeconds}): ${violations.join('; ')}`);
    }
  });
});
