import { describe, expect, it } from 'vitest';
import { chunksFromCuts, maxChunkSeconds, pickBoundary, planChunks } from './audioChunker';
import { parseFfmpegProbe, parseSilenceLog } from './mediaInfo';

describe('maxChunkSeconds', () => {
  it('derives the limit from target size and bitrate', () => {
    // 20 MB at 48 kbps ≈ 58 minutes
    expect(maxChunkSeconds({ targetBytes: 20 * 1024 * 1024, bitrateBps: 48_000, preferredMaxSeconds: 1e9 })).toBe(3495);
    // WAV-like bitrates make size the binding constraint
    expect(maxChunkSeconds({ targetBytes: 20 * 1024 * 1024, bitrateBps: 256_000, preferredMaxSeconds: 1e9 })).toBe(655);
  });

  it('respects model duration limits with a margin, and the preferred maximum', () => {
    expect(maxChunkSeconds({ modelMaxSeconds: 1500, preferredMaxSeconds: 1e9 })).toBe(1350);
    expect(maxChunkSeconds({ preferredMaxSeconds: 600 })).toBe(600);
  });
});

describe('pickBoundary', () => {
  it('chooses the middle of the longest pause in the window', () => {
    expect(pickBoundary([{ start: 575, end: 576 }, { start: 590, end: 594 }], 570, 600)).toBe(592);
  });
  it('clips pauses to the window and returns undefined when there are none', () => {
    expect(pickBoundary([{ start: 598, end: 610 }], 570, 600)).toBe(599);
    expect(pickBoundary([], 570, 600)).toBeUndefined();
  });
});

describe('planChunks', () => {
  it('covers the whole duration with overlapping chunks no longer than the maximum', async () => {
    const silences = [
      { start: 586, end: 588 },
      { start: 1170, end: 1171 },
    ];
    const plan = await planChunks(2 * 3600 + 5, 600, async (s, e) => silences.filter((x) => x.end > s && x.start < e), {
      overlapSeconds: 4,
    });
    // Cuts at the middle of each pause (587, 1170.5); chunks reach 2 s past each cut.
    expect(plan[0]).toEqual({ id: 0, startTime: 0, endTime: 589 });
    expect(plan[1]).toEqual({ id: 1, startTime: 585, endTime: 1172.5 });
    for (let i = 0; i < plan.length; i++) {
      expect(plan[i].id).toBe(i);
      expect(plan[i].endTime - plan[i].startTime).toBeLessThanOrEqual(600);
      if (i > 0) expect(plan[i - 1].endTime - plan[i].startTime).toBe(4);
    }
    expect(plan[0].startTime).toBe(0);
    expect(plan.at(-1)?.endTime).toBe(7205);
    expect(plan.length).toBe(13);
  });

  it('returns a single chunk for short media', async () => {
    expect(await planChunks(42, 600, async () => [])).toEqual([{ id: 0, startTime: 0, endTime: 42 }]);
  });

  it('falls back to hard cuts if silence detection fails, still overlapping', async () => {
    const plan = await planChunks(1500, 600, async () => {
      throw new Error('ffmpeg crashed');
    }, { overlapSeconds: 4 });
    expect(plan.map((c) => [c.startTime, c.endTime])).toEqual([
      [0, 598],
      [594, 1194],
      [1190, 1500],
    ]);
  });

  it('lets the previous chunk take the rest when a cut lands too close to the end', async () => {
    // Nominal cut at 596 (600 − 4 s overlap). In a 597 s file that leaves 1 s
    // after the cut, less than the 2 s the next chunk would need before it.
    expect(await planChunks(597, 600, async () => [], { overlapSeconds: 4 })).toEqual([
      { id: 0, startTime: 0, endTime: 597 },
    ]);
    expect(await planChunks(597.5, 600, async () => [{ start: 595.5, end: 596 }], { overlapSeconds: 4 })).toEqual([
      { id: 0, startTime: 0, endTime: 597.5 },
    ]);
    // With room for the overlap, it cuts as usual.
    expect((await planChunks(599, 600, async () => [], { overlapSeconds: 4 })).length).toBe(2);
  });

  it('rejects an overlap too large for the chunk length', async () => {
    await expect(planChunks(100, 10, async () => [], { overlapSeconds: 4 })).rejects.toThrow(/too short/);
  });
});

describe('chunksFromCuts', () => {
  it('extends every chunk half the overlap past each cut, clamped to the media', () => {
    expect(chunksFromCuts([10, 20], 25, 2)).toEqual([
      { id: 0, startTime: 0, endTime: 11 },
      { id: 1, startTime: 9, endTime: 21 },
      { id: 2, startTime: 19, endTime: 25 },
    ]);
    expect(chunksFromCuts([], 25, 2)).toEqual([{ id: 0, startTime: 0, endTime: 25 }]);
  });
});

describe('ffmpeg log parsing', () => {
  it('parses duration and audio streams', () => {
    const log = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/input/media.mp4':
  Duration: 02:03:04.50, start: 0.000000, bitrate: 1290 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080
  Stream #0:1[0x2](eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)`;
    expect(parseFfmpegProbe(log)).toEqual({ duration: 2 * 3600 + 3 * 60 + 4.5, hasAudio: true });
  });

  it('detects video without audio and unknown duration', () => {
    const probe = parseFfmpegProbe(`Duration: N/A\n  Stream #0:0: Video: vp9`);
    expect(probe.hasAudio).toBe(false);
    expect(Number.isNaN(probe.duration)).toBe(true);
  });

  it('parses silencedetect output including an unterminated silence', () => {
    const log = `[silencedetect @ 0x1] silence_start: 3.2
[silencedetect @ 0x1] silence_end: 4.1 | silence_duration: 0.9
[silencedetect @ 0x1] silence_start: 28.5`;
    expect(parseSilenceLog(log, 30)).toEqual([
      { start: 3.2, end: 4.1 },
      { start: 28.5, end: 30 },
    ]);
  });
});
