import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GitInfo, Snapshot } from '../shared/types.ts';
import { DEFAULTS, defaultConfigPath, loadConfig } from './config.ts';
import type { Collector } from './monitor.ts';
import { Monitor, NO_LOG } from './monitor.ts';
import { alertsFor, autoReportDue, MAC_ALERT_STATES } from './notify.ts';
import { reloadConfig } from './reload.ts';
import { Runner } from './runner.ts';

let dir = '';
beforeAll(async () => void (dir = await mkdtemp(path.join(tmpdir(), 'nightshift-reload-'))));
afterAll(() => rm(dir, { recursive: true }));
afterEach(() => vi.restoreAllMocks());

const git: GitInfo = { ok: true, branch: 'main', head: 'h1', clean: true, changedFiles: [], diffStat: [], additions: 0, deletions: 0, recentCommits: [], todayCommits: [], fingerprint: 'h1' };
const collectorFor = (): Collector => ({
  git: async () => git,
  since: async (_p, baseline) => ({ baseline, commits: [], files: [], additions: 0, deletions: 0 }),
  tmux: async () => new Map(),
  logErrors: async () => NO_LOG,
});

describe('config files', () => {
  it('loads YAML and both examples describe the same config', async () => {
    const file = path.join(dir, 'c.yaml');
    await writeFile(file, 'refreshIntervalSec: 9\nprojects:\n  - name: App\n    repoPath: /repo/app\n    tmuxSession: app\n');
    const { config } = loadConfig(file, '/base');
    expect(config).toMatchObject({ refreshIntervalSec: 9, projects: [{ id: 'app', tmuxSession: 'app' }] });

    const json = loadConfig('config/nightshift.example.json', process.cwd()).config;
    const yaml = loadConfig('config/nightshift.example.yaml', process.cwd()).config;
    expect(yaml).toEqual(json);
    expect(json.promptPatterns).toEqual(DEFAULTS.promptPatterns);
  });

  it('reports YAML syntax errors and accepts an empty file', async () => {
    const file = path.join(dir, 'bad.yml');
    await writeFile(file, 'projects: [unclosed');
    expect(() => loadConfig(file, '/base')).toThrow(/YAML 파싱 실패/);
    await writeFile(file, '');
    expect(loadConfig(file, '/base').config.projects).toEqual([]);
  });

  it('prefers json, then yaml, then yml', async () => {
    const d = path.join(dir, 'conf');
    expect(defaultConfigPath(d)).toBe(path.join(d, 'nightshift.json'));
    await writeFile(path.join(dir, 'nightshift.yml'), '');
    expect(defaultConfigPath(dir)).toBe(path.join(dir, 'nightshift.yml'));
  });
});

describe('reloadConfig', () => {
  it('applies a changed config, keeps baselines, and keeps the old one on error', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = path.join(dir, 'live.json');
    const write = (c: object) => writeFile(file, JSON.stringify(c));
    await write({ projects: [{ name: 'a', repoPath: '/repo/a' }, { name: 'b', repoPath: '/repo/b' }] });

    const runner = new Runner({ timeoutSec: 600, logDir: null });
    const monitor = new Monitor({ config: loadConfig(file, '/base').config, collector: collectorFor(), runs: runner.get });
    await monitor.tick();
    const baselineA = monitor.snapshot.projects[0]!.since!.baseline.at;
    const deps = { configPath: file, baseDir: '/base', monitor, runner, collectorFor };

    await write({ port: 9999, refreshIntervalSec: 2, commandTimeoutSec: 30, projects: [{ name: 'a', repoPath: '/repo/a' }, { name: 'c', repoPath: '/repo/c' }] });
    expect(await reloadConfig(deps)).toBe('applied');
    expect(monitor.snapshot.projects.map((p) => p.id)).toEqual(['a', 'c']);
    expect(monitor.snapshot.projects[0]!.since!.baseline.at).toBe(baselineA);
    expect(monitor.snapshot.refreshIntervalSec).toBe(2);
    expect(runner.timeoutSec).toBe(30);
    expect(monitor.config.port).toBe(4477); // 재시작 전에는 바뀌지 않는다
    expect(monitor.exportState().tracked).not.toHaveProperty('b');

    await writeFile(file, '{ "projects": [ { "name": ');
    expect(await reloadConfig(deps)).toBe('error');
    expect(monitor.snapshot.configError).toContain('JSON 파싱 실패');
    expect(monitor.snapshot.projects.map((p) => p.id)).toEqual(['a', 'c']);

    await rm(file);
    expect(await reloadConfig(deps)).toBe('error');
    expect(monitor.snapshot.configError).toContain('파일이 없습니다');

    await write({ projects: [{ name: 'a', repoPath: '/repo/a' }] });
    expect(await reloadConfig(deps)).toBe('applied');
    expect(monitor.snapshot.configError).toBeNull();
    expect(error).toHaveBeenCalledTimes(2);
  });
});

describe('alerts', () => {
  const snap = (states: Record<string, string>): Snapshot => ({ projects: Object.entries(states).map(([id, state]) => ({ id, name: id.toUpperCase(), status: { state, reasons: [`${state} reason`] } })) }) as unknown as Snapshot;

  it('alerts on transitions into waiting, idle, stalled or error, never into running', () => {
    const prev = new Map();
    expect(alertsFor(prev, snap({ a: 'error', b: 'running' }))).toEqual([]); // 처음 보는 프로젝트
    expect(alertsFor(prev, snap({ a: 'error', b: 'waiting' }))).toEqual([{ title: 'NightShift · B: 입력 대기', message: 'waiting reason', projectId: 'b', state: 'waiting' }]);
    expect(alertsFor(prev, snap({ a: 'running', b: 'waiting' }))).toEqual([]);
    expect(alertsFor(prev, snap({ a: 'idle', b: 'stalled' })).map((x) => [x.title, x.state])).toEqual([['NightShift · A: 유휴', 'idle'], ['NightShift · B: 정지 의심', 'stalled']]);
    expect(alertsFor(prev, snap({ a: 'error' })).map((x) => x.title)).toEqual(['NightShift · A: 오류']);
    expect([...prev.keys()]).toEqual(['a']);
    // Mac 알림에는 유휴가 포함되지 않는다
    expect(MAC_ALERT_STATES).toEqual(['waiting', 'stalled', 'error']);
  });
});

describe('autoReportDue', () => {
  const at = (h: number, m = 0, day = 5) => new Date(2026, 9, day, h, m);
  it('fires once per day after the scheduled time, only if running since before it', () => {
    expect(autoReportDue(at(6, 59), '07:00', null, at(1))).toBe(false);
    expect(autoReportDue(at(7, 0), '07:00', null, at(1))).toBe(true);
    expect(autoReportDue(at(7, 5), '07:00', '2026-10-05', at(1))).toBe(false);
    expect(autoReportDue(at(7, 5), '07:00', '2026-10-04', at(23, 0, 4))).toBe(true);
    expect(autoReportDue(at(9), '07:00', null, at(8))).toBe(false); // 예약 시각 뒤에 켠 경우
    expect(autoReportDue(at(9), null, null, at(1))).toBe(false);
  });
});
