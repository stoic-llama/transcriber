// Copies the ffmpeg.wasm core into public/ffmpeg so the site can self-host it
// instead of loading it from a CDN. Build with VITE_FFMPEG_CORE_BASE_URL=./ffmpeg.
//
// Note: ffmpeg-core.wasm is ~32 MB. GitHub Pages accepts it; Cloudflare Pages
// has a 25 MiB per-file limit, so keep the CDN default there.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const coreDir = join(process.cwd(), 'node_modules', '@ffmpeg', 'core', 'dist', 'esm');
if (!existsSync(coreDir)) {
  console.error('@ffmpeg/core is not installed. Run `npm install` first.');
  process.exit(1);
}
const outDir = join(process.cwd(), 'public', 'ffmpeg');
mkdirSync(outDir, { recursive: true });
for (const name of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  copyFileSync(join(coreDir, name), join(outDir, name));
  console.log(`copied ${name} -> public/ffmpeg/`);
}
