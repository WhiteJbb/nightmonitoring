import { run } from './exec.ts';
import { stripAnsi } from './logs.ts';

export interface TmuxSession {
  createdAt: string;
  attached: boolean;
  lastActivityAt: string;
}

export interface TmuxSessions {
  sessions: Map<string, TmuxSession>;
  /** tmux 자체를 실행할 수 없을 때 */
  error?: string;
}

export const OUTPUT_LINES = 100;

// session_activity 는 키 입력 위주라, pane 출력으로 갱신되는 window_activity 와 함께 본다.
const LIST_FORMAT = '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_activity}\t#{window_activity}';
const epochToIso = (s: string | undefined) => new Date(Number(s) * 1000).toISOString();

export function parseSessions(out: string): Map<string, TmuxSession> {
  const sessions = new Map<string, TmuxSession>();
  for (const line of out.split('\n')) {
    const [name, created, attached, activity, windowActivity] = line.split('\t');
    if (!name || !Number.isFinite(Number(created)) || !created) continue;
    sessions.set(name, {
      createdAt: epochToIso(created),
      attached: Number(attached) > 0,
      lastActivityAt: epochToIso(String(Math.max(Number(activity) || 0, Number(windowActivity) || 0) || created)),
    });
  }
  return sessions;
}

export async function listSessions(): Promise<TmuxSessions> {
  const r = await run('tmux', ['list-sessions', '-F', LIST_FORMAT]);
  if (r.code === 0) return { sessions: parseSessions(r.stdout) };
  // code 1 = tmux 서버가 안 떠 있음 (세션 0개). null = tmux 실행 자체가 실패.
  if (r.code === null) return { sessions: new Map(), error: `tmux 를 실행할 수 없습니다: ${r.stderr.trim()}` };
  return { sessions: new Map() };
}

export function cleanOutput(out: string): string[] {
  const lines = stripAnsi(out)
    .split('\n')
    .map((l) => l.trimEnd());
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-OUTPUT_LINES);
}

/** 세션의 활성 pane 에서 최근 출력을 가져온다. 실패하면 빈 배열. */
export async function capturePane(session: string): Promise<string[]> {
  // "=name:" 은 접두사 매칭이 아닌 정확한 세션 이름 매칭.
  const r = await run('tmux', ['-u', 'capture-pane', '-p', '-J', '-t', `=${session}:`, '-S', `-${OUTPUT_LINES}`]);
  return r.code === 0 ? cleanOutput(r.stdout) : [];
}
