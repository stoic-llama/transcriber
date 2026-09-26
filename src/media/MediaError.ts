export type MediaErrorKind = 'unsupported' | 'no_audio' | 'memory' | 'load_failed' | 'file_unreadable';

const MESSAGES: Record<MediaErrorKind, string> = {
  unsupported: 'This browser could not process this media format. Try MP3, WAV, M4A, MP4, or WebM.',
  no_audio: 'This file does not seem to contain an audio track.',
  memory:
    'The browser ran out of memory while processing audio. Close other tabs and press Resume — completed chunks are kept.',
  load_failed:
    'Could not load the audio processing engine (ffmpeg.wasm). Check your internet connection and reload the page.',
  file_unreadable:
    'The selected file can no longer be read. It may have been moved or deleted. Select it again to continue.',
};

export class MediaError extends Error {
  readonly kind: MediaErrorKind;
  readonly userMessage: string;

  constructor(kind: MediaErrorKind, detail?: string, options?: { cause?: unknown }) {
    super(detail ? `${MESSAGES[kind]} (${detail})` : MESSAGES[kind], options);
    this.name = 'MediaError';
    this.kind = kind;
    this.userMessage = MESSAGES[kind];
  }
}

export function looksLikeOutOfMemory(error: unknown): boolean {
  const text = String(error instanceof Error ? `${error.name} ${error.message}` : error);
  return /out of memory|memory access out of bounds|Cannot enlarge memory|RangeError: Array buffer allocation/i.test(text);
}
