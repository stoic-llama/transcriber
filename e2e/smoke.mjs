/* global indexedDB -- used inside page.evaluate callbacks, which run in the browser */
// End-to-end smoke test of the *static build* in a real Chromium:
//   - serves dist/ under a sub-path (/transcriber/) like GitHub Pages
//   - real ffmpeg.wasm decodes/chunks a generated ~21-minute WAV recording
//   - api.openai.com is intercepted (no real API calls, no key needed)
//   - reloads the page after the first chunk and verifies resume skips it
//   - downloads the transcript and checks chunk order
//
// Usage: npm run vendor:ffmpeg && VITE_FFMPEG_CORE_BASE_URL=./ffmpeg npm run build && npm run e2e
// Set CHROMIUM_PATH if Chromium is not at /opt/pw-browsers/chromium.
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'e2e-output');
const BASE = '/transcriber/';
mkdirSync(OUT, { recursive: true });

function assert(cond, message) {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}

// ---------- test media: 16 kHz mono WAV, tone bursts separated by pauses ----------
function makeWav(path, seconds) {
  const rate = 16000;
  const samples = rate * seconds;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const inPause = t % 7 >= 6; // 6 s "speech", 1 s pause
    const v = inPause ? 0 : Math.sin(2 * Math.PI * 220 * t) * 0.3 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}
// E2E_SECONDS=7380 exercises a full ~2-hour recording (≈236 MB WAV).
// E2E_MEDIA=path/to/file.mp4 uses an existing file instead of the generated WAV.
const SECONDS = Number(process.env.E2E_SECONDS ?? 21 * 60 + 13);
const media = process.env.E2E_MEDIA
  ? resolve(process.env.E2E_MEDIA)
  : join(OUT, `Lecture Recording ${SECONDS}s.wav`);
if (!existsSync(media)) makeWav(media, SECONDS);
const baseName = basename(media).replace(/\.[^.]+$/, '');
const checkPauses = !process.env.E2E_MEDIA || process.env.E2E_CHECK_PAUSES === '1';

// ---------- static server under a sub-path ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith(BASE)) {
    res.writeHead(404).end();
    return;
  }
  let file = normalize(join(DIST, url.pathname.slice(BASE.length) || 'index.html'));
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---------- browser ----------
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(180_000);
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

const foreignRequests = [];
const apiCalls = [];
let failNext = ['429', '500']; // first two API calls fail transiently to exercise retries

await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.origin === origin || url.protocol === 'blob:' || url.protocol === 'data:') return route.continue();
  if (url.href === 'https://api.openai.com/v1/audio/transcriptions') {
    const req = route.request();
    const body = req.postDataBuffer() ?? Buffer.alloc(0);
    const text = body.toString('latin1');
    const auth = req.headers()['authorization'];
    const model = /name="model"\r\n\r\n([^\r]+)/.exec(text)?.[1];
    const fileName = /name="file"; filename="([^"]+)"/.exec(text)?.[1];
    const isMp3 = /Content-Type: audio\/mpeg/.test(text);
    apiCalls.push({ auth, model, fileName, bytes: body.length, isMp3 });
    const cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
    const fail = failNext.shift();
    if (fail === '429') {
      return route.fulfill({ status: 429, headers: { ...cors, 'retry-after': '1' }, body: JSON.stringify({ error: { message: 'Rate limit', code: 'rate_limit_exceeded' } }) });
    }
    if (fail === '500') {
      return route.fulfill({ status: 500, headers: cors, body: JSON.stringify({ error: { message: 'boom' } }) });
    }
    const n = Number(/chunk-(\d+)/.exec(fileName ?? '')?.[1]);
    await new Promise((r) => setTimeout(r, 300));
    return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ text: `Transcript of chunk ${n}.` }) });
  }
  foreignRequests.push(url.href);
  return route.abort();
});

async function enterKey() {
  await page.getByLabel('OpenAI API key').fill('sk-e2e-test-key-000');
  await page.getByRole('button', { name: 'Save key' }).click();
}

const t0 = Date.now();
await page.goto(`${origin}${BASE}`);
await page.getByRole('heading', { name: 'Local Transcriber' }).waitFor();
await enterKey();
assert((await page.textContent('body')).includes('sk-'), 'masked key shown');
assert(!(await page.textContent('body')).includes('sk-e2e-test-key-000'), 'full key never displayed');

