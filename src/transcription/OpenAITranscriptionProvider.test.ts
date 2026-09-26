import { describe, expect, it, vi } from 'vitest';
import { OpenAITranscriptionProvider, OPENAI_TRANSCRIPTIONS_URL } from './OpenAITranscriptionProvider';
import { TranscriptionError } from './TranscriptionProvider';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function provider(fetchImpl: typeof fetch, timeoutMs?: number) {
  return new OpenAITranscriptionProvider({ apiKey: ' sk-test-123 ', fetch: fetchImpl, timeoutMs });
}

const audio = new Blob(['fake mp3'], { type: 'audio/mpeg' });

async function errorOf(p: Promise<unknown>): Promise<TranscriptionError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TranscriptionError);
    return e as TranscriptionError;
  }
  throw new Error('expected rejection');
}

describe('OpenAITranscriptionProvider', () => {
  it('sends a multipart request directly to OpenAI with the bearer key', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => jsonResponse(200, { text: 'hello' }));
    const result = await provider(fetchMock).transcribe(audio, {
      model: 'gpt-4o-transcribe',
      language: 'en',
      prompt: 'previous words',
      fileName: 'chunk-001.mp3',
    });
    expect(result).toEqual({ text: 'hello' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(OPENAI_TRANSCRIPTIONS_URL);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-123');
    expect(init?.credentials).toBe('omit');
    const form = init?.body as FormData;
    expect(form.get('model')).toBe('gpt-4o-transcribe');
    expect(form.get('language')).toBe('en');
    expect(form.get('prompt')).toBe('previous words');
    expect(form.get('response_format')).toBe('json');
    expect((form.get('file') as File).name).toBe('chunk-001.mp3');
  });

  it('omits the prompt for models without prompt support and asks whisper-1 for segments', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(200, { text: 'hi there', segments: [{ start: 0, end: 1.5, text: 'hi there' }] }),
    );
    await provider(fetchMock).transcribe(audio, { model: 'gpt-transcribe', prompt: 'ctx' });
    expect((fetchMock.mock.calls[0][1]?.body as FormData).has('prompt')).toBe(false);

    const result = await provider(fetchMock).transcribe(audio, { model: 'whisper-1' });
    const form = fetchMock.mock.calls[1][1]?.body as FormData;
    expect(form.get('response_format')).toBe('verbose_json');
    expect(result.segments).toEqual([{ start: 0, end: 1.5, text: 'hi there' }]);
  });

  it.each([
    [401, { error: { message: 'Incorrect API key', code: 'invalid_api_key' } }, 'auth', false, true],
    [429, { error: { message: 'quota', code: 'insufficient_quota' } }, 'quota', false, true],
    [429, { error: { message: 'slow down', code: 'rate_limit_exceeded' } }, 'rate_limit', true, false],
    [403, { error: { message: 'no access' } }, 'permission', false, true],
    [404, { error: { message: 'model not found' } }, 'permission', false, true],
    [400, { error: { message: 'Audio file is corrupt' } }, 'bad_request', false, false],
    [413, 'Payload too large', 'bad_request', false, false],
    [500, { error: { message: 'boom' } }, 'server', true, false],
    [503, '<html>unavailable</html>', 'server', true, false],
  ] as const)('maps HTTP %i to %s', async (status, body, kind, retryable, fatal) => {
    const err = await errorOf(provider(async () => jsonResponse(status, body)).transcribe(audio));
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
    expect(err.retryable).toBe(retryable);
    expect(err.fatalForJob).toBe(fatal);
    expect(err.userMessage).not.toMatch(/HTTP \d+/);
  });

  it('shows friendly messages for auth and rate limits', async () => {
    const auth = await errorOf(provider(async () => jsonResponse(401, {})).transcribe(audio));
    expect(auth.userMessage).toBe('The OpenAI API key was rejected. Check your key and try again.');
    const limited = await errorOf(
      provider(async () => jsonResponse(429, { error: { code: 'rate_limit_exceeded' } }, { 'retry-after': '7' })).transcribe(audio),
    );
    expect(limited.userMessage).toBe('OpenAI rate limit reached. The application will retry automatically.');
    expect(limited.retryAfterMs).toBe(7000);
  });

  it('never includes the API key in error messages', async () => {
    const err = await errorOf(provider(async () => jsonResponse(401, { error: { message: 'bad' } })).transcribe(audio));
    expect(err.message).not.toContain('sk-test-123');
    expect(err.userMessage).not.toContain('sk-test-123');
  });

  it('classifies network failures as retryable', async () => {
    const err = await errorOf(
      provider(async () => {
        throw new TypeError('Failed to fetch');
      }).transcribe(audio),
    );
    expect(err.kind).toBe('network');
    expect(err.retryable).toBe(true);
  });

  it('times out slow requests', async () => {
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const err = await errorOf(provider(hang, 20).transcribe(audio));
    expect(err.kind).toBe('timeout');
    expect(err.retryable).toBe(true);
  });

  it('reports caller aborts as aborted, not as a failure to retry', async () => {
    const controller = new AbortController();
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const pending = provider(hang).transcribe(audio, { signal: controller.signal });
    controller.abort();
    const err = await errorOf(pending);
    expect(err.kind).toBe('aborted');
    expect(err.retryable).toBe(false);
  });

  it('rejects malformed success responses as retryable', async () => {
    const notJson = await errorOf(provider(async () => jsonResponse(200, 'not json')).transcribe(audio));
    expect(notJson.kind).toBe('malformed');
    const noText = await errorOf(provider(async () => jsonResponse(200, { foo: 1 })).transcribe(audio));
    expect(noText.kind).toBe('malformed');
    expect(noText.retryable).toBe(true);
  });

  it('requires an API key', async () => {
    const fetchMock = vi.fn();
    const err = await errorOf(new OpenAITranscriptionProvider({ apiKey: '  ', fetch: fetchMock }).transcribe(audio));
    expect(err.kind).toBe('auth');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
