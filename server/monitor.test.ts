import { describe, expect, it, vi } from 'vitest';
import type { GitInfo, Snapshot } from '../shared/types.ts';
import { parseConfig } from './config.ts';
import { demoCollector, demoConfig, seedDemoRuns } from './demo.ts';
import type { Collector, RawTmux } from './monitor.ts';
import { attachCommand, Monitor } from './monitor.ts';
import { Runner } from './runner.ts';

const T0 = Date.parse('2026-10-04T03:00:00Z');
const noRuns = () => ({ test: null, build: null });
const config = parseConfig({ projects: [{ name: 'app', repoPath: '/repo/app', tmuxSession: 'app' }, { name: 'lib', repoPath: '/repo/lib' }] }, '/base');

const git = (over: Partial<GitInfo> = {}): GitInfo => ({
  ok: true, branch: 'main', head: 'h1', clean: true, changedFiles: [], diffStat: [], additions: 0, deletions: 0,
  recentCommits: [{ hash: 'h1', author: 'a', date: new Date(T0 - 60 * 60_000).toISOString(), subject: 's' }], todayCommits: [], ...over,
});

function fakeCollector(state: { output: string[]; git: GitInfo; gitThrows?: boolean }): Collector {
  return {
    async git(p) {
      if (state.gitThrows && p.id === 'lib') throw new Error('boom');
      return state.git;
    },
    since: async (_p, baseline) => ({ baseline, commits: [], files: [], additions: 0, deletions: 0 }),
    async tmux() {
      const raw: RawTmux = { configured: true, exists: true, createdAt: null, attached: false, lastActivityAt: new Date(T0 - 40 * 60_000).toISOString(), output: state.output, attachCommand: 'tmux attach -t app' };
      return new Map([['app', raw]]);
    },
    logErrors: async () => [],
  };
}

describe('Monitor', () => {
  it('tracks output and git changes between ticks', async () => {
    let now = T0;
    const state = { output: ['a'], git: git() };
    const m = new Monitor({ config, collector: fakeCollector(state), runs: noRuns, now: () => now });
    await m.tick();
    const app = () => m.snapshot.projects.find((p) => p.id === 'app')!;
    // 최초 관측: tmux 활동 시각(40분 전) + 마지막 커밋(60분 전) → 정지 의심
    expect(app().status.state).toBe('stalled');
    expect(app().since?.baseline).toMatchObject({ branch: 'main', head: 'h1' });

    now += 5000;
    state.output = ['a', 'b'];
    await m.tick();
    expect(app().tmux.lastOutputChangeAt).toBe(new Date(now).toISOString());
    expect(app().status.state).toBe('running');

    now += 20 * 60_000; // 출력이 20분간 그대로 → 유휴
    await m.tick();
    expect(app().status.state).toBe('idle');

    state.git = git({ clean: false, changedFiles: [{ path: 'x.ts', status: ' M' }] });
    await m.tick();
    expect(app().lastGitChangeAt).toBe(new Date(now).toISOString());
    expect(app().since?.baseline.at).toBe(new Date(T0).toISOString());
  });

  it('isolates a failing project and notifies subscribers', async () => {
    const m = new Monitor({ config, collector: fakeCollector({ output: [], git: git(), gitThrows: true }), runs: noRuns, now: () => T0 });
    const seen: Snapshot[] = [];
    const off = m.subscribe((s) => seen.push(s));
    await m.tick();
    off();
    await m.tick();
    expect(seen).toHaveLength(1);
    const [app, lib] = seen[0]!.projects;
    expect(app!.git.ok).toBe(true);
    expect(lib!.status).toEqual({ state: 'error', reasons: ['수집 실패: boom'] });
    expect(seen[0]!.summary).toMatchObject({ total: 2, sessionsRunning: 1, error: 1 });
  });

  it('demo mode shows every state', async () => {
    const runner = new Runner({ timeoutSec: 1, logDir: null });
    seedDemoRuns(runner, () => T0);
    const m = new Monitor({ config: demoConfig(config), collector: demoCollector(() => T0), runs: runner.get, demo: true, now: () => T0 });
    await m.tick();
    const states = Object.fromEntries(m.snapshot.projects.map((p) => [p.id, p.status.state]));
    expect(states).toEqual({ 'api-server': 'running', 'web-frontend': 'idle', 'payments-service': 'error', 'data-pipeline': 'error', 'docs-site': 'stalled' });
    expect(m.snapshot.projects.find((p) => p.id === 'payments-service')!.status.reasons).toEqual(['테스트 실패 (exit 1)']);
    expect(m.snapshot.summary).toMatchObject({ total: 5, sessionsRunning: 4 });
  });
});

describe('attachCommand', () => {
  it('quotes unusual session names', () => {
    expect(attachCommand('my-agent')).toBe('tmux attach -t my-agent');
    expect(attachCommand("a$b'c")).toBe(`tmux attach -t 'a$b'\\''c'`);
  });
});

describe('Runner', () => {
  const project = config.projects[0]!;
  it('runs only the configured command in the repo path', async () => {
    const exec = vi.fn(async () => ({ code: 2, stdout: 'out', stderr: 'err', timedOut: false }));
    const runner = new Runner({ timeoutSec: 7, logDir: null, exec });
    const changed = vi.fn();
    runner.onChange = changed;
    expect(runner.start(project, 'test')).toBe('no-command');
    const p = { ...project, testCommand: 'npm test' };
    expect(runner.start(p, 'test')).toBe('started');
    expect(runner.start(p, 'test')).toBe('already-running');
    expect(runner.get(p.id).test).toMatchObject({ running: true, command: 'npm test' });
    await vi.waitFor(() => expect(runner.get(p.id).test?.running).toBe(false));
    expect(exec).toHaveBeenCalledExactlyOnceWith('npm test', '/repo/app', 7000);
    expect(runner.get(p.id).test).toMatchObject({ exitCode: 2, stdout: 'out', stderr: 'err', timedOut: false });
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
