import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunKind, RunResult, RunSummary } from '../shared/types.ts';
import type { ProjectConfig } from './config.ts';
import type { ConfiguredExec } from './exec.ts';
import { runConfigured } from './exec.ts';

export type StartOutcome = 'started' | 'no-command' | 'already-running';

export interface RunnerOptions {
  timeoutSec: number;
  /** stdout/stderr 를 파일로 남길 디렉터리. null 이면 메모리에만 둔다. */
  logDir: string | null;
  exec?: ConfiguredExec;
}

/** 재시작 후 복원할 수 있게 디스크에 저장하는 형태 */
export interface RunnerState {
  results: Record<string, Record<RunKind, RunResult | null>>;
  history: Record<string, Record<RunKind, RunSummary[]>>;
}

export const MAX_HISTORY = 20;
const PERSIST_OUTPUT_BYTES = 64 * 1024;

/** config 에 등록된 test/build 명령만 실행한다. 명령 문자열을 외부에서 받는 경로는 없다. */
export class Runner {
  onChange: () => void = () => {};
  timeoutSec: number;
  private opts: RunnerOptions;
  private results = new Map<string, Record<RunKind, RunResult | null>>();
  private histories = new Map<string, Record<RunKind, RunSummary[]>>();
  private controllers = new Map<string, AbortController>();

  constructor(opts: RunnerOptions) {
    this.opts = opts;
    this.timeoutSec = opts.timeoutSec;
  }

  get = (projectId: string): Record<RunKind, RunResult | null> => {
    let r = this.results.get(projectId);
    if (!r) this.results.set(projectId, (r = { test: null, build: null }));
    return r;
  };

  /** 끝난 실행의 이력, 최신순. */
  history = (projectId: string): Record<RunKind, RunSummary[]> => {
    let h = this.histories.get(projectId);
    if (!h) this.histories.set(projectId, (h = { test: [], build: [] }));
    return h;
  };

  /** 끝난 결과를 최신 결과이자 이력으로 기록한다 (demo 시드, 내부 완료 처리 공용). */
  seed(projectId: string, result: RunResult): void {
    this.get(projectId)[result.kind] = result;
    if (result.running) return;
    const { startedAt, finishedAt, exitCode, timedOut, canceled, durationMs } = result;
    const list = this.history(projectId)[result.kind];
    list.unshift({ startedAt, finishedAt, exitCode, timedOut, canceled, durationMs });
    list.length = Math.min(list.length, MAX_HISTORY);
  }

  start(project: ProjectConfig, kind: RunKind): StartOutcome {
    const command = kind === 'test' ? project.testCommand : project.buildCommand;
    if (!command) return 'no-command';
    const runs = this.get(project.id);
    if (runs[kind]?.running) return 'already-running';

    const started = Date.now();
    const base = { kind, command, startedAt: new Date(started).toISOString() };
    runs[kind] = { ...base, running: true, finishedAt: null, exitCode: null, timedOut: false, canceled: false, durationMs: null, stdout: '', stderr: '' };
    const key = `${project.id}\0${kind}`;
    const controller = new AbortController();
    this.controllers.set(key, controller);
    this.onChange();

    const exec = this.opts.exec ?? runConfigured;
    void exec(command, project.repoPath, this.timeoutSec * 1000, controller.signal)
      .catch((e: Error) => ({ code: null, stdout: '', stderr: e.message, timedOut: false }))
      .then(async (r) => {
        const finished = Date.now();
        this.controllers.delete(key);
        this.seed(project.id, {
          ...base,
          running: false,
          finishedAt: new Date(finished).toISOString(),
          exitCode: r.code,
          timedOut: r.timedOut,
          canceled: controller.signal.aborted,
          durationMs: finished - started,
          stdout: r.stdout,
          stderr: r.stderr,
        });
        await this.saveLogs(project.id, kind, r.stdout, r.stderr);
        this.onChange();
      });
    return 'started';
  }

  /** 실행 중이면 중단시키고 true. 결과는 canceled 로 기록된다. */
  cancel(projectId: string, kind: RunKind): boolean {
    const controller = this.controllers.get(`${projectId}\0${kind}`);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** 서버 종료 시 남은 자식 프로세스를 정리한다. */
  cancelAll(): void {
    for (const c of this.controllers.values()) c.abort();
  }

  exportState(): RunnerState {
    const tail = (s: string) => (s.length > PERSIST_OUTPUT_BYTES ? s.slice(-PERSIST_OUTPUT_BYTES) : s);
    const results: RunnerState['results'] = {};
    for (const [id, runs] of this.results) {
      const slim = (r: RunResult | null) => (r ? { ...r, stdout: tail(r.stdout), stderr: tail(r.stderr) } : null);
      results[id] = { test: slim(runs.test), build: slim(runs.build) };
    }
    return { results, history: Object.fromEntries(this.histories) };
  }

  /** 저장된 상태를 복원한다. 저장 당시 실행 중이던 것은 재시작으로 중단된 것으로 기록한다. */
  restore(state: RunnerState): void {
    for (const [id, h] of Object.entries(state.history ?? {})) this.histories.set(id, { test: h.test ?? [], build: h.build ?? [] });
    for (const [id, runs] of Object.entries(state.results ?? {})) {
      for (const kind of ['test', 'build'] as const) {
        const r = runs[kind];
        if (!r) continue;
        if (!r.running) this.get(id)[kind] = r;
        else this.seed(id, { ...r, running: false, canceled: true, finishedAt: r.startedAt, stderr: `${r.stderr}\n[NightShift] 서버 재시작으로 중단됨`.trimStart() });
      }
    }
  }

  private async saveLogs(id: string, kind: RunKind, stdout: string, stderr: string): Promise<void> {
    const dir = this.opts.logDir;
    if (!dir) return;
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${id}-${kind}.stdout.log`), stdout);
      await writeFile(path.join(dir, `${id}-${kind}.stderr.log`), stderr);
    } catch (e) {
      console.error(`실행 로그 저장 실패: ${(e as Error).message}`);
    }
  }
}
