import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'web',
  define: { __APP_VERSION__: JSON.stringify((JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version) },
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  test: { root: '.', include: ['server/**/*.test.ts', 'web/src/**/*.test.{ts,tsx}'] },
});
