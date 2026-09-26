import type { MediaProbe } from '../types/media';

/**
 * Asks the browser's own media stack for the duration. This reads only the
 * container headers, is instant, and needs no ffmpeg — but it only works for
 * formats the browser can play, so ffmpeg's probe is the source of truth.
 */
export function probeNativeDuration(file: Blob, timeoutMs = 10_000): Promise<number | undefined> {
  return new Promise((resolve) => {
    const isVideo = file.type.startsWith('video/');
    const el = document.createElement(isVideo ? 'video' : 'audio');
    const url = URL.createObjectURL(file);
    let settled = false;
    const done = (value: number | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeAttribute('src');
      el.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    el.preload = 'metadata';
    el.muted = true;
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : undefined);
    el.onerror = () => done(undefined);
    el.src = url;
  });
}

/** Parses the "Duration:" line and stream list printed by `ffmpeg -i <file>`. */
export function parseFfmpegProbe(log: string): MediaProbe {
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(log);
  const duration = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN;
  const hasAudio = /Stream #\d+:\d+[^\n]*:\s*Audio:/.test(log);
  return { duration, hasAudio };
}

/** Parses `silencedetect` output into [start, end] pairs (relative seconds). */
export function parseSilenceLog(log: string, windowDuration: number): Array<{ start: number; end: number }> {
  const result: Array<{ start: number; end: number }> = [];
  let openStart: number | null = null;
  for (const line of log.split('\n')) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (start) {
      openStart = Math.max(0, Number(start[1]));
      continue;
    }
    const end = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (end) {
      result.push({ start: openStart ?? 0, end: Number(end[1]) });
      openStart = null;
    }
  }
  // Silence still running when the window ended.
  if (openStart !== null) result.push({ start: openStart, end: windowDuration });
  return result.filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
}
