import type { GitBaseline, GitInfo, ProjectSnapshot, RunKind, RunResult, SinceBaseline, Snapshot, TmuxInfo } from '../shared/types.ts';
import type { Config, ProjectConfig } from './config.ts';
import { collectGit, collectSince } from './git.ts';
import { scanLog } from './logs.ts';
import { judge } from './status.ts';
import { capturePane, listSessions } from './tmux.ts';

export type RawTmux = Omit<TmuxInfo, 'lastOutputChangeAt'>;

/** Monitor 가 데이터를 얻는 유일한 통로. 실제 구현과 demo 구현이 있다. */
export interface Collector {
  git(p: ProjectConfig): Promise<GitInfo>;
  since(p: ProjectConfig, baseline: GitBaseline): Promise<SinceBaseline>;
  tmux(projects: ProjectConfig[]): Promise<Map<string, RawTmux>>;
  logErrors(p: ProjectConfig): Promise<string[]>;
}

/** 복사해서 붙여 넣을 명령이므로 셸에 안전하게 인용한다. */
export function attachCommand(session: string): string {
  const quoted = /^[\w@+-]+$/.test(session) ? session : `'${session.replace(/'/g, `'\\''`)}'`;
  return `tmux attach -t ${quoted}`;
}

const NO_TMUX: RawTmux = { configured: false, exists: false, createdAt: null, attached: false, lastActivityAt: null, output: [], attachCommand: null };

export function realCollector(config: Config): Collector {
  return {
    git: (p) => collectGit(p.repoPath),
    since: (p, baseline) => collectSince(p.repoPath, baseline),
    logErrors: (p) => (p.logFile ? scanLog(p.logFile, config.errorPatterns) : Promise.resolve([])),
    async tmux(projects) {
      const { sessions, error } = await listSessions();
      const out = new Map<string, RawTmux>();
      await Promise.all(
        projects.map(async (p) => {
          const name = p.tmuxSession;
          if (!name) return;
          const s = sessions.get(name);
          out.set(p.id, {
            configured: true,
            exists: !!s,
            createdAt: s?.createdAt ?? null,
            attached: s?.attached ?? false,
            lastActivityAt: s?.lastActivityAt ?? null,
            output: s ? await capturePane(name) : [],
            attachCommand: attachCommand(name),
            ...(error ? { error } : {}),
          });
        }),
      );
      return out;
    },
  };
}

interface Tracked {
  baseline: GitBaseline | null;
  fingerprint: string | null;
  gitChangedAt: string | null;
  output: string | null;
  outputChangedAt: string | null;
}

type Collected = Pick<ProjectSnapshot, 'git' | 'since' | 'lastGitChangeAt' | 'tmux' | 'logErrors'>;

const latest = (a: string | null, b: string | null): string | null => {
  if (!a || !b) return a ?? b;
  return Date.parse(a) >= Date.parse(b) ? a : b;
};

export interface MonitorOptions {
  config: Config;
  collector: Collector;
  runs: (projectId: string) => Record<RunKind, RunResult | null>;
  demo?: boolean;
  configPath?: string;
  configMissing?: boolean;
  now?: () => number;
}

export class Monitor {
  snapshot: Snapshot;
  private opts: MonitorOptions;
  private now: () => number;
  private startedAt: string;
  private tracked = new Map<string, Tracked>();
  private collected = new Map<string, Collected>();
  private listeners = new Set<(s: Snapshot) => void>();
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: MonitorOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.startedAt = new Date(this.now()).toISOString();
    this.snapshot = this.build();
  }

  /** 모든 프로젝트를 한 번 수집하고 스냅샷을 갱신한다. 절대 throw 하지 않는다. */
  async tick(): Promise<void> {
    const { collector, config } = this.opts;
    const nowIso = new Date(this.now()).toISOString();
    let tmuxError: string | undefined;
    const tmuxAll = await collector.tmux(config.projects).catch((e: Error) => {
      tmuxError = `tmux 수집 실패: ${e.message}`;
      return new Map<string, RawTmux>();
    });
    const rawTmux = (p: ProjectConfig): RawTmux =>
      tmuxAll.get(p.id) ?? (p.tmuxSession ? { ...NO_TMUX, configured: true, attachCommand: attachCommand(p.tmuxSession), ...(tmuxError ? { error: tmuxError } : {}) } : NO_TMUX);
    await Promise.all(
      config.projects.map(async (p) => {
        try {
          this.collected.set(p.id, await this.collectOne(p, rawTmux(p), nowIso));
        } catch (e) {
          // 한 프로젝트의 수집 실패가 나머지를 막지 않게 오류 상태로 표시만 한다.
          this.collected.set(p.id, {
            git: { ...EMPTY_GIT, error: `수집 실패: ${(e as Error).message}` },
            since: null,
            lastGitChangeAt: null,
            tmux: { ...NO_TMUX, lastOutputChangeAt: null },
            logErrors: [],
          });
        }
      }),
    );
    this.publish();
  }

  private async collectOne(p: ProjectConfig, raw: RawTmux, nowIso: string): Promise<Collected> {
    const tr = this.tracked.get(p.id) ?? { baseline: null, fingerprint: null, gitChangedAt: null, output: null, outputChangedAt: null };
    this.tracked.set(p.id, tr);

    const [git, logErrors] = await Promise.all([this.opts.collector.git(p), this.opts.collector.logErrors(p)]);
    let since: SinceBaseline | null = null;
    if (git.ok) {
      tr.baseline ??= { at: nowIso, branch: git.branch, head: git.head };
      since = await this.opts.collector.since(p, tr.baseline);
      // working tree 지문이 이전 폴링과 달라졌으면 Git 활동으로 본다.
      const fingerprint = JSON.stringify([git.head, git.branch, git.changedFiles, git.diffStat]);
      if (tr.fingerprint !== null && fingerprint !== tr.fingerprint) tr.gitChangedAt = nowIso;
      tr.fingerprint = fingerprint;
    }

    let lastOutputChangeAt: string | null = null;
    if (raw.exists) {
      const text = raw.output.join('\n');
      if (tr.output !== null && text !== tr.output) tr.outputChangedAt = nowIso;
      tr.output = text;
      // 최초 관측 시에는 비교 대상이 없으므로 tmux 가 보고한 활동 시각을 쓴다.
      lastOutputChangeAt = latest(tr.outputChangedAt, raw.lastActivityAt);
    } else {
      tr.output = null;
      tr.outputChangedAt = null;
    }

    return {
      git,
      since,
      lastGitChangeAt: latest(git.recentCommits[0]?.date ?? null, tr.gitChangedAt),
      tmux: { ...raw, lastOutputChangeAt },
      logErrors,
    };
  }

  /** 수집해 둔 데이터로 상태를 다시 판정해 구독자에게 알린다 (test/build 실행 상태가 바뀔 때도 호출). */
  publish(): void {
    this.snapshot = this.build();
    for (const fn of this.listeners) fn(this.snapshot);
  }

  private build(): Snapshot {
    const { config } = this.opts;
    const now = this.now();
    const projects: ProjectSnapshot[] = config.projects.flatMap((p) => {
      const c = this.collected.get(p.id);
      if (!c) return [];
      const runs = this.opts.runs(p.id);
      const status = judge({ ...c, runs, thresholds: config.thresholds, sessionExitIsError: config.sessionExitIsError, now });
      return [{ ...p, ...c, runs, status }];
    });
    const count = (state: string) => projects.filter((p) => p.status.state === state).length;
    return {
      generatedAt: new Date(now).toISOString(),
      startedAt: this.startedAt,
      demo: this.opts.demo ?? false,
      refreshIntervalSec: config.refreshIntervalSec,
      configPath: this.opts.configPath ?? '',
      configMissing: this.opts.configMissing ?? false,
      summary: {
        total: projects.length,
        sessionsRunning: projects.filter((p) => p.tmux.exists).length,
        running: count('running'),
        idle: count('idle'),
        stalled: count('stalled'),
        error: count('error'),
      },
      projects,
    };
  }

  subscribe(fn: (s: Snapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 이전 tick 이 끝난 뒤에 다음 tick 을 예약하므로 느린 수집이 겹치지 않는다. */
  start(): void {
    const loop = () => {
      this.timer = setTimeout(() => void this.tick().then(loop), this.opts.config.refreshIntervalSec * 1000);
    };
    loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

const EMPTY_GIT: GitInfo = {
  ok: false,
  branch: '',
  head: null,
  clean: true,
  changedFiles: [],
  diffStat: [],
  additions: 0,
  deletions: 0,
  recentCommits: [],
  todayCommits: [],
};
