import { useMemo } from 'react';
import { ApiKeyInput } from './components/ApiKeyInput';
import { FilePicker } from './components/FilePicker';
import { JobList } from './components/JobList';
import { JobProgress } from './components/JobProgress';
import { ModelSettings } from './components/ModelSettings';
import { PrivacyNotice } from './components/PrivacyNotice';
import { useSettings } from './settings';
import { DEFAULT_MODEL } from './transcription/models';
import { useTranscriber } from './useTranscriber';

export default function App() {
  const settings = useSettings();
  const transcriberSettings = useMemo(
    () => ({
      apiKey: settings.apiKey,
      model: settings.prefs.model || DEFAULT_MODEL,
      language: settings.prefs.language,
    }),
    [settings.apiKey, settings.prefs.model, settings.prefs.language],
  );
  const { state, actions } = useTranscriber(transcriberSettings);
  const { selected, activeJob, phase } = state;
  const busy = phase !== 'idle';
  const running = phase === 'running';
  // Derived from the live job list so it reflects progress made since selection.
  const unfinishedMatch = selected
    ? state.jobs.find((j) => j.fingerprint === selected.fingerprint && j.status !== 'completed')
    : undefined;
  const confirmDelete = (jobId: string) => {
    const job = state.jobs.find((j) => j.id === jobId);
    if (job && window.confirm(`Delete the job and saved transcript for "${job.sourceFileName}"?`)) {
      void actions.removeJob(jobId);
    }
  };
  const requestJob = state.needsFileFor ? state.jobs.find((j) => j.id === state.needsFileFor?.jobId) : undefined;

  return (
    <main>
      <header>
        <h1>Local Transcriber</h1>
        <PrivacyNotice />
      </header>

      {state.error && (
        <div className="card error" role="alert">
          <p>{state.error}</p>
          <button type="button" className="link" onClick={actions.dismissError}>
            Dismiss
          </button>
        </div>
      )}

      <ApiKeyInput
        apiKey={settings.apiKey}
        remembered={settings.remembered}
        onSave={settings.saveKey}
        onClear={settings.clearKey}
      />

      <ModelSettings
        model={settings.prefs.model}
        language={settings.prefs.language}
        disabled={busy}
        onChange={settings.updatePrefs}
      />

      <FilePicker
        selected={selected}
        disabled={busy}
        reading={phase === 'reading'}
        requestFor={requestJob?.sourceFileName ?? null}
        onSelect={(file) => void actions.selectFile(file)}
        onCancelRequest={actions.cancelFileRequest}
      />

      {selected && phase === 'idle' && (
        <section className="card">
          {unfinishedMatch ? (
            <p>
              This file matches an unfinished job below. Press <strong>Resume</strong> to continue without
              re-transcribing completed chunks, or{' '}
              <button type="button" className="link" onClick={() => void actions.startNewJob()}>
                start over as a new job
              </button>
              .
            </p>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={!settings.apiKey}
              onClick={() => void actions.startNewJob()}
            >
              {settings.apiKey ? 'Start transcription' : 'Enter your API key to start'}
            </button>
          )}
        </section>
      )}

      {phase === 'planning' && (
        <section className="card" aria-live="polite">
          <h2>Preparing audio…</h2>
          <progress max={100} value={Math.round(state.planningProgress * 100)} />
          <p>
            {Math.round(state.planningProgress * 100)}% — loading the audio engine, reading the file and finding
            natural pauses for chunk boundaries.
          </p>
          <button type="button" onClick={() => void actions.cancel('keep')}>
            Cancel
          </button>
        </section>
      )}

      {activeJob && (
        <JobProgress
          job={activeJob}
          chunks={state.activeChunks}
          running={running}
          pauseRequested={state.pauseRequested}
          currentChunkId={state.currentChunkId}
          currentActivity={state.currentActivity}
          notice={state.notice}
          stats={state.stats}
          onPause={actions.pause}
          onCancel={(mode) => void actions.cancel(mode)}
          onResume={() => void actions.resumeJob(activeJob.id)}
          onRetryChunk={(id) => void actions.resumeJob(activeJob.id, [id])}
          onDownload={() => void actions.downloadTranscript(activeJob.id)}
          onDelete={() => confirmDelete(activeJob.id)}
        />
      )}

      <JobList
        jobs={state.jobs}
        activeJobId={activeJob?.id ?? null}
        busy={busy}
        onOpen={(id) => void actions.openJob(id)}
        onResume={(id) => void actions.resumeJob(id)}
        onDelete={confirmDelete}
        onDownload={(id) => void actions.downloadTranscript(id)}
      />

      <footer className="muted">
        Static site · no backend · <a href="https://github.com/stoic-llama/transcriber">source</a>
      </footer>
    </main>
  );
}
