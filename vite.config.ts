import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/** 화면 오른쪽 위 버전: 마지막 릴리즈 태그(v0.9.0 → 0.9.0). 태그를 못 읽으면(zip 으로 받음 등) package.json */
function appVersion(): string {
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], {
      cwd: new URL('.', import.meta.url),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return tag.trim().slice(1);
  } catch {
    return (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;
  }
}

export default defineConfig({
  root: 'web',
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  test: { root: '.', include: ['server/**/*.test.ts', 'scripts/**/*.test.ts', 'web/src/**/*.test.{ts,tsx}'] },
});
