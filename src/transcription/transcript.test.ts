import { describe, expect, it } from 'vitest';
import type { Chunk } from '../types/jobs';
import {
  assembleSegments,
  assembleTranscriptText,
  contextTail,
  findOverlap,
  isJobComplete,
  toSourceSegments,
} from './transcript';

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

function overlapping(id: number, start: number, end: number, transcript: string, segments?: Chunk['segments']): Chunk {
  return { jobId: 'j', id, startTime: start, endTime: end, status: 'completed', attempts: 1, transcript, segments, updatedAt: 0 };
}

describe('overlapping chunks', () => {
  it('keeps the words both chunks heard once, with the original punctuation', () => {
    const chunks = [
      overlapping(0, 0, 602, 'We met on Monday. Then we talked about the budget'),
      overlapping(1, 598, 1200, 'talked about the budget for next year.'),
    ];
    expect(assembleTranscriptText(chunks)).toBe('We met on Monday. Then we talked about the budget\n\nfor next year.\n');
  });

  it('takes a word cut by a chunk edge from the chunk that heard it whole', () => {
    // Chunk 0 ends inside FOUR ("fo"); chunk 1 starts inside TWO ("o").
    const chunks = [overlapping(0, 0, 602, 'one two three fo'), overlapping(1, 598, 1200, 'o three four five')];
    expect(assembleTranscriptText(chunks)).toBe('one two three\n\nfour five\n');
    const long = [overlapping(0, 0, 602, 'so we went to the park an'), overlapping(1, 598, 1200, 'we went to the park and then home')];
    expect(assembleTranscriptText(long)).toBe('so we went to the park\n\nand then home\n');
  });

  it('removes nothing when the chunks share no words', () => {
    const chunks = [overlapping(0, 0, 602, 'One, two.'), overlapping(1, 598, 1200, 'Three, four.')];
    expect(assembleTranscriptText(chunks)).toBe('One, two.\n\nThree, four.\n');
  });

  it('does not match half-heard words at the far edges, which would delete real words', () => {
    // "F." is the start of FOUR cut off at chunk 0's end; the trailing "f." of
    // chunk 1 is the start of FIVE cut off at chunk 1's end. They are not the same word.
    const chunks = [overlapping(0, 0, 3.6, 'F.'), overlapping(1, 3.1, 4.2, 'Four, f.'), overlapping(2, 3.7, 5.2, 'R, five, six.')];
    expect(assembleTranscriptText(chunks)).toBe('F.\n\nFour, f.\n\nR, five, six.\n');
  });

  it('does not merge a phrase that merely recurs on both sides of a pause', () => {
    const chunks = [
      overlapping(0, 0, 602, 'And that is the end of the story.'),
      overlapping(1, 598, 1200, 'Of the things we covered, budgets came first.'),
    ];
    expect(assembleTranscriptText(chunks)).toBe(
      'And that is the end of the story.\n\nOf the things we covered, budgets came first.\n',
    );
    // Identically numbered mock transcripts (as in the browser smoke test) stay intact too.
    expect(findOverlap(['transcript', 'of', 'chunk', '1'], ['transcript', 'of', 'chunk', '2'])).toEqual({ keepA: 4, skipB: 0 });
  });

  it('prefers a duplicate to a guess when the evidence is thin', () => {
    expect(findOverlap(['one', 'two', 'three'], ['three', 'four'])).toEqual({ keepA: 3, skipB: 0 });
    expect(findOverlap(['one', 'two', 'three'], ['two', 'three', 'four'])).toEqual({ keepA: 3, skipB: 0 });
    expect(findOverlap(['x', 'one', 'two', 'three'], ['one', 'two', 'three', 'four'])).toEqual({ keepA: 4, skipB: 3 });
    // A dropped edge word that is not a fragment of the other chunk's word blocks a short match.
    expect(findOverlap(['x', 'one', 'two', 'three', 'dog'], ['one', 'two', 'three', 'four'])).toEqual({ keepA: 5, skipB: 0 });
  });

  it('leaves chunks planned without overlap (older jobs) untouched', () => {
    const chunks = [overlapping(0, 0, 600, 'the end of one'), overlapping(1, 600, 1200, 'the end of two')];
    expect(assembleTranscriptText(chunks)).toBe('the end of one\n\nthe end of two\n');
  });

  it('keeps each timed segment only on its side of the cut', () => {
    const chunks = [
      overlapping(0, 0, 602, '', [
        { start: 590, end: 599, text: 'a' },
        { start: 599, end: 602, text: 'b (cut short)' },
      ]),
      overlapping(1, 598, 1200, '', [
        { start: 598, end: 599.5, text: 'a (tail)' },
        { start: 599.5, end: 603, text: 'b' },
      ]),
    ];
    expect(assembleSegments(chunks).map((s) => s.text)).toEqual(['a', 'b']);
  });
});

