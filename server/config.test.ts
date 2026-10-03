import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULTS, loadConfig, parseConfig } from './config.ts';

describe('parseConfig', () => {
  it('fills defaults', () => {
    const c = parseConfig({}, '/base');
    expect(c.host).toBe('127.0.0.1');
    expect(c.refreshIntervalSec).toBe(5);
    expect(c.thresholds).toEqual(DEFAULTS.thresholds);
    expect(c.reportsDir).toBe('/base/reports');
    expect(c.projects).toEqual([]);
  });

  it('resolves paths and generates unique ids', () => {
    const c = parseConfig(
      {
        thresholds: { idleMinutes: 1 },
        projects: [
          { name: 'My App', repoPath: '~/code/app', tmuxSession: 'app', logFile: 'agent.log' },
          { name: 'My App', repoPath: 'rel' },
        ],
      },
      '/base',
    );
    expect(c.thresholds).toEqual({ idleMinutes: 1, stalledMinutes: 30, noCommitMinutes: 30 });
    expect(c.projects[0]).toMatchObject({
      id: 'my-app',
      repoPath: `${homedir()}/code/app`,
      logFile: `${homedir()}/code/app/agent.log`,
      testCommand: null,
    });
    expect(c.projects[1]).toMatchObject({ id: 'my-app-2', repoPath: '/base/rel', tmuxSession: null });
  });

  it('collects all issues', () => {
    const bad = {
      port: 'x',
      thresholds: { idleMinutes: -1 },
      errorPatterns: 'error',
      projects: [{ name: 'a' }, { name: 'b', repoPath: '/b', tmuxSession: 'bad:name' }, { name: 'c', repoPath: '/c', tmuxSession: '-t' }, { name: 'd', repoPath: '/d', tmuxSession: '$1' }],
    };
    try {
      parseConfig(bad, '/base');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).issues).toHaveLength(7);
    }
  });
});

describe('loadConfig', () => {
  it('starts empty when the file is missing', () => {
    const { config, missing } = loadConfig('/nonexistent/nightshift.json', '/base');
    expect(missing).toBe(true);
    expect(config.projects).toEqual([]);
  });

  it('parses the example config', () => {
    const { config, missing } = loadConfig('config/nightshift.example.json', process.cwd());
    expect(missing).toBe(false);
    expect(config.projects).toHaveLength(2);
  });
});
