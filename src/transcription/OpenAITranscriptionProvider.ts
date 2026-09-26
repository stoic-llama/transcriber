import { REQUEST_TIMEOUT_MS } from '../config';
import type { TranscriptionOptions, TranscriptResult, TranscriptSegment } from '../types/transcription';
import { isAbortError } from '../utils/retry';
import { DEFAULT_MODEL, getModelInfo } from './models';
import { TranscriptionError, type TranscriptionProvider } from './TranscriptionProvider';

export const OPENAI_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';

export interface OpenAIProviderConfig {
  apiKey: string;
  endpoint?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Calls OpenAI's Audio Transcriptions endpoint directly from the browser.
 * The API allows cross-origin requests with an Authorization header, so no
 * proxy is involved: audio and key go only to api.openai.com.
 */
export class OpenAITranscriptionProvider implements TranscriptionProvider {
  readonly id = 'openai';
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenAIProviderConfig) {
    this.apiKey = config.apiKey.trim();
    this.endpoint = config.endpoint ?? OPENAI_TRANSCRIPTIONS_URL;
    this.timeoutMs = config.timeoutMs ?? REQUEST_TIMEOUT_MS;
    // Bind so a bare global fetch isn't called with the wrong `this`.
    this.fetchImpl = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async transcribe(audio: Blob, options: TranscriptionOptions = {}): Promise<TranscriptResult> {
    if (!this.apiKey) {
      throw new TranscriptionError('auth', 'Enter your OpenAI API key to start transcribing.');
    }
    const model = options.model || DEFAULT_MODEL;
    const info = getModelInfo(model);
    const responseFormat = info.supportsSegments ? 'verbose_json' : 'json';

    const form = new FormData();
    form.append('file', audio, options.fileName ?? 'audio.mp3');
    form.append('model', model);
    form.append('response_format', responseFormat);
    if (info.supportsSegments) form.append('timestamp_granularities[]', 'segment');
    if (options.language) form.append('language', options.language);
    if (options.prompt && info.supportsPrompt) form.append('prompt', options.prompt);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onOuterAbort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener('abort', onOuterAbort, { once: true });

    let response: Response;
    let bodyText: string;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: controller.signal,
        // Never send cookies/referrer to a third party.
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      bodyText = await response.text();
    } catch (error) {
      if (timedOut) {
        throw new TranscriptionError('timeout', 'OpenAI took too long to respond. Retrying…', { cause: error });
      }
      if (options.signal?.aborted || isAbortError(error)) {
        throw new TranscriptionError('aborted', 'Transcription was stopped.', { cause: error });
      }
      throw new TranscriptionError(
        'network',
        'Could not reach OpenAI. Check your internet connection. Retrying…',
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onOuterAbort);
    }

    if (!response.ok) throw errorFromResponse(response, bodyText);
    return parseTranscriptBody(bodyText, responseFormat);
  }
}

interface OpenAIErrorBody {
  error?: { message?: string; type?: string; code?: string | null };
}

function parseRetryAfter(headers: Headers): number | undefined {
  const ms = headers.get('retry-after-ms');
  if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Maps an OpenAI HTTP error to a TranscriptionError with a readable message. */
export function errorFromResponse(response: Response, bodyText: string): TranscriptionError {
  let body: OpenAIErrorBody = {};
  try {
    body = JSON.parse(bodyText) as OpenAIErrorBody;
  } catch {
    // Non-JSON error body (e.g. a gateway HTML page); fall back to status only.
  }
  const apiMessage = body.error?.message?.slice(0, 300);
  const code = body.error?.code ?? body.error?.type ?? undefined;
  const status = response.status;
  const detail = [`HTTP ${status}`, code, apiMessage].filter(Boolean).join(' — ');
  const common = { status, detail };

  if (status === 401) {
    return new TranscriptionError('auth', 'The OpenAI API key was rejected. Check your key and try again.', common);
  }
  if (status === 429 && (code === 'insufficient_quota' || code === 'billing_hard_limit_reached')) {
    return new TranscriptionError(
      'quota',
      'Your OpenAI account has run out of credits or hit its spending limit. Check billing on platform.openai.com.',
      common,
    );
  }
  if (status === 429) {
    return new TranscriptionError('rate_limit', 'OpenAI rate limit reached. The application will retry automatically.', {
      ...common,
      retryAfterMs: parseRetryAfter(response.headers),
    });
  }
  if (status === 403 || status === 404) {
    return new TranscriptionError(
      'permission',
      `Your API key cannot use this transcription model or endpoint.${apiMessage ? ` OpenAI says: ${apiMessage}` : ''}`,
      common,
    );
  }
  if (status === 408 || status === 409) {
    return new TranscriptionError('timeout', 'OpenAI timed out processing this chunk. Retrying…', common);
  }
  if (status >= 500) {
    return new TranscriptionError('server', 'OpenAI is having problems right now. Retrying…', {
      ...common,
      retryAfterMs: parseRetryAfter(response.headers),
    });
  }
  if (status === 413) {
    return new TranscriptionError('bad_request', 'This audio chunk is larger than OpenAI accepts.', common);
  }
  return new TranscriptionError(
    'bad_request',
    `OpenAI could not transcribe this chunk.${apiMessage ? ` OpenAI says: ${apiMessage}` : ''}`,
    common,
  );
}

interface VerboseSegment {
  start?: unknown;
  end?: unknown;
  text?: unknown;
}

export function parseTranscriptBody(bodyText: string, responseFormat: string): TranscriptResult {
  let data: unknown;
  try {
    data = JSON.parse(bodyText);
  } catch (error) {
    throw new TranscriptionError('malformed', 'OpenAI returned an unreadable response. Retrying…', {
      detail: 'invalid JSON',
      cause: error,
    });
  }
  if (typeof data !== 'object' || data === null || typeof (data as { text?: unknown }).text !== 'string') {
    throw new TranscriptionError('malformed', 'OpenAI returned an unexpected response. Retrying…', {
      detail: 'missing "text"',
    });
  }
  const obj = data as { text: string; language?: unknown; segments?: unknown };
  const result: TranscriptResult = { text: obj.text };
  if (typeof obj.language === 'string') result.language = obj.language;
  if (responseFormat === 'verbose_json' && Array.isArray(obj.segments)) {
    result.segments = (obj.segments as VerboseSegment[])
      .filter((s) => typeof s.start === 'number' && typeof s.end === 'number' && typeof s.text === 'string')
      .map((s): TranscriptSegment => ({ start: s.start as number, end: s.end as number, text: s.text as string }));
  }
  return result;
}
