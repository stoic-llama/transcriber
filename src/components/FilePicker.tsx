import { useEffect, useRef } from 'react';
import type { SelectedFile } from '../useTranscriber';
import { formatBytes, formatDuration } from '../utils/format';

interface Props {
  selected: SelectedFile | null;
  disabled: boolean;
  reading: boolean;
  /** When set, the picker is being used to locate a specific job's file. */
  requestFor: string | null;
  onSelect: (file: File) => void;
  onCancelRequest: () => void;
}

export const ACCEPT = 'audio/*,video/*,.mp3,.mp4,.m4a,.wav,.webm,.ogg,.oga,.flac,.aac,.mov,.mkv,.opus,.wma,.aiff';

export function FilePicker({ selected, disabled, reading, requestFor, onSelect, onCancelRequest }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  // A resume needs the original file again; open the picker straight away.
  useEffect(() => {
    if (requestFor) inputRef.current?.click();
  }, [requestFor]);

  return (
    <section className="card">
      <h2>Audio / video</h2>
      {requestFor && (
        <div className="notice">
          To continue, select the original file <strong>{requestFor}</strong> again. Browsers do not let websites
          reopen files on their own.{' '}
          <button type="button" className="link" onClick={onCancelRequest}>
            Never mind
          </button>
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onSelect(file);
        }}
      />
      <button type="button" className="primary" disabled={disabled} onClick={() => inputRef.current?.click()}>
        {requestFor ? `Select “${requestFor}”` : 'Choose audio or video'}
      </button>
      {reading && <p className="hint">Reading file…</p>}
      {selected && !reading && (
        <dl className="file-info">
          <dt>File</dt>
          <dd>{selected.file.name}</dd>
          <dt>Size</dt>
          <dd>{formatBytes(selected.file.size)}</dd>
          <dt>Type</dt>
          <dd>{selected.file.type || 'unknown'}</dd>
          <dt>Duration</dt>
          <dd>{selected.nativeDuration ? `≈ ${formatDuration(selected.nativeDuration)}` : 'determined when processing starts'}</dd>
        </dl>
      )}
    </section>
  );
}
