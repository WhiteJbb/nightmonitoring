// child_process 를 쓰는 유일한 모듈. 다른 서버 코드는 반드시 여기를 거친다.
import { execFile, spawn } from 'node:child_process';

const ALLOWED_BINS = ['git', 'tmux'] as const;
export type Bin = (typeof ALLOWED_BINS)[number];

export interface ExecResult {
  /** 프로세스를 띄우지 못했거나 시그널로 죽었으면 null */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * git/tmux 를 셸 없이 실행한다 (execFile → 인자는 argv 로 그대로 전달, escaping 불필요).
 * 절대 throw 하지 않는다.
 */
export function run(bin: Bin, args: string[], timeoutMs = 10_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    if (!ALLOWED_BINS.includes(bin) || args.some((a) => a.includes('\0'))) {
      return resolve({ code: null, stdout: '', stderr: `허용되지 않은 명령: ${bin}`, timedOut: false });
    }
    execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT,
        encoding: 'utf8',
        // 감시가 에이전트의 git 작업과 index.lock 을 다투지 않게 한다.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr, timedOut: false });
        resolve({
          code: typeof err.code === 'number' ? err.code : null,
          stdout,
          stderr: stderr || err.message,
          timedOut: err.killed === true,
        });
      },
    );
  });
}

export type ConfiguredExec = (command: string, cwd: string, timeoutMs: number) => Promise<ExecResult>;

const MAX_RUN_OUTPUT = 1024 * 1024;

/**
 * config 에 등록된 test/build 명령 전용. command 는 config 파일에서만 와야 한다
 * (호출부는 runner.ts 하나). 셸로 실행하고, 시간 초과 시 프로세스 그룹째 종료한다.
 */
export const runConfigured: ConfiguredExec = (command, cwd, timeoutMs) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(command, { cwd, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: null, stdout, stderr: (e as Error).message, timedOut });
    }
    // 출력이 상한을 넘으면 마지막 부분만 남긴다.
    const keepTail = (s: string) => (s.length > MAX_RUN_OUTPUT ? s.slice(-MAX_RUN_OUTPUT) : s);
    child.stdout.on('data', (d: Buffer) => (stdout = keepTail(stdout + d.toString('utf8'))));
    child.stderr.on('data', (d: Buffer) => (stderr = keepTail(stderr + d.toString('utf8'))));
    const pid = child.pid;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (pid) process.kill(-pid, 'SIGKILL');
      } catch {
        // 이미 종료됨
      }
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + e.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
