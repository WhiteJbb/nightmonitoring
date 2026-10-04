import { describe, expect, it, vi } from 'vitest';
import type { GitInfo, Snapshot } from '../shared/types.ts';
import { parseConfig } from './config.ts';
import { demoCollector, demoConfig, seedDemoRuns } from './demo.ts';
import type { Collector, RawTmux } from './monitor.ts';
import { attachCommand, Monitor, NO_LOG } from './monitor.ts';
import { Runner } from './runner.ts';

const T0 = Date.parse('2026-10-04T03:00:00Z');
const noRuns = () => ({ test: null, build: null });
const config = parseConfig({ projects: [{ name: 'app', repoPath: '/repo/app', tmuxSession: 'app' }, { name: 'lib', repoPath: '/repo/lib' }] }, '/base');

const git = (over: Partial<GitInfo> = {}): GitInfo => ({
  ok: true, branch: 'main', head: 'h1', clean: true, changedFiles: [], diffStat: [], additions: 0, deletions: 0,
  recentCommits: [{ hash: 'h1', author: 'a', date: new Date(T0 - 60 * 60_000).toISOString(), subject: 's' }], todayCommits: [], fingerprint: JSON.stringify(over.changedFiles ?? []), ...over,
});

function fakeCollector(state: { output: string[]; git: GitInfo; gitThrows?: boolean; tmuxThrows?: boolean }): Collector {
  return {
    async git(p) {
      if (state.gitThrows && p.id === 'lib') throw new Error('boom');
      return state.git;
    },
    since: async (_p, baseline) => ({ baseline, commits: [], files: [], additions: 0, deletions: 0 }),
    async tmux() {
      if (state.tmuxThrows) throw new Error('tmux down');
      const raw: RawTmux = { configured: true, exists: true, createdAt: null, attached: false, lastActivityAt: new Date(T0 - 40 * 60_000).toISOString(), output: state.output, panes: [], waitingPrompt: null, attachCommand: 'tmux attach -t app' };
      return new Map([['app', raw]]);
    },
    logErrors: async () => NO_LOG,
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

  it('ignores spinner-only churn but notices real output in any pane', async () => {
    let now = T0;
    const pane = (id: string, lines: string[]) => ({ id, window: 0, windowName: 'w', index: 0, command: 'zsh', active: id === '%1', lines });
    const state = { panes: [pane('%1', ['\x1b[35m✽\x1b[0m Thinking… (10s · 1.2k tokens)']), pane('%2', ['idle'])] };
    let activity = new Date(T0 - 60_000).toISOString();
    const collector = fakeCollector({ output: [], git: git() });
    collector.tmux = async () => new Map([['app', { configured: true, exists: true, createdAt: null, attached: false, lastActivityAt: activity, output: [], panes: state.panes, waitingPrompt: null, attachCommand: 'tmux attach -t app' }]]);
    const m = new Monitor({ config, collector, runs: noRuns, now: () => now });
    await m.tick();
    const first = m.snapshot.projects[0]!.tmux.lastOutputChangeAt;

    now += 5000;
    state.panes = [pane('%1', ['\x1b[35m✻\x1b[0m Thinking… (15s · 1.9k tokens)']), pane('%2', ['idle'])];
    activity = new Date(now).toISOString(); // tmux 는 스피너 출력에도 활동 시각을 올린다
    await m.tick();
    expect(m.snapshot.projects[0]!.tmux.lastOutputChangeAt).toBe(first);

    now += 5000;
    state.panes = [state.panes[0]!, pane('%2', ['compiled successfully'])];
    await m.tick();
    expect(m.snapshot.projects[0]!.tmux.lastOutputChangeAt).toBe(new Date(now).toISOString());

    state.panes = [pane('%1', ['Overwrite file? (y/n)']), state.panes[1]!];
    await m.tick();
    expect(m.snapshot.projects[0]!.status).toEqual({ state: 'waiting', reasons: ['입력 대기: Overwrite file? (y/n)'] });
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

  it('keeps a configured session visible when tmux collection throws', async () => {
    const m = new Monitor({ config, collector: fakeCollector({ output: [], git: git(), tmuxThrows: true }), runs: noRuns, now: () => T0 });
    await m.tick();
    const app = m.snapshot.projects[0]!;
    expect(app.tmux).toMatchObject({ configured: true, exists: false, attachCommand: 'tmux attach -t app' });
    expect(app.status).toEqual({ state: 'error', reasons: ['tmux 수집 실패: tmux down'] });
  });

  it('demo mode shows every state', async () => {
    const runner = new Runner({ timeoutSec: 1, logDir: null });
    seedDemoRuns(runner, () => T0);
    const m = new Monitor({ config: demoConfig(config), collector: demoCollector(() => T0), runs: runner.get, demo: true, now: () => T0 });
    await m.tick();
    const states = Object.fromEntries(m.snapshot.projects.map((p) => [p.id, p.status.state]));
    expect(states).toEqual({ 'api-server': 'running', 'web-frontend': 'idle', 'mobile-app': 'waiting', 'payments-service': 'error', 'data-pipeline': 'error', 'docs-site': 'stalled' });
    expect(m.snapshot.projects.find((p) => p.id === 'payments-service')!.status.reasons).toEqual(['테스트 실패 (exit 1)']);
    expect(m.snapshot.summary).toMatchObject({ total: 6, sessionsRunning: 5, waiting: 1 });
    const api = m.snapshot.projects[0]!;
    expect(api.tmux.panes).toHaveLength(2);
    expect(api.tmux.output.join('\n')).not.toContain('\x1b');
    expect(m.snapshot.projects.find((p) => p.id === 'mobile-app')!.status.reasons).toEqual(['입력 대기: Do you want to proceed?']);
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
    expect(exec).toHaveBeenCalledExactlyOnceWith('npm test', '/repo/app', 7000, expect.any(AbortSignal));
    expect(runner.get(p.id).test).toMatchObject({ exitCode: 2, stdout: 'out', stderr: 'err', timedOut: false });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(runner.history(p.id).test).toEqual([expect.objectContaining({ exitCode: 2, canceled: false })]);
  });

  it('cancels a running command and records it as canceled', async () => {
    const exec = vi.fn((_c: string, _d: string, _t: number, signal?: AbortSignal) => new Promise<{ code: null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => signal!.addEventListener('abort', () => resolve({ code: null, stdout: 'partial', stderr: '', timedOut: false }))));
    const runner = new Runner({ timeoutSec: 7, logDir: null, exec });
    const p = { ...project, buildCommand: 'npm run build' };
    expect(runner.cancel(p.id, 'build')).toBe(false);
    runner.start(p, 'build');
    expect(runner.cancel(p.id, 'build')).toBe(true);
    await vi.waitFor(() => expect(runner.get(p.id).build?.running).toBe(false));
    expect(runner.get(p.id).build).toMatchObject({ canceled: true, exitCode: null, stdout: 'partial' });
    expect(runner.cancel(p.id, 'build')).toBe(false);
  });

  it('forget drops results and ignores the completion of an abandoned run', async () => {
    let finish = () => {};
    const exec = vi.fn(() => new Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>((resolve) => (finish = () => resolve({ code: 1, stdout: '', stderr: '', timedOut: false }))));
    const runner = new Runner({ timeoutSec: 7, logDir: null, exec });
    const p = { ...project, testCommand: 'npm test' };
    runner.start(p, 'test');
    runner.forget(p.id);
    finish();
    await new Promise((r) => setTimeout(r, 5));
    expect(runner.get(p.id)).toEqual({ test: null, build: null });
    expect(runner.history(p.id).test).toEqual([]);
  });

  it('keeps bounded history and restores state, marking interrupted runs', () => {
    const runner = new Runner({ timeoutSec: 7, logDir: null });
    const result = (i: number, running = false) => ({ kind: 'test' as const, command: 'npm test', running, startedAt: new Date(T0 + i * 1000).toISOString(), finishedAt: null, exitCode: running ? null : 0, timedOut: false, canceled: false, durationMs: 1, stdout: 'x'.repeat(100_000), stderr: '' });
    for (let i = 0; i < 25; i++) runner.seed('app', result(i));
    expect(runner.history('app').test).toHaveLength(20);
    expect(runner.history('app').test[0]!.startedAt).toBe(result(24).startedAt);
    runner.seed('app', result(99, true));

    const state = JSON.parse(JSON.stringify(runner.exportState()));
    expect(state.results.app.test.stdout).toHaveLength(64 * 1024);
    const restored = new Runner({ timeoutSec: 7, logDir: null });
    restored.restore(state);
    expect(restored.get('app').test).toMatchObject({ running: false, canceled: true });
    expect(restored.get('app').test!.stderr).toContain('서버 재시작으로 중단됨');
    expect(restored.history('app').test).toHaveLength(20);
    expect(restored.history('app').test[0]).toMatchObject({ canceled: true });
  });
});
