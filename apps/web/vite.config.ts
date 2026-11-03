/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3100';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  optimizeDeps: {
    // `zod` is reached through the linked workspace package @insightai/contracts, which Vite does
    // not scan up front. Without this it is discovered at runtime, Vite re-optimizes mid-session
    // and the page briefly loads two React copies ("Invalid hook call").
    include: ['zod', 'react-hook-form', '@hookform/resolvers/zod'],
  },
  server: {
    port: 5173,
    // Same-origin in development: the browser never needs CORS or the API host.
    proxy: {
      '/api': apiTarget,
      '/health': apiTarget,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
