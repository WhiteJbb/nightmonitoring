import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GitInfo } from '../shared/types.ts';
import { parseConfig } from './config.ts';
import { scanLog } from './logs.ts';
import type { Collector } from './monitor.ts';
import { Monitor, NO_LOG } from './monitor.ts';
import { loadState, saveState } from './state.ts';
import type { PersistedState } from './state.ts';

let dir = '';
beforeAll(async () => void (dir = await mkdtemp(path.join(tmpdir(), 'nightshift-state-'))));
afterAll(() => rm(dir, { recursive: true }));

const T0 = Date.parse('2026-10-04T03:00:00Z');
const noRuns = () => ({ test: null, build: null });
const gitInfo = (head: string): GitInfo => ({ ok: true, branch: 'main', head, clean: true, changedFiles: [], diffStat: [], additions: 0, deletions: 0, recentCommits: [], todayCommits: [], fingerprint: head });

describe('state file', () => {
  it('round-trips and replaces the file atomically', async () => {
    const file = path.join(dir, 'nested/state.json');
    const state: PersistedState = { version: 2, monitor: { startedAt: 'x', tracked: {} }, runner: { results: {}, history: {} }, lastAutoReportDate: '2026-10-04' };
    saveState(file, state);
    saveState(file, state);
    expect(loadState(file)).toEqual(state);
    await expect(readFile(`${file}.tmp`)).rejects.toThrow();
  });

  it('starts fresh on a missing, corrupt or unknown file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadState(path.join(dir, 'nope.json'))).toBeNull();
    const bad = path.join(dir, 'bad.json');
    await writeFile(bad, '{"version": 1, "monitor"');
    expect(loadState(bad)).toBeNull();
    await writeFile(bad, '{"version": 99}');
    expect(loadState(bad)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('scanLog positions', () => {
  it('skips existing content, reports new errors, and survives rotation', async () => {
    const file = path.join(dir, 'agent.log');
    await writeFile(file, 'old Error: from yesterday\n');
    const first = await scanLog(file, ['error'], [], null);
    expect(first.errors).toEqual([]);
    expect(first.end.offset).toBe(26);

    await appendFile(file, 'fine\nError: new failure\nFound 0 errors\n');
    const second = await scanLog(file, ['error'], ['0 errors'], first.end);
    expect(second.errors).toEqual(['Error: new failure']);
    expect((await scanLog(file, ['error'], [], second.end)).errors).toEqual([]);

    // 더 큰 새 파일로 교체돼도(inode 변경) 처음부터 다시 읽는다
    await rm(file);
    await writeFile(path.join(dir, 'other.log'), 'x'); // 같은 inode 재사용 방지
    await writeFile(file, `error after rotate\n${'filler line\n'.repeat(20)}`);
    const rotated = await scanLog(file, ['error'], [], second.end);
    expect(rotated.end.offset).toBeGreaterThan(second.end.offset);
    expect(rotated.errors).toEqual(['error after rotate']);

    // 같은 파일이 잘려도(truncate) 처음부터
    await writeFile(file, 'error after truncate\n');
    expect((await scanLog(file, ['error'], [], rotated.end)).errors).toEqual(['error after truncate']);
  });

  it('returns nothing for missing files and non-regular files', async () => {
    expect(await scanLog(path.join(dir, 'missing.log'), ['error'], [], { offset: 0, ino: 1 })).toEqual(NO_LOG);
    expect(await scanLog(dir, ['error'], [], { offset: 0, ino: 1 })).toEqual(NO_LOG);
  });
});

describe('Monitor session state', () => {
  const config = parseConfig({ projects: [{ name: 'app', repoPath: '/repo/app', logFile: 'a.log' }] }, '/base');
  type FakeLog = { errors: string[]; size: number };
  function collector(state: { head: string; log: FakeLog; gate?: Promise<void> }): Collector {
    return {
      git: async () => gitInfo(state.head),
      since: async (_p, baseline) => ({ baseline, commits: [], files: [], additions: 0, deletions: 0 }),
      tmux: async () => new Map(),
      logErrors: async (_p, pos) => {
        const log = state.log;
        await state.gate;
        return { errors: pos === null || pos.offset >= log.size ? [] : log.errors, end: { offset: log.size, ino: 1 } };
      },
    };
  }

  it('restores the baseline across restarts, unless the repo path changed', async () => {
    let now = T0;
    const state = { head: 'h1', log: { errors: [], size: 0 } };
    const first = new Monitor({ config, collector: collector(state), runs: noRuns, now: () => now });
    await first.tick();
    const saved = JSON.parse(JSON.stringify(first.exportState()));

    now += 3600_000;
    state.head = 'h2';
    const second = new Monitor({ config, collector: collector(state), runs: noRuns, now: () => now, restore: saved });
    await second.tick();
    expect(second.snapshot.startedAt).toBe(new Date(T0).toISOString());
    expect(second.snapshot.projects[0]!.since!.baseline).toEqual({ at: new Date(T0).toISOString(), branch: 'main', head: 'h1' });

    const moved = parseConfig({ projects: [{ name: 'app', repoPath: '/repo/elsewhere' }] }, '/base');
    const third = new Monitor({ config: moved, collector: collector(state), runs: noRuns, now: () => now, restore: saved });
    await third.tick();
    expect(third.snapshot.projects[0]!.since!.baseline.head).toBe('h2');
  });

  it('reset starts a new session', async () => {
    let now = T0;
    const state = { head: 'h1', log: { errors: [], size: 0 } };
    const m = new Monitor({ config, collector: collector(state), runs: noRuns, now: () => now });
    await m.tick();
    now += 60_000;
    state.head = 'h2';
    await m.reset();
    expect(m.snapshot.startedAt).toBe(new Date(now).toISOString());
    expect(m.snapshot.projects[0]!.since!.baseline).toMatchObject({ head: 'h2', at: new Date(now).toISOString() });
  });

  it('acknowledging log errors hides them until new ones appear', async () => {
    const state = { head: 'h1', log: { errors: [] as string[], size: 10 } };
    const m = new Monitor({ config, collector: collector(state), runs: noRuns, now: () => T0 });
    await m.tick();
    state.log = { errors: ['Error: boom'], size: 30 };
    await m.tick();
    expect(m.snapshot.projects[0]!.status.state).toBe('error');

    expect(m.ackErrors('app')).toBe(true);
    expect(m.snapshot.projects[0]!.logErrors).toEqual([]);
    await m.tick();
    expect(m.snapshot.projects[0]!.logErrors).toEqual([]);
    expect(m.exportState().tracked.app!.logPos).toEqual({ offset: 30, ino: 1 });

    state.log = { errors: ['Error: again'], size: 50 };
    await m.tick();
    expect(m.snapshot.projects[0]!.logErrors).toEqual(['Error: again']);
    expect(m.ackErrors('nope')).toBe(false);
  });

  it('an in-flight scan cannot bring back acknowledged errors', async () => {
    const state: { head: string; log: FakeLog; gate?: Promise<void> } = { head: 'h1', log: { errors: [], size: 10 } };
    const m = new Monitor({ config, collector: collector(state), runs: noRuns, now: () => T0 });
    await m.tick();
    state.log = { errors: ['Error: boom'], size: 30 };
    await m.tick();

    let open = () => {};
    state.gate = new Promise((r) => (open = r));
    const inFlight = m.tick();
    await new Promise((r) => setTimeout(r, 5));
    m.ackErrors('app');
    open();
    await inFlight;
    expect(m.snapshot.projects[0]!.logErrors).toEqual([]);
  });

  it('forgets the log position when the log file setting changes', async () => {
    const state = { head: 'h1', log: { errors: ['Error: old'], size: 30 } };
    const m = new Monitor({ config, collector: collector(state), runs: noRuns, now: () => T0 });
    await m.tick();
    expect(m.exportState().tracked.app).toMatchObject({ logFile: '/repo/app/a.log', logPos: { offset: 30 } });
    const moved = parseConfig({ projects: [{ name: 'app', repoPath: '/repo/app', logFile: 'b.log' }] }, '/base');
    state.log = { errors: ['Error: preexisting in b'], size: 500 };
    await m.setConfig(moved, collector(state));
    expect(m.snapshot.projects[0]!.logErrors).toEqual([]);
    expect(m.exportState().tracked.app).toMatchObject({ logFile: '/repo/app/b.log', logPos: { offset: 500 } });
  });

  it('serializes overlapping ticks and reloads', async () => {
    const order: string[] = [];
    const slow: Collector = { ...collector({ head: 'h1', log: { errors: [], size: 0 } }), git: async (p) => {
      order.push(`start ${p.repoPath}`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`end ${p.repoPath}`);
      return gitInfo('h1');
    } };
    const m = new Monitor({ config, collector: slow, runs: noRuns, now: () => T0 });
    const moved = parseConfig({ projects: [{ name: 'app', repoPath: '/repo/new' }] }, '/base');
    await Promise.all([m.tick(), m.setConfig(moved, slow), m.tick()]);
    expect(order).toEqual(['start /repo/app', 'end /repo/app', 'start /repo/new', 'end /repo/new', 'start /repo/new', 'end /repo/new']);
    expect(m.snapshot.projects[0]!.repoPath).toBe('/repo/new');
  });
});
