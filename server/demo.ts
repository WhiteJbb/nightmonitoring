// Demo mode: tmux 세션이나 Git 저장소 없이 UI 전체를 확인하기 위한 가짜 Collector.
// 상태 판정·보고서·UI 는 실제 코드가 그대로 돈다.
import type { Commit, FileStat, GitInfo, RunResult } from '../shared/types.ts';
import type { Config, ProjectConfig } from './config.ts';
import type { ConfiguredExec } from './exec.ts';
import type { Collector, RawTmux } from './monitor.ts';
import { stripAnsi } from './logs.ts';
import { attachCommand } from './monitor.ts';
import type { Runner } from './runner.ts';

type DemoFile = [path: string, status: string, additions: number, deletions: number];
type DemoCommit = [minutesAgo: number, subject: string];
interface DemoPane {
  windowName: string;
  command: string;
  lines: string[];
}

interface DemoProject {
  name: string;
  session: string;
  branch: string;
  commits: DemoCommit[];
  /** 모니터링 시작 이후 생긴 것으로 보여 줄 커밋 수 */
  newCommits: number;
  files: DemoFile[];
  sessionAlive: boolean;
  /** 마지막 터미널 활동이 몇 분 전인지. null 이면 계속 출력 중 */
  quietMinutes: number | null;
  /** 첫 번째가 활성 pane */
  panes: DemoPane[];
}

const E = '\x1b[';
const green = (s: string) => `${E}32m${s}${E}0m`;
const red = (s: string) => `${E}31m${s}${E}0m`;
const dim = (s: string) => `${E}2m${s}${E}0m`;
const bold = (s: string) => `${E}1m${s}${E}0m`;
const cyan = (s: string) => `${E}36m${s}${E}0m`;
const pane = (command: string, lines: string[], windowName = command): DemoPane => ({ windowName, command, lines });

const DEMO: DemoProject[] = [
  {
    name: 'api-server',
    session: 'api-agent',
    branch: 'feat/rate-limiter',
    commits: [
      [3, 'feat: add sliding window rate limiter'],
      [26, 'test: cover limiter edge cases'],
      [58, 'refactor: extract redis client factory'],
      [140, 'chore: bump dependencies'],
    ],
    newCommits: 3,
    files: [
      ['src/middleware/rateLimiter.ts', ' M', 84, 12],
      ['src/routes/index.ts', ' M', 6, 1],
      ['test/rateLimiter.test.ts', '??', 41, 0],
    ],
    sessionAlive: true,
    quietMinutes: null,
    panes: [
      pane('claude', [
        `${cyan('●')} ${bold('Implementing rate limiter middleware')}`,
        dim('  ⎿ Read src/middleware/auth.ts (112 lines)'),
        dim('  ⎿ Edit src/middleware/rateLimiter.ts'),
        '',
        `${dim('$')} npm test -- rateLimiter`,
        ` ${green('✓')} allows requests under the limit`,
        ` ${green('✓')} blocks requests over the limit`,
        ` ${green('✓')} resets after the window`,
      ]),
      pane('node', [`${dim('[12:01:44]')} ${green('GET')} /health 200 1ms`, `${dim('[12:01:49]')} ${green('GET')} /api/items 200 12ms`, `${dim('[12:01:51]')} ${red('POST')} /api/items 429 0ms`], 'server'),
    ],
  },
  {
    name: 'web-frontend',
    session: 'web-agent',
    branch: 'feat/settings-page',
    commits: [
      [22, 'feat: add settings form validation'],
      [75, 'feat: scaffold settings page'],
    ],
    newCommits: 1,
    files: [['src/pages/Settings.tsx', ' M', 31, 4]],
    sessionAlive: true,
    quietMinutes: 20,
    panes: [pane('claude', [`${cyan('●')} Settings form validation is done and committed.`, '', '  Next I could wire the form to the API. Let me know how to continue.', '', dim('❯ ')])],
  },
  {
    name: 'mobile-app',
    session: 'mobile-agent',
    branch: 'feat/push-notifications',
    commits: [[9, 'feat: register device token on login']],
    newCommits: 1,
    files: [['ios/Podfile', ' M', 2, 0]],
    sessionAlive: true,
    quietMinutes: 6,
    panes: [pane('claude', [`${cyan('●')} I need to run ${bold('pod install')} to continue.`, '', `  ${bold('Do you want to proceed?')}`, `  ${cyan('❯ 1. Yes')}`, '    2. No, tell me what to do differently'])],
  },
  {
    name: 'payments-service',
    session: 'payments-agent',
    branch: 'fix/refund-rounding',
    commits: [
      [8, 'fix: round refunds half-even'],
      [44, 'test: add refund rounding cases'],
    ],
    newCommits: 2,
    files: [['src/refund.ts', ' M', 18, 9]],
    sessionAlive: true,
    quietMinutes: 2,
    panes: [
      pane('claude', [
        `${dim('$')} npm test`,
        ` ${green('✓')} charge > creates a charge`,
        ` ${red('✗')} refund > rounds partial refunds half-even`,
        red('   AssertionError: expected 10.02 to equal 10.01'),
        '',
        ` Tests  ${red('1 failed')} | ${green('41 passed')} (42)`,
        `${cyan('●')} Investigating the failing refund test...`,
      ]),
    ],
  },
  {
    name: 'data-pipeline',
    session: 'pipeline-agent',
    branch: 'main',
    commits: [
      [125, 'feat: add parquet export step'],
      [190, 'fix: handle empty partitions'],
    ],
    newCommits: 0,
    files: [],
    sessionAlive: false,
    quietMinutes: null,
    panes: [],
  },
  {
    name: 'docs-site',
    session: 'docs-agent',
    branch: 'docs/api-reference',
    commits: [[52, 'docs: add authentication guide']],
    newCommits: 0,
    files: [['docs/api/auth.md', ' M', 12, 0]],
    sessionAlive: true,
    quietMinutes: 47,
    panes: [pane('npm', [`${dim('$')} npm run docs:build`, 'building 128 pages...', 'waiting for lock on .cache/build.lock'])],
  },
];

