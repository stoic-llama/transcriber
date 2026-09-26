import { describe, expect, it } from 'vitest';
import { fingerprintFile, sampleRanges } from './fileHash';
import { formatBytes, formatDuration, maskApiKey, transcriptFileName } from './format';

describe('format helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(2 * 3600 + 3 * 60 + 10)).toBe('2h 03m');
    expect(formatDuration(65)).toBe('1m 05s');
    expect(formatDuration(9)).toBe('9s');
  });
  it('formats sizes', () => {
    expect(formatBytes(1.2 * 1024 ** 3)).toBe('1.2 GB');
    expect(formatBytes(500)).toBe('500 B');
  });
  it('derives the transcript filename from the source', () => {
    expect(transcriptFileName('lecture.mp4')).toBe('lecture.txt');
    expect(transcriptFileName('My.Talk.final.m4a')).toBe('My.Talk.final.txt');
    expect(transcriptFileName('noext')).toBe('noext.txt');
  });
  it('masks API keys', () => {
    const masked = maskApiKey('sk-proj-abcdefghijklmnop1234');
    expect(masked.startsWith('sk-')).toBe(true);
    expect(masked.endsWith('1234')).toBe(true);
    expect(masked).not.toContain('abcdefgh');
  });
});

describe('fingerprintFile', () => {
  const makeFile = (content: Uint8Array<ArrayBuffer>, name = 'a.mp4', lastModified = 1) =>
    new File([content], name, { type: 'video/mp4', lastModified });

  it('samples only start, middle and end of large files', () => {
    const MB = 1024 * 1024;
    expect(sampleRanges(100 * MB)).toEqual([
      [0, MB],
      [49.5 * MB, 50.5 * MB],
      [99 * MB, 100 * MB],
    ]);
    expect(sampleRanges(10)).toEqual([[0, 10]]);
  });

  it('is stable for the same file and differs for different content or metadata', async () => {
    const data = new Uint8Array(5 * 1024 * 1024).map((_, i) => i % 251);
    const a = await fingerprintFile(makeFile(data));
    expect(await fingerprintFile(makeFile(data, 'renamed.mp4'))).toBe(a);
    const changed = data.slice();
    changed[changed.length - 1] ^= 1;
    expect(await fingerprintFile(makeFile(changed))).not.toBe(a);
    expect(await fingerprintFile(makeFile(data, 'a.mp4', 2))).not.toBe(a);
  });
});
