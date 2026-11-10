import { defineConfig } from 'vite';

// Relative base so the same build works on GitHub Pages (/illuminate/) and locally.
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 4173 },
});
