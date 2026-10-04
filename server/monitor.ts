import type { GitBaseline, GitInfo, ProjectSnapshot, RunKind, RunResult, RunSummary, SinceBaseline, Snapshot, TmuxInfo } from '../shared/types.ts';
import type { Config, ProjectConfig } from './config.ts';
import { collectGit, collectSince } from './git.ts';
import type { LogScan } from './logs.ts';
import { findPrompt, scanLog, stripAnsi, stripVolatile } from './logs.ts';
import type { MonitorState } from './state.ts';
import { judge } from './status.ts';
import { capturePane, listPanes, listSessions } from './tmux.ts';

export type RawTmux = Omit<TmuxInfo, 'lastOutputChangeAt'>;

/** Monitor 가 데이터를 얻는 유일한 통로. 실제 구현과 demo 구현이 있다. */
export interface Collector {
  git(p: ProjectConfig): Promise<GitInfo>;
  since(p: ProjectConfig, baseline: GitBaseline, git: GitInfo): Promise<SinceBaseline>;
  tmux(projects: ProjectConfig[]): Promise<Map<string, RawTmux>>;
  /** offset 이후의 로그만 검사한다. null 이면 현재 크기만 잰다. */
  logErrors(p: ProjectConfig, offset: number | null): Promise<LogScan>;
}

