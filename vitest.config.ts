import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/core/**'],
    },
  },
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@panels': path.resolve(__dirname, 'src/panels'),
      '@workspace': path.resolve(__dirname, 'src/workspace'),
      '@app': path.resolve(__dirname, 'src'),
    },
  },
});
