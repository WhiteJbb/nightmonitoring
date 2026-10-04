import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, guard } from './app.ts';
import { parseConfig } from './config.ts';
import { demoCollector } from './demo.ts';
import { Monitor } from './monitor.ts';
import { Runner } from './runner.ts';

const config = parseConfig({ projects: [{ name: 'app', repoPath: '/repo/app', testCommand: 'npm test' }] }, '/base');
const exec = vi.fn(async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }));
const runner = new Runner({ timeoutSec: 1, logDir: null, exec });
const monitor = new Monitor({ config, collector: demoCollector(), runs: runner.get });
const server = createApp({ config, monitor, runner, reportsDir: () => '/nonexistent/reports' }).listen(0, '127.0.0.1');
let base = '';

beforeAll(async () => {
  await monitor.tick();
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => void server.close());

describe('API', () => {
  it('serves the snapshot', async () => {
    const s = await (await fetch(`${base}/api/snapshot`)).json();
    expect(s.projects).toHaveLength(1);
  });

  it('runs only registered commands and ignores the request body', async () => {
    const post = (p: string, init: RequestInit = {}) => fetch(`${base}/api/projects/${p}`, { method: 'POST', ...init });
    expect((await post('nope/run/test')).status).toBe(404);
    expect((await post('app/run/deploy')).status).toBe(400);
    expect((await post('app/run/build')).status).toBe(400); // 등록된 build 명령 없음
    const res = await post('app/run/test', { body: JSON.stringify({ command: 'rm -rf /' }), headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(202);
    expect(exec).toHaveBeenCalledExactlyOnceWith('npm test', '/repo/app', 1000, expect.any(AbortSignal));
    expect((await fetch(`${base}/api/projects/app/run/build`, { method: 'DELETE' })).status).toBe(409);
    expect((await fetch(`${base}/api/projects/app/run/deploy`, { method: 'DELETE' })).status).toBe(400);
  });

  it('rejects cross-origin writes but allows same-origin', async () => {
    const cross = await fetch(`${base}/api/projects/app/run/test`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
    expect(cross.status).toBe(403);
    const same = await fetch(`${base}/api/reports/x`, { headers: { Origin: base } });
    expect(same.status).toBe(404);
  });

  it('rejects non-loopback Host headers, also when bound to ::1', () => {
    for (const host of ['127.0.0.1', '::1']) {
      const status = vi.fn(() => ({ json: vi.fn() }));
      const next = vi.fn();
      const g = guard({ host }) as unknown as (req: object, res: object, next: () => void) => void;
      g({ method: 'GET', headers: { host: 'evil.example:4477' } }, { status }, next);
      expect(status).toHaveBeenCalledWith(403);
      g({ method: 'GET', headers: { host: 'localhost:4477' } }, { status }, next);
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it('returns JSON 404 for unknown reports and routes', async () => {
    expect((await fetch(`${base}/api/reports/..%2F..%2Fpackage.json`)).status).toBe(404);
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    expect(await (await fetch(`${base}/api/reports`)).json()).toEqual([]);
  });
});
