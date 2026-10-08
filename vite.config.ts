import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react()],
  server: { headers: isolationHeaders, proxy: { '/api': 'http://127.0.0.1:3001' } },
  preview: { headers: isolationHeaders, proxy: { '/api': 'http://127.0.0.1:3001' } },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'server/**/*.test.ts'] },
} as import('vitest/config').UserConfig);
