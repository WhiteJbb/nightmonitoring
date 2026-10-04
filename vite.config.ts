import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  test: { root: '.', include: ['server/**/*.test.ts', 'web/src/**/*.test.{ts,tsx}'] },
});