await page.locator('input[type=file]').setInputFiles(media);
await page.getByText(basename(media)).first().waitFor();
await page.getByRole('button', { name: 'Start transcription' }).click();
await page.getByText('Preparing audio…').waitFor();
await page.getByText(/[1-9]\d* \/ \d+ chunks complete/).waitFor();
const TOTAL = Number(/\/ (\d+) chunks complete/.exec(await page.textContent('body'))[1]);
console.log(`planned ${TOTAL} chunks`);
console.log(`first chunk done after ${((Date.now() - t0) / 1000).toFixed(1)}s; API calls so far: ${apiCalls.length}`);
await page.screenshot({ path: join(OUT, '1-running.png'), fullPage: true });

// ---- simulate closing/refreshing the tab mid-job ----
const callsBeforeReload = apiCalls.length;
await page.reload();
await page.getByText('Incomplete transcription found').waitFor();
const afterReloadText = await page.textContent('body');
const doneMatch = /(\d+) \/ (\d+) chunks complete/.exec(afterReloadText);
assert(doneMatch && Number(doneMatch[1]) >= 1, 'completed chunks survived reload');
assert(!afterReloadText.includes('sk-'), 'in-memory key is forgotten on reload');
await page.screenshot({ path: join(OUT, '2-after-reload.png'), fullPage: true });
const completedBeforeResume = Number(doneMatch[1]);

await enterKey();
const chooser = page.waitForEvent('filechooser');
await page.getByRole('button', { name: 'Resume' }).first().click();
await (await chooser).setFiles(media);
await page.getByText('Transcription complete').waitFor();
await page.screenshot({ path: join(OUT, '3-complete.png'), fullPage: true });

const successfulAfterReload = apiCalls.slice(callsBeforeReload).map((c) => c.fileName);
console.log('API calls after reload:', successfulAfterReload);
for (let i = 1; i <= completedBeforeResume; i++) {
  const name = `chunk-${String(i).padStart(3, '0')}.mp3`;
  assert(!successfulAfterReload.includes(name), `completed chunk ${i} was not re-transcribed`);
}

const downloadPromise = page.waitForEvent('download');
await page.getByRole('button', { name: /Download TXT/ }).first().click();
const download = await downloadPromise;
const txtPath = join(OUT, download.suggestedFilename());
await download.saveAs(txtPath);
const transcript = readFileSync(txtPath, 'utf8');
console.log(`downloaded ${download.suggestedFilename()} (${transcript.length} chars)`);
assert(download.suggestedFilename() === `${baseName}.txt`, 'output filename derived from source');
const expected = Array.from({ length: TOTAL }, (_, i) => `Transcript of chunk ${i + 1}.`).join('\n\n') + '\n';
assert(transcript === expected, 'transcript in chronological order');

assert(apiCalls.every((c) => c.auth === 'Bearer sk-e2e-test-key-000'), 'key sent only as bearer to OpenAI');
assert(apiCalls.every((c) => c.model === 'gpt-transcribe' && c.isMp3), 'model + mp3 upload');
assert(apiCalls.every((c) => c.bytes < 25 * 1024 * 1024), 'chunks under upload limit');
assert(foreignRequests.length === 0, `no requests to other origins: ${foreignRequests.join(', ')}`);
console.log('upload sizes (bytes):', apiCalls.map((c) => c.bytes).join(', '));

// ---- chunk boundaries were moved to pauses (test audio pauses at t mod 7 in [6, 7)) ----
const plan = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const open = indexedDB.open('local-transcriber');
      open.onsuccess = () => {
        const req = open.result.transaction('chunks').objectStore('chunks').getAll();
        req.onsuccess = () => resolve(req.result.map((c) => [c.startTime, c.endTime]));
      };
    }),
);
console.log('chunk plan (s):', JSON.stringify(plan));
for (const [, end] of checkPauses ? plan.slice(0, -1) : []) {
  assert(end % 7 >= 6 && end % 7 <= 7, `boundary ${end} falls inside a pause`);
}

// ---- deleting the job removes it from IndexedDB ----
page.once('dialog', (d) => d.accept());
await page.getByRole('button', { name: 'Delete job' }).click();
await page.getByText('Transcription complete').waitFor({ state: 'detached' });
const remaining = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const open = indexedDB.open('local-transcriber');
      open.onsuccess = () => {
        const tx = open.result.transaction(['jobs', 'chunks']);
        const jobs = tx.objectStore('jobs').count();
        const chunks = tx.objectStore('chunks').count();
        tx.oncomplete = () => resolve({ jobs: jobs.result, chunks: chunks.result });
      };
    }),
);
assert(remaining.jobs === 0 && remaining.chunks === 0, `IndexedDB cleaned up: ${JSON.stringify(remaining)}`);

console.log(`\nE2E PASSED in ${((Date.now() - t0) / 1000).toFixed(1)}s (${apiCalls.length} API calls incl. 2 injected failures)`);
await browser.close();
server.close();
