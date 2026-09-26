import { describe, expect, it } from 'vitest';
import type { Chunk } from '../types/jobs';
import { assembleSegments, assembleTranscriptText, contextTail, isJobComplete, toSourceSegments } from './transcript';

function chunk(id: number, transcript: string, status: Chunk['status'] = 'completed'): Chunk {
  return {
    jobId: 'j',
    id,
    startTime: id * 100,
    endTime: (id + 1) * 100,
    status,
    attempts: 1,
    transcript,
    segments: [{ start: id * 100, end: (id + 1) * 100, text: transcript }],
    updatedAt: 0,
  };
}

describe('transcript assembly', () => {
  it('orders by chunk position, not by completion/storage order', () => {
    const shuffled = [chunk(2, 'three'), chunk(0, 'one'), chunk(1, 'two')];
    expect(assembleTranscriptText(shuffled)).toBe('one\n\ntwo\n\nthree\n');
    expect(assembleSegments(shuffled).map((s) => s.text)).toEqual(['one', 'two', 'three']);
  });

  it('trims whitespace and skips empty chunks', () => {
    expect(assembleTranscriptText([chunk(0, '  hello '), chunk(1, '   '), chunk(2, 'world')])).toBe(
      'hello\n\nworld\n',
    );
  });

  it('detects completion only when every chunk is done', () => {
    expect(isJobComplete([chunk(0, 'a'), chunk(1, 'b')])).toBe(true);
    expect(isJobComplete([chunk(0, 'a'), chunk(1, '', 'failed')])).toBe(false);
    expect(isJobComplete([])).toBe(false);
  });

  it('offsets provider segments onto the source timeline', () => {
    const segments = toSourceSegments(
      { text: 'a b', segments: [{ start: 0, end: 2, text: ' a' }, { start: 2, end: 5, text: 'b ' }] },
      600,
      604,
    );
    expect(segments).toEqual([
      { start: 600, end: 602, text: 'a' },
      { start: 602, end: 604, text: 'b' },
    ]);
  });

  it('falls back to one segment per chunk', () => {
    expect(toSourceSegments({ text: ' hi ' }, 10, 20)).toEqual([{ start: 10, end: 20, text: 'hi' }]);
    expect(toSourceSegments({ text: ' ' }, 10, 20)).toEqual([]);
  });

  it('takes a word-aligned tail for context prompts', () => {
    expect(contextTail('one two three four', 9)).toBe('four');
    expect(contextTail('short', 100)).toBe('short');
    expect(contextTail(undefined, 10)).toBeUndefined();
  });
});
