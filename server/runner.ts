import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunKind, RunResult } from '../shared/types.ts';
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

/** config 에 등록된 test/build 명령만 실행한다. 명령 문자열을 외부에서 받는 경로는 없다. */
export class Runner {
  onChange: () => void = () => {};
  private opts: RunnerOptions;
  private results = new Map<string, Record<RunKind, RunResult | null>>();

  constructor(opts: RunnerOptions) {
    this.opts = opts;
  }

  get = (projectId: string): Record<RunKind, RunResult | null> => {
    let r = this.results.get(projectId);
    if (!r) this.results.set(projectId, (r = { test: null, build: null }));
    return r;
  };

  seed(projectId: string, result: RunResult): void {
    this.get(projectId)[result.kind] = result;
  }

  start(project: ProjectConfig, kind: RunKind): StartOutcome {
    const command = kind === 'test' ? project.testCommand : project.buildCommand;
    if (!command) return 'no-command';
    const runs = this.get(project.id);
    if (runs[kind]?.running) return 'already-running';

    const started = Date.now();
    const base = { kind, command, startedAt: new Date(started).toISOString() };
    runs[kind] = { ...base, running: true, finishedAt: null, exitCode: null, timedOut: false, durationMs: null, stdout: '', stderr: '' };
    this.onChange();

    const exec = this.opts.exec ?? runConfigured;
    void exec(command, project.repoPath, this.opts.timeoutSec * 1000)
      .catch((e: Error) => ({ code: null, stdout: '', stderr: e.message, timedOut: false }))
      .then(async (r) => {
        const finished = Date.now();
        runs[kind] = {
          ...base,
          running: false,
          finishedAt: new Date(finished).toISOString(),
          exitCode: r.code,
          timedOut: r.timedOut,
          durationMs: finished - started,
          stdout: r.stdout,
          stderr: r.stderr,
        };
        await this.saveLogs(project.id, kind, r.stdout, r.stderr);
        this.onChange();
      });
    return 'started';
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
