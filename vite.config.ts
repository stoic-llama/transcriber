/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset URLs so the same build works at "/" (Cloudflare Pages)
  // and under a sub-path such as "/project/" (GitHub Pages).
  base: './',
  plugins: [react()],
  // ffmpeg.wasm spawns its own module worker via `new URL(..., import.meta.url)`;
  // pre-bundling breaks that URL, so leave these packages alone.
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  worker: {
    format: 'es',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
  },
});