export function demoConfig(base: Config): Config {
  return {
    ...base,
    projects: DEMO.map((d) => ({
      id: d.name,
      name: d.name,
      repoPath: `/Users/demo/code/${d.name}`,
      tmuxSession: d.session,
      testCommand: 'npm test',
      buildCommand: 'npm run build',
      logFile: null,
    })),
  };
}

const find = (p: ProjectConfig): DemoProject => DEMO.find((d) => d.name === p.id) ?? DEMO[0]!;

export function demoCollector(now: () => number = Date.now): Collector {
  const ago = (min: number) => new Date(now() - min * 60_000).toISOString();
  const started = now();
  const commitsOf = (d: DemoProject): Commit[] =>
    d.commits.map(([min, subject], i) => ({ hash: `${d.name.length}${i}c0ffee${i}`.padEnd(40, 'a'), author: 'agent', date: ago(min), subject }));
  const statsOf = (d: DemoProject): FileStat[] => d.files.map(([path, status, additions, deletions]) => ({ path, additions, deletions, ...(status === '??' ? { untracked: true } : {}) }));
  const total = (files: FileStat[], key: 'additions' | 'deletions') => files.reduce((n, f) => n + f[key], 0);

  return {
    async git(p): Promise<GitInfo> {
      const d = find(p);
      const commits = commitsOf(d);
      const diffStat = statsOf(d);
      return {
        ok: true,
        branch: d.branch,
        head: commits[0]?.hash ?? null,
        clean: d.files.length === 0,
        changedFiles: d.files.map(([path, status]) => ({ path, status })),
        diffStat,
        additions: total(diffStat, 'additions'),
        deletions: total(diffStat, 'deletions'),
        recentCommits: commits,
        todayCommits: commits.filter((c) => new Date(c.date).toDateString() === new Date(now()).toDateString()),
        fingerprint: JSON.stringify([commits[0]?.hash, d.files]),
      };
    },
    async since(p, baseline) {
      const d = find(p);
      const files = statsOf(d);
      return {
        baseline: { ...baseline, branch: d.newCommits ? 'main' : d.branch },
        commits: commitsOf(d).slice(0, d.newCommits),
        files,
        additions: total(files, 'additions'),
        deletions: total(files, 'deletions'),
      };
    },
    async tmux(projects) {
      const out = new Map<string, RawTmux>();
      const elapsedSec = Math.floor((now() - started) / 1000);
      for (const p of projects) {
        const d = find(p);
        // 계속 출력 중인 프로젝트는 매 폴링마다 줄이 달라진다.
        const live = d.quietMinutes === null ? [`${E}35m✽${E}0m ${E}2mDeploying… (${elapsedSec}s · ↓ ${1200 + elapsedSec * 37} tokens)${E}0m`, `${E}2m  ⎿ Tool call #${Math.floor(elapsedSec / 5) + 1}${E}0m`] : [];
        const panes = d.sessionAlive
          ? d.panes.map((x, i) => ({ id: `%${p.id.length}${i}`, window: i, windowName: x.windowName, index: 0, command: x.command, active: i === 0, lines: i === 0 ? [...x.lines, ...live] : x.lines }))
          : [];
        out.set(p.id, {
          configured: true,
          exists: d.sessionAlive,
          createdAt: d.sessionAlive ? ago(310) : null,
          attached: d.name === 'api-server',
          lastActivityAt: d.sessionAlive ? ago(d.quietMinutes ?? 0) : null,
          output: panes[0]?.lines.map(stripAnsi) ?? [],
          panes,
          waitingPrompt: null,
          attachCommand: attachCommand(d.session),
        });
      }
      return out;
    },
    logErrors: async () => [],
  };
}

