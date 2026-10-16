import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GitInfo, Snapshot } from '../shared/types.ts';
import { DEFAULTS, defaultConfigPath, loadConfig } from './config.ts';
import type { Collector } from './monitor.ts';
import { Monitor, NO_LOG } from './monitor.ts';
import { alertsFor, autoReportDue, exportAlerts, MAC_ALERT_STATES, REALERT_COOLDOWN_MS, restoreAlerts } from './notify.ts';
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
  const T0 = Date.parse('2026-10-16T00:00:00Z');
  const snap = (states: Record<string, string>, activity: Record<string, string | null> = {}, at = T0): Snapshot =>
    ({ generatedAt: new Date(at).toISOString(), projects: Object.entries(states).map(([id, state]) => ({ id, name: id.toUpperCase(), status: { state, reasons: [`${state} reason`] }, tmux: { lastOutputChangeAt: activity[id] ?? null }, lastGitChangeAt: activity[`${id}.git`] ?? null })) }) as unknown as Snapshot;

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

  it('does not repeat the same alert after a blip, but does after real activity', () => {
    const memory = new Map();
    const titles = (s: Snapshot) => alertsFor(memory, s).map((x) => x.title);
    titles(snap({ a: 'running' }, { a: 't0' }));
    expect(titles(snap({ a: 'waiting' }, { a: 't0' }))).toEqual(['NightShift · A: 입력 대기']);
    // 화면이 한 번 바뀌어 정상 → 다시 입력 대기: 반복이므로 조용히
    titles(snap({ a: 'running' }, { a: 't1' }));
    expect(titles(snap({ a: 'waiting' }, { a: 't1' }))).toEqual([]);
    // 출력이 여러 tick 바뀌었다 = 실제로 돌았다 → 다시 알린다
    titles(snap({ a: 'running' }, { a: 't2' }));
    titles(snap({ a: 'running' }, { a: 't3' }));
    titles(snap({ a: 'running' }, { a: 't4' }));
    expect(titles(snap({ a: 'idle' }, { a: 't4' }))).toEqual(['NightShift · A: 유휴']);
    expect(titles(snap({ a: 'waiting' }, { a: 't4' }))).toEqual(['NightShift · A: 입력 대기']);
  });

  it('stalled and error stay quiet for the cooldown unless Git changed, even with output activity or other alerts between', () => {
    const memory = new Map();
    const titles = (s: Snapshot) => alertsFor(memory, s).map((x) => x.title);
    const H = 60 * 60 * 1000;
    titles(snap({ a: 'running' }, { a: 't0' }));
    expect(titles(snap({ a: 'stalled' }, { a: 't0' }))).toEqual(['NightShift · A: 정지 의심']);
    // 화면 크기 바꾸기·시계 같은 출력 변화만으로는 다시 알리지 않는다
    for (const t of ['t1', 't2', 't3', 't4']) titles(snap({ a: 'running' }, { a: t }, T0 + H));
    expect(titles(snap({ a: 'stalled' }, { a: 't4' }, T0 + H))).toEqual([]);
    // 다른 알림(입력 대기)을 거쳐 돌아와도 마찬가지
    expect(titles(snap({ a: 'waiting' }, { a: 't4' }, T0 + H))).toEqual(['NightShift · A: 입력 대기']);
    expect(titles(snap({ a: 'stalled' }, { a: 't4' }, T0 + H))).toEqual([]);
    // Git 변화가 있었으면 새 소식이다
    titles(snap({ a: 'running' }, { a: 't5', 'a.git': 'g1' }, T0 + 2 * H));
    expect(titles(snap({ a: 'stalled' }, { a: 't5', 'a.git': 'g1' }, T0 + 2 * H))).toEqual(['NightShift · A: 정지 의심']);
    // 쿨다운이 지나면 출력 활동만으로도 다시 알린다
    for (const t of ['t6', 't7', 't8']) titles(snap({ a: 'running' }, { a: t, 'a.git': 'g1' }, T0 + 2 * H + REALERT_COOLDOWN_MS));
    expect(titles(snap({ a: 'stalled' }, { a: 't8', 'a.git': 'g1' }, T0 + 2 * H + REALERT_COOLDOWN_MS))).toEqual(['NightShift · A: 정지 의심']);
  });

  it('remembers sent alerts across a restart', () => {
    const before = new Map();
    alertsFor(before, snap({ a: 'running' }, { a: 't0' }));
    alertsFor(before, snap({ a: 'stalled' }, { a: 't0' }));
    const after = restoreAlerts(JSON.parse(JSON.stringify(exportAlerts(before))));
    // 재시작 뒤 첫 화면은 활동으로 치지 않고, 같은 정지는 다시 알리지 않는다
    expect(alertsFor(after, snap({ a: 'stalled' }, { a: 't9' }))).toEqual([]);
    for (const t of ['t10', 't11', 't12']) alertsFor(after, snap({ a: 'running' }, { a: t }));
    expect(alertsFor(after, snap({ a: 'stalled' }, { a: 't12' }))).toEqual([]);
    expect(restoreAlerts(undefined).size).toBe(0);
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
