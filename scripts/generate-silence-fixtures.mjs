// Generates the spoken-word WAV fixtures in tests/fixtures/silence/ used by
// src/media/silenceChunking.test.ts.
//
// Each word is synthesised on its own with the offline eSpeak NG voice, trimmed
// to its audible extent and placed on the timeline at a known position, so the
// exact start/end of every word and every pause is known by construction and
// written to <name>.json. The ground-truth <name>.txt files are written by hand
// and are never produced here, nor by transcribing the audio.
//
// Usage: node scripts/generate-silence-fixtures.mjs   (needs `espeak-ng` on PATH,
// e.g. `apt-get install espeak-ng`). Output is deterministic for a given
// eSpeak NG version; the tests only read the committed files.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'tests', 'fixtures', 'silence');
const SAMPLE_RATE = 16_000;
const VOICE = 'en-us';
const WORDS_PER_MINUTE = '160';
/** Gap between words inside a phrase: well below the 0.35 s silence detector minimum. */
const WORD_GAP = 0.08;
/** Quiet lead-in and tail at the ends of each file. */
const EDGE_SILENCE = 0.25;
/** Samples quieter than this (fraction of full scale, ≈ -46 dBFS) are trimmed off each word. */
const TRIM_THRESHOLD = 0.005;

/**
 * A scenario is a list of phrases (strings of words) and pauses (seconds).
 * Keep in sync with the hand-written .txt ground truth next to each WAV.
 */
const SCENARIOS = {
  'short-silence': ['ONE TWO THREE', 0.5, 'FOUR FIVE SIX'],
  'normal-silence': ['ONE TWO THREE', 2, 'FOUR FIVE SIX'],
  'long-silence': ['ONE TWO THREE', 10, 'FOUR FIVE SIX'],
  'speech-before-silence': ['ONE TWO THREE', 1.5, 'FOUR FIVE SIX'],
  'speech-after-silence': ['ONE TWO THREE', 1.5, 'FOUR FIVE SIX'],
  'multiple-pauses': ['ONE TWO', 1, 'THREE FOUR', 1, 'FIVE SIX'],
  // Continuous speech: no pause long enough for the silence detector, so any
  // cut through it is a hard cut that can land on a word.
  boundary: ['ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT NINE TEN'],
  'adversarial-boundary': ['ONE TWO THREE', 2, 'FOUR FIVE SIX'],
};

function readWav(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path}: not a WAV`);
  let offset = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    let size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      // eSpeak writes 0x7fffffff as the size when streaming; use what is there.
      size = Math.min(size, buf.length - body);
      if (channels !== 1 || bits !== 16) throw new Error(`${path}: expected mono 16-bit PCM`);
      const samples = new Float32Array(size / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(body + i * 2) / 32768;
      return { rate, samples };
    }
    offset = body + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

function resample(samples, from, to) {
  if (from === to) return samples;
  const out = new Float32Array(Math.floor((samples.length * to) / from));
  for (let i = 0; i < out.length; i++) {
    const x = (i * from) / to;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    out[i] = samples[i0] + (samples[i1] - samples[i0]) * (x - i0);
  }
  return out;
}

function trim(samples) {
  let first = 0;
  while (first < samples.length && Math.abs(samples[first]) < TRIM_THRESHOLD) first++;
  let last = samples.length - 1;
  while (last > first && Math.abs(samples[last]) < TRIM_THRESHOLD) last--;
  return samples.slice(first, last + 1);
}

function synthesiseWord(word, dir) {
  const path = join(dir, `${word}.wav`);
  execFileSync('espeak-ng', ['-v', VOICE, '-s', WORDS_PER_MINUTE, '-w', path, word.toLowerCase()]);
  const { rate, samples } = readWav(path);
  return trim(resample(samples, rate, SAMPLE_RATE));
}

function encodeWav(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  }
  return buf;
}

const round = (seconds) => Math.round(seconds * 1e6) / 1e6;

function build(name, parts, cache) {
  const pieces = [];
  const words = [];
  const pauses = [];
  let cursor = 0; // in samples
  const pushSilence = (seconds) => {
    const n = Math.round(seconds * SAMPLE_RATE);
    pieces.push(new Float32Array(n));
    cursor += n;
  };
  pushSilence(EDGE_SILENCE);
  parts.forEach((part, index) => {
    if (typeof part === 'number') {
      const start = cursor;
      pushSilence(part);
      pauses.push({ start: round(start / SAMPLE_RATE), end: round(cursor / SAMPLE_RATE) });
      return;
    }
    part.split(/\s+/).forEach((word, i) => {
      if (i > 0) pushSilence(WORD_GAP);
      const audio = cache.get(word);
      words.push({ word, start: round(cursor / SAMPLE_RATE), end: round((cursor + audio.length) / SAMPLE_RATE), phrase: index });
      pieces.push(audio);
      cursor += audio.length;
    });
  });
  pushSilence(EDGE_SILENCE);

  const samples = new Float32Array(cursor);
  let at = 0;
  for (const piece of pieces) {
    samples.set(piece, at);
    at += piece.length;
  }
  writeFileSync(join(OUT, `${name}.wav`), encodeWav(samples));
  const manifest = {
    description: 'Generated by scripts/generate-silence-fixtures.mjs. Word timings are known by construction, not by transcription.',
    voice: `espeak-ng ${VOICE} @ ${WORDS_PER_MINUTE} wpm`,
    sampleRate: SAMPLE_RATE,
    duration: round(cursor / SAMPLE_RATE),
    words,
    pauses,
  };
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'silence-fixtures-'));
try {
  const cache = new Map();
  for (const parts of Object.values(SCENARIOS)) {
    for (const part of parts) {
      if (typeof part !== 'string') continue;
      for (const word of part.split(/\s+/)) if (!cache.has(word)) cache.set(word, synthesiseWord(word, tmp));
    }
  }
  for (const [name, parts] of Object.entries(SCENARIOS)) {
    const m = build(name, parts, cache);
    console.log(`${name}.wav  ${m.duration.toFixed(2)} s, ${m.words.length} words, pauses ${JSON.stringify(m.pauses)}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
