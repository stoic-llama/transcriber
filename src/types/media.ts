export interface MediaProbe {
  /** Duration in seconds. */
  duration: number;
  hasAudio: boolean;
}

export interface SilenceInterval {
  start: number;
  end: number;
}

/**
 * Abstraction over "the user's local file" so the queue can be tested without
 * ffmpeg. The real implementation is FfmpegAudioSource.
 */
export interface AudioSource {
  probe(): Promise<MediaProbe>;
  /** Silences found in [start, end) of the source timeline (absolute seconds). */
  findSilences(start: number, end: number): Promise<SilenceInterval[]>;
  /** Encode [start, end) as an upload-ready audio blob. */
  extract(start: number, end: number, options?: { bitrate?: number }): Promise<Blob>;
  dispose(): Promise<void>;
}
