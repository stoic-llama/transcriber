import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FfmpegAudioSource } from './media/audioExtractor';
import { MediaError } from './media/MediaError';
import { probeNativeDuration } from './media/mediaInfo';
import { getChunks } from './storage/chunks';
import { deleteJob, findJobsByFingerprint, getJob, listJobs, recoverInterruptedJobs } from './storage/jobs';
import { createJob } from './transcription/jobFactory';
import { OpenAITranscriptionProvider } from './transcription/OpenAITranscriptionProvider';
import { assembleTranscriptText } from './transcription/transcript';
import { describeError, TranscriptionQueue, type QueueEvent } from './transcription/transcriptionQueue';
import type { Chunk, TranscriptionJob } from './types/jobs';
import { fingerprintFile } from './utils/fileHash';
import { transcriptFileName } from './utils/format';

export interface SelectedFile {
  file: File;
  fingerprint: string;
  nativeDuration?: number;
  /** Existing jobs created from the same file (by fingerprint). */
  matches: TranscriptionJob[];
}

export type Phase = 'idle' | 'reading' | 'planning' | 'running';

export interface RunStats {
  /** Wall-clock start of the current run. */
  startedAt: number;
  /** Audio seconds transcribed during this run (for the ETA). */
  audioSecondsDone: number;
}

export interface TranscriberState {
  jobs: TranscriptionJob[];
  activeJob: TranscriptionJob | null;
  activeChunks: Chunk[];
  selected: SelectedFile | null;
  phase: Phase;
  planningProgress: number;
  currentChunkId: number | null;
  currentActivity: 'extracting' | 'transcribing' | null;
  notice: string | null;
  error: string | null;
  stats: RunStats | null;
  pauseRequested: boolean;
  /** Set when an action needs the user to (re)select the job's source file. */
  needsFileFor: { jobId: string; chunkIds?: number[] } | null;
}

export interface Settings {
  apiKey: string;
  model: string;
  language: string;
}

function downloadText(text: string, fileName: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Keeps the screen awake during long runs where supported; best effort. */
async function requestWakeLock(): Promise<{ release(): Promise<void> } | null> {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
    return (await nav.wakeLock?.request('screen')) ?? null;
  } catch {
    return null;
  }
}

