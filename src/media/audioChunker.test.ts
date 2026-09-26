import { describe, expect, it } from 'vitest';
import { maxChunkSeconds, pickBoundary, planChunks } from './audioChunker';
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
  it('covers the whole duration contiguously without exceeding the maximum', async () => {
    const silences = [
      { start: 590, end: 592 },
      { start: 1180, end: 1181 },
    ];
    const plan = await planChunks(2 * 3600 + 5, 600, async (s, e) => silences.filter((x) => x.end > s && x.start < e));
    expect(plan[0]).toEqual({ id: 0, startTime: 0, endTime: 591 });
    expect(plan[1]).toEqual({ id: 1, startTime: 591, endTime: 1180.5 });
    for (let i = 0; i < plan.length; i++) {
      expect(plan[i].id).toBe(i);
      expect(plan[i].endTime - plan[i].startTime).toBeLessThanOrEqual(600);
      if (i > 0) expect(plan[i].startTime).toBe(plan[i - 1].endTime);
    }
    expect(plan.at(-1)?.endTime).toBe(7205);
    expect(plan.length).toBe(13);
  });

  it('returns a single chunk for short media', async () => {
    expect(await planChunks(42, 600, async () => [])).toEqual([{ id: 0, startTime: 0, endTime: 42 }]);
  });

  it('falls back to hard cuts if silence detection fails', async () => {
    const plan = await planChunks(1500, 600, async () => {
      throw new Error('ffmpeg crashed');
    });
    expect(plan.map((c) => [c.startTime, c.endTime])).toEqual([
      [0, 600],
      [600, 1200],
      [1200, 1500],
    ]);
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
