import { useState } from 'react';
import type { Chunk, TranscriptionJob } from '../types/jobs';
import type { RunStats } from '../useTranscriber';
import { formatDuration } from '../utils/format';
import { TranscriptDownload } from './TranscriptDownload';

interface Props {
  job: TranscriptionJob;
  chunks: Chunk[];
  running: boolean;
  pauseRequested: boolean;
  currentChunkId: number | null;
  currentActivity: 'extracting' | 'transcribing' | null;
  notice: string | null;
  stats: RunStats | null;
  onPause: () => void;
  onCancel: (mode: 'keep' | 'delete') => void;
  onResume: () => void;
  onRetryChunk: (chunkId: number) => void;
  onDownload: () => void;
  onDelete: () => void;
}

/** Remaining time from this run's observed speed (wall time per audio second). */
function estimateRemaining(stats: RunStats | null, chunks: Chunk[]): number | undefined {
  if (!stats || stats.audioSecondsDone <= 0) return undefined;
  const remainingAudio = chunks
    .filter((c) => c.status !== 'completed')
    .reduce((sum, c) => sum + (c.endTime - c.startTime), 0);
  const elapsed = (Date.now() - stats.startedAt) / 1000;
  return (elapsed / stats.audioSecondsDone) * remainingAudio;
}

export function JobProgress(props: Props) {
  const { job, chunks, running, currentChunkId, currentActivity, notice, stats } = props;
  const [confirmCancel, setConfirmCancel] = useState(false);
  const done = chunks.filter((c) => c.status === 'completed').length;
  const failed = chunks.filter((c) => c.status === 'failed');
  const total = chunks.length;
  const audioDone = chunks
    .filter((c) => c.status === 'completed')
    .reduce((sum, c) => sum + (c.endTime - c.startTime), 0);
  const percent = job.duration > 0 ? Math.round((audioDone / job.duration) * 100) : 0;
  const eta = running ? estimateRemaining(stats, chunks) : undefined;
  const complete = job.status === 'completed';

  return (
    <section className="card" aria-live="polite">
      <h2>{complete ? 'Transcription complete' : running ? 'Transcribing' : 'Incomplete transcription found'}</h2>
      <p className="job-title">
        <strong>{job.sourceFileName}</strong> · {formatDuration(job.duration)} · {job.settings.model}
      </p>

      <progress max={100} value={percent} aria-label="Transcription progress" />
      <p>
        {done} / {total} chunks complete ({percent}%)
        {failed.length > 0 && <span className="error-text"> · {failed.length} failed</span>}
      </p>

      {running && currentChunkId !== null && (
        <p>
          Current: chunk {currentChunkId + 1}{' '}
          <span className="muted">
            ({currentActivity === 'extracting' ? 'preparing audio' : 'waiting for OpenAI'})
          </span>
        </p>
      )}
      {running && eta !== undefined && <p>Estimated remaining: {formatDuration(eta)}</p>}
      {running && notice && <p className="notice">{notice}</p>}
      {job.error && !running && <p className="error-text">{job.error}</p>}

      <div className="row">
        {running && !confirmCancel && (
          <>
            <button type="button" onClick={props.onPause} disabled={props.pauseRequested}>
              {props.pauseRequested ? 'Pausing after this chunk…' : 'Pause'}
            </button>
            <button type="button" onClick={() => setConfirmCancel(true)}>
              Cancel
            </button>
          </>
        )}
        {running && confirmCancel && (
          <>
            <span>Stop now?</span>
            <button
              type="button"
              onClick={() => {
                setConfirmCancel(false);
                props.onCancel('keep');
              }}
            >
              Stop, keep progress
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                setConfirmCancel(false);
                props.onCancel('delete');
              }}
            >
              Stop and delete job
            </button>
            <button type="button" className="link" onClick={() => setConfirmCancel(false)}>
              Keep going
            </button>
          </>
        )}
        {!running && !complete && (
          <button type="button" className="primary" onClick={props.onResume}>
            {failed.length > 0 && failed.length + done === total ? 'Retry failed chunks' : 'Resume'}
          </button>
        )}
        {complete && <TranscriptDownload fileName={job.sourceFileName} onDownload={props.onDownload} />}
        {!running && (
          <button type="button" className="danger" onClick={props.onDelete}>
            Delete job
          </button>
        )}
      </div>

      {failed.length > 0 && (
        <ul className="failed-list">
          {failed.map((c) => (
            <li key={c.id}>
              <div>
                <strong>Chunk {c.id + 1} failed</strong>{' '}
                <span className="muted">
                  ({formatDuration(c.startTime)}–{formatDuration(c.endTime)})
                </span>
                <div>Reason: {c.error}</div>
              </div>
              {!running && (
                <button type="button" onClick={() => props.onRetryChunk(c.id)}>
                  Retry
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <details>
        <summary>Chunks</summary>
        <ol className="chunk-grid">
          {chunks.map((c) => (
            <li
              key={c.id}
              className={`chunk chunk-${c.status}`}
              title={`Chunk ${c.id + 1}: ${formatDuration(c.startTime)}–${formatDuration(c.endTime)} · ${c.status}${c.attempts ? ` · ${c.attempts} attempt(s)` : ''}`}
            >
              {c.id + 1}
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