const FAILED_TEST_STDOUT = ` RUN  v5.0.3 /Users/demo/code/payments-service

 ✓ test/charge.test.ts (18 tests)
 ✓ test/webhook.test.ts (11 tests)
 ❯ test/refund.test.ts (13 tests | 1 failed)

 Test Files  1 failed | 2 passed (3)
      Tests  1 failed | 41 passed (42)
`;
const FAILED_TEST_STDERR = ` FAIL  test/refund.test.ts > refund > rounds partial refunds half-even
AssertionError: expected 10.02 to equal 10.01
 ❯ test/refund.test.ts:87:31
`;

export function seedDemoRuns(runner: Runner, now: () => number = Date.now): void {
  const run = (kind: RunResult['kind'], minAgo: number, exitCode: number, stdout: string, stderr: string): RunResult => ({
    kind,
    command: kind === 'test' ? 'npm test' : 'npm run build',
    running: false,
    startedAt: new Date(now() - minAgo * 60_000).toISOString(),
    finishedAt: new Date(now() - minAgo * 60_000 + 8400).toISOString(),
    exitCode,
    timedOut: false,
    canceled: false,
    durationMs: 8400,
    stdout,
    stderr,
  });
  runner.seed('payments-service', run('test', 4, 1, FAILED_TEST_STDOUT, FAILED_TEST_STDERR));
  runner.seed('payments-service', run('build', 30, 0, '✓ built in 3.21s\n', ''));
  runner.seed('api-server', run('test', 12, 0, ' Test Files  9 passed (9)\n      Tests  64 passed (64)\n', ''));
}

/** demo 에서는 실제 명령을 실행하지 않고 잠시 뒤 정해진 결과를 돌려준다. 취소도 흉내 낸다. */
export const demoExec: ConfiguredExec = (command, cwd, _timeoutMs, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      const failing = cwd.endsWith('payments-service') && command === 'npm test';
      resolve(
        failing
          ? { code: 1, stdout: FAILED_TEST_STDOUT, stderr: FAILED_TEST_STDERR, timedOut: false }
          : { code: 0, stdout: `[demo] ${command}\n✓ done\n`, stderr: '', timedOut: false },
      );
    }, 4000);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve({ code: null, stdout: `[demo] ${command}\n`, stderr: '', timedOut: false });
    });
  });