export function useTranscriber(settings: Settings) {
  const [jobs, setJobs] = useState<TranscriptionJob[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeChunks, setActiveChunks] = useState<Chunk[]>([]);
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [planningProgress, setPlanningProgress] = useState(0);
  const [currentChunkId, setCurrentChunkId] = useState<number | null>(null);
  const [currentActivity, setCurrentActivity] = useState<'extracting' | 'transcribing' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<RunStats | null>(null);
  const [pauseRequested, setPauseRequested] = useState(false);
  const [needsFileFor, setNeedsFileFor] = useState<TranscriberState['needsFileFor']>(null);

  const sourceRef = useRef<{ fingerprint: string; source: FfmpegAudioSource } | null>(null);
  const queueRef = useRef<TranscriptionQueue | null>(null);
  const planAbortRef = useRef<AbortController | null>(null);
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const refreshJobs = useCallback(async () => {
    setJobs(await listJobs());
  }, []);

  // Startup: repair state left by a crash/refresh, then list jobs.
  useEffect(() => {
    void (async () => {
      try {
        await recoverInterruptedJobs();
        const all = await listJobs();
        setJobs(all);
        const unfinished = all.find((j) => j.status !== 'completed');
        if (unfinished) {
          setActiveJobId(unfinished.id);
          setActiveChunks(await getChunks(unfinished.id));
        }
      } catch (e) {
        setError(`Could not open local storage (IndexedDB): ${describeError(e)}`);
      }
    })();
  }, []);

  // Warn before closing the tab mid-run (progress is saved either way).
  useEffect(() => {
    if (phase !== 'running' && phase !== 'planning') return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [phase]);

  const openJob = useCallback(async (jobId: string) => {
    setActiveJobId(jobId);
    setActiveChunks(await getChunks(jobId));
  }, []);

  const sourceFor = useCallback((sel: SelectedFile): FfmpegAudioSource => {
    if (sourceRef.current?.fingerprint !== sel.fingerprint) {
      void sourceRef.current?.source.dispose();
      sourceRef.current = { fingerprint: sel.fingerprint, source: new FfmpegAudioSource(sel.file) };
    }
    return sourceRef.current.source;
  }, []);

  const runQueue = useCallback(
    async (jobId: string, sel: SelectedFile, chunkIds?: number[]) => {
      const { apiKey } = settingsRef.current;
      if (!apiKey) {
        setError('Enter your OpenAI API key first.');
        return;
      }
      setError(null);
      setNotice(null);
      setPauseRequested(false);
      await openJob(jobId);
      setPhase('running');
      setStats({ startedAt: Date.now(), audioSecondsDone: 0 });

      const queue = new TranscriptionQueue(
        jobId,
        { provider: new OpenAITranscriptionProvider({ apiKey }), source: sourceFor(sel) },
        (event: QueueEvent) => {
          switch (event.type) {
            case 'chunk':
              setActiveChunks((prev) => prev.map((c) => (c.id === event.chunk.id ? event.chunk : c)));
              if (event.chunk.status === 'completed') {
                setNotice(null);
                setStats((s) =>
                  s ? { ...s, audioSecondsDone: s.audioSecondsDone + (event.chunk.endTime - event.chunk.startTime) } : s,
                );
              }
              break;
            case 'job':
              setJobs((prev) => prev.map((j) => (j.id === event.job.id ? event.job : j)));
              break;
            case 'activity':
              setCurrentChunkId(event.chunkId);
              setCurrentActivity(event.activity);
              break;
            case 'retrying':
              setNotice(`Chunk ${event.chunkId + 1}: ${event.message} (retry in ${Math.ceil(event.delayMs / 1000)}s)`);
              break;
          }
        },
      );
      queueRef.current = queue;
      const wakeLock = await requestWakeLock();
      try {
        const outcome = await queue.run({ onlyChunkIds: chunkIds });
        const job = await getJob(jobId);
        if (outcome === 'stopped' && job?.error) setError(job.error);
      } catch (e) {
        setError(describeError(e));
      } finally {
        void wakeLock?.release().catch(() => undefined);
        queueRef.current = null;
        setPhase('idle');
        setCurrentChunkId(null);
        setCurrentActivity(null);
        setPauseRequested(false);
        setStats(null);
        await refreshJobs();
        if (await getJob(jobId)) setActiveChunks(await getChunks(jobId));
      }
    },
    [openJob, refreshJobs, sourceFor],
  );

  const selectFile = useCallback(
    async (file: File) => {
      setError(null);
      setPhase('reading');
      try {
        const [fingerprint, nativeDuration] = await Promise.all([fingerprintFile(file), probeNativeDuration(file)]);
        const matches = await findJobsByFingerprint(fingerprint);
        const sel: SelectedFile = { file, fingerprint, nativeDuration, matches };
        setSelected(sel);
        setPhase('idle');

        // The user was asked to pick the file for a specific job.
        if (needsFileFor) {
          const target = needsFileFor;
          setNeedsFileFor(null);
          const job = await getJob(target.jobId);
          if (job && job.fingerprint !== fingerprint) {
            setError(
              `That file does not match "${job.sourceFileName}" (${job.sourceFileSize.toLocaleString()} bytes). Select the original file to resume.`,
            );
            return;
          }
          if (job) await runQueue(job.id, sel, target.chunkIds);
          return;
        }
        const unfinished = matches.find((j) => j.status !== 'completed');
        if (unfinished) await openJob(unfinished.id);
      } catch (e) {
        setPhase('idle');
        setError(describeError(e));
      }
    },
    [needsFileFor, openJob, runQueue],
  );

  const startNewJob = useCallback(async () => {
    if (!selected) return;
    const { apiKey, model, language } = settingsRef.current;
    if (!apiKey) {
      setError('Enter your OpenAI API key first.');
      return;
    }
    setError(null);
    setPhase('planning');
    setPlanningProgress(0);
    const abort = new AbortController();
    planAbortRef.current = abort;
    try {
      const { job } = await createJob(sourceFor(selected), {
        file: selected.file,
        fingerprint: selected.fingerprint,
        model,
        language: language.trim() || undefined,
        nativeDuration: selected.nativeDuration,
        onProgress: setPlanningProgress,
        signal: abort.signal,
      });
      await refreshJobs();
      setSelected({ ...selected, matches: [...selected.matches, job] });
      await runQueue(job.id, selected);
    } catch (e) {
      setPhase('idle');
      if (!abort.signal.aborted) setError(e instanceof MediaError ? e.userMessage : describeError(e));
    } finally {
      planAbortRef.current = null;
    }
  }, [selected, sourceFor, refreshJobs, runQueue]);

  /** Resume a job, or retry specific chunks; asks for the file if needed. */
  const resumeJob = useCallback(
    async (jobId: string, chunkIds?: number[]) => {
      if (!settingsRef.current.apiKey) {
        setError('Enter your OpenAI API key first.');
        return;
      }
      const job = await getJob(jobId);
      if (!job) return;
      await openJob(jobId);
      if (selected && selected.fingerprint === job.fingerprint) {
        await runQueue(jobId, selected, chunkIds);
      } else {
        // Browsers don't let a page reopen a file by itself after a reload.
        setNeedsFileFor({ jobId, chunkIds });
      }
    },
    [selected, openJob, runQueue],
  );

  const pause = useCallback(() => {
    queueRef.current?.pause();
    setPauseRequested(true);
  }, []);

  const cancel = useCallback(
    async (mode: 'keep' | 'delete') => {
      planAbortRef.current?.abort();
      const queue = queueRef.current;
      const jobId = activeJobId;
      queue?.cancel();
      // Wait for the queue to settle so it doesn't write after deletion.
      while (queueRef.current) await new Promise((r) => setTimeout(r, 50));
      if (mode === 'delete' && jobId && queue) {
        await deleteJob(jobId);
        setActiveJobId(null);
        setActiveChunks([]);
        await refreshJobs();
      }
    },
    [activeJobId, refreshJobs],
  );

  const removeJob = useCallback(
    async (jobId: string) => {
      if (queueRef.current && activeJobId === jobId) return;
      await deleteJob(jobId);
      if (activeJobId === jobId) {
        setActiveJobId(null);
        setActiveChunks([]);
      }
      setSelected((s) => (s ? { ...s, matches: s.matches.filter((j) => j.id !== jobId) } : s));
      await refreshJobs();
    },
    [activeJobId, refreshJobs],
  );

  const downloadTranscript = useCallback(async (jobId: string) => {
    const job = await getJob(jobId);
    if (!job) return;
    const chunks = await getChunks(jobId);
    downloadText(assembleTranscriptText(chunks), transcriptFileName(job.sourceFileName));
  }, []);

  const activeJob = useMemo(() => jobs.find((j) => j.id === activeJobId) ?? null, [jobs, activeJobId]);

  const state: TranscriberState = {
    jobs,
    activeJob,
    activeChunks,
    selected,
    phase,
    planningProgress,
    currentChunkId,
    currentActivity,
    notice,
    error,
    stats,
    pauseRequested,
    needsFileFor,
  };

  return {
    state,
    actions: {
      selectFile,
      startNewJob,
      resumeJob,
      pause,
      cancel,
      removeJob,
      openJob,
      downloadTranscript,
      dismissError: () => setError(null),
      cancelFileRequest: () => setNeedsFileFor(null),
    },
  };
}
