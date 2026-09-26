import type { TranscriptionJob } from '../types/jobs';
import { formatDuration } from '../utils/format';

interface Props {
  jobs: TranscriptionJob[];
  activeJobId: string | null;
  busy: boolean;
  onOpen: (jobId: string) => void;
  onResume: (jobId: string) => void;
  onDelete: (jobId: string) => void;
  onDownload: (jobId: string) => void;
}

export function JobList({ jobs, activeJobId, busy, onOpen, onResume, onDelete, onDownload }: Props) {
  const others = jobs.filter((j) => j.id !== activeJobId);
  if (others.length === 0) return null;
  return (
    <section className="card">
      <h2>Saved jobs</h2>
      <ul className="job-list">
        {others.map((job) => (
          <li key={job.id}>
            <div>
              <strong>{job.sourceFileName}</strong>
              <div className="muted">
                {formatDuration(job.duration)} · {job.status === 'completed' ? 'complete' : 'incomplete'} ·{' '}
                {new Date(job.updatedAt).toLocaleString()}
              </div>
            </div>
            <div className="row">
              <button type="button" onClick={() => onOpen(job.id)} disabled={busy}>
                Details
              </button>
              {job.status === 'completed' ? (
                <button type="button" onClick={() => onDownload(job.id)}>
                  Download TXT
                </button>
              ) : (
                <button type="button" onClick={() => onResume(job.id)} disabled={busy}>
                  Resume
                </button>
              )}
              <button type="button" className="danger" onClick={() => onDelete(job.id)} disabled={busy}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