/** 복사해서 붙여 넣을 명령이므로 셸에 안전하게 인용한다. */
export function attachCommand(session: string): string {
  const quoted = /^[\w@+-]+$/.test(session) ? session : `'${session.replace(/'/g, `'\\''`)}'`;
  return `tmux attach -t ${quoted}`;
}

const NO_TMUX: RawTmux = { configured: false, exists: false, createdAt: null, attached: false, lastActivityAt: null, output: [], panes: [], waitingPrompt: null, attachCommand: null };

export function realCollector(config: Config): Collector {
  return {
    git: (p) => collectGit(p.repoPath),
    since: (p, baseline, git) => collectSince(p.repoPath, baseline, git),
    logErrors: (p, offset) => (p.logFile ? scanLog(p.logFile, config.errorPatterns, config.errorIgnorePatterns, offset) : Promise.resolve({ errors: [], size: 0 })),
    async tmux(projects) {
      const [{ sessions, error }, panesBySession] = await Promise.all([listSessions(), listPanes()]);
      const out = new Map<string, RawTmux>();
      await Promise.all(
        projects.map(async (p) => {
          const name = p.tmuxSession;
          if (!name) return;
          const s = sessions.get(name);
          const panes = s
            ? await Promise.all((panesBySession.get(name) ?? []).map(async ({ height, ...meta }) => ({ ...meta, lines: await capturePane({ id: meta.id, height }) })))
            : [];
          out.set(p.id, {
            configured: true,
            exists: !!s,
            createdAt: s?.createdAt ?? null,
            attached: s?.attached ?? false,
            lastActivityAt: s?.lastActivityAt ?? null,
            output: (panes.find((x) => x.active) ?? panes[0])?.lines.map(stripAnsi) ?? [],
            panes,
            waitingPrompt: null,
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
  /** 이 위치 이후의 로그만 오류 검사 대상. null = 아직 관측 전 */
  logOffset: number | null;
  logSize: number;
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
  history?: (projectId: string) => Record<RunKind, RunSummary[]>;
  demo?: boolean;
  configPath?: string;
  configMissing?: boolean;
  now?: () => number;
  /** 이전 실행에서 저장한 상태. 있으면 모니터링 세션을 이어 간다. */
  restore?: MonitorState | null;
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
    this.startedAt = opts.restore?.startedAt ?? new Date(this.now()).toISOString();
    for (const p of opts.config.projects) {
      const saved = opts.restore?.tracked[p.id];
      if (saved?.repoPath === p.repoPath) this.tracked.set(p.id, { ...newTracked(), baseline: saved.baseline, gitChangedAt: saved.gitChangedAt, logOffset: saved.logOffset });
    }
    this.snapshot = this.build();
  }

  /** 디스크에 저장할 상태 (기준점, 변경 시각, 로그 위치). */
  exportState(): MonitorState {
    const tracked: MonitorState['tracked'] = {};
    for (const p of this.opts.config.projects) {
      const tr = this.tracked.get(p.id);
      if (tr) tracked[p.id] = { repoPath: p.repoPath, baseline: tr.baseline, gitChangedAt: tr.gitChangedAt, logOffset: tr.logOffset };
    }
    return { startedAt: this.startedAt, tracked };
  }

  /** 새 모니터링 세션: 기준점을 버리고 지금부터 다시 센다. */
  async reset(): Promise<void> {
    this.tracked.clear();
    this.startedAt = new Date(this.now()).toISOString();
    await this.tick();
  }

  /** 지금까지의 로그 오류를 확인 처리한다. 이후에 추가되는 줄만 다시 검사한다. */
  ackErrors(projectId: string): boolean {
    const tr = this.tracked.get(projectId);
    const c = this.collected.get(projectId);
    if (!tr || !c) return false;
    tr.logOffset = tr.logSize;
    c.logErrors = [];
    this.publish();
    return true;
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
    const tr = this.tracked.get(p.id) ?? newTracked();
    this.tracked.set(p.id, tr);

    const [git, log] = await Promise.all([this.opts.collector.git(p), this.opts.collector.logErrors(p, tr.logOffset)]);
    // 최초 관측 이전의 로그 내용은 검사하지 않는다. 파일이 줄어들면(rotate) 처음부터 다시 본다.
    if (tr.logOffset === null || log.size < tr.logOffset) tr.logOffset = tr.logOffset === null ? log.size : 0;
    tr.logSize = log.size;
    let since: SinceBaseline | null = null;
    if (git.ok) {
      tr.baseline ??= { at: nowIso, branch: git.branch, head: git.head };
      since = await this.opts.collector.since(p, tr.baseline, git);
      // working tree 지문이 이전 폴링과 달라졌으면 Git 활동으로 본다.
      if (tr.fingerprint !== null && git.fingerprint !== tr.fingerprint) tr.gitChangedAt = nowIso;
      tr.fingerprint = git.fingerprint;
    }

    let lastOutputChangeAt: string | null = null;
    let waitingPrompt: string | null = null;
    if (raw.exists) {
      // 어느 pane 이든 출력이 바뀌면 활동이다. pane 정보가 없으면 활성 pane 출력만 본다.
      const plain = raw.panes.length ? raw.panes.map((pane) => pane.lines.map(stripAnsi)) : [raw.output];
      const joined = plain.map((lines) => lines.join('\n')).join('\f');
      const text = this.opts.config.ignoreSpinnerChanges ? stripVolatile(joined) : joined;
      for (const lines of plain) waitingPrompt ??= findPrompt(lines, this.opts.config.promptPatterns);
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
      tmux: { ...raw, lastOutputChangeAt, waitingPrompt },
      logErrors: log.errors,
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
      return [{ ...p, ...c, runs, history: this.opts.history?.(p.id) ?? { test: [], build: [] }, status }];
    });
    const count = (state: string) => projects.filter((p) => p.status.state === state).length;
    return {
      generatedAt: new Date(now).toISOString(),
      startedAt: this.startedAt,
      demo: this.opts.demo ?? false,
      refreshIntervalSec: config.refreshIntervalSec,
      configPath: this.opts.configPath ?? '',
      configMissing: this.opts.configMissing ?? false,
      configError: null,
      autoReportTime: null,
      summary: {
        total: projects.length,
        sessionsRunning: projects.filter((p) => p.tmux.exists).length,
        running: count('running'),
        waiting: count('waiting'),
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

const newTracked = (): Tracked => ({ baseline: null, fingerprint: null, gitChangedAt: null, logOffset: null, logSize: 0, output: null, outputChangedAt: null });

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
  fingerprint: '',
};
