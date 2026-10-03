import { describe, expect, it } from 'vitest';
import type { Bin } from './exec.ts';
import { run, runConfigured } from './exec.ts';

describe('run', () => {
  it('refuses binaries outside the allowlist', async () => {
    expect(await run('rm' as Bin, ['-rf', '/'])).toMatchObject({ code: null, stderr: '허용되지 않은 명령: rm' });
  });
});

describe('runConfigured', () => {
  const cwd = process.cwd();

  it('keeps stdout and stderr separate and reports the exit code', async () => {
    expect(await runConfigured('echo out; echo err >&2; exit 3', cwd, 5000)).toEqual({ code: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false });
  });

  it('kills the whole process group on timeout', async () => {
    const started = Date.now();
    const r = await runConfigured('sleep 30 & sleep 30', cwd, 200);
    expect(r).toMatchObject({ code: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('does not spawn when the working directory is missing', async () => {
    expect(await runConfigured('echo hi', '/definitely/not/here', 1000)).toMatchObject({ code: null, stdout: '' });
  });
});
