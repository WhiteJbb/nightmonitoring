import type { TmuxPane } from '../shared/types.ts';
import { run } from './exec.ts';
import { keepSgr, stripAnsi } from './logs.ts';

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

export type PaneMeta = Omit<TmuxPane, 'lines'> & { height: number };

export const OUTPUT_LINES = 100;
export const MAX_PANES = 8;

// session_activity 는 키 입력 위주라, pane 출력으로 갱신되는 window_activity 와 함께 본다.
const LIST_FORMAT = '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_activity}\t#{window_activity}';
// window_name 은 임의 문자열이라 맨 뒤에 둔다.
const PANE_FORMAT = '#{session_name}\t#{pane_id}\t#{window_index}\t#{pane_index}\t#{pane_current_command}\t#{pane_active}\t#{window_active}\t#{pane_height}\t#{window_name}';
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

/** 세션 이름 → pane 목록 (활성 pane 이 맨 앞, 세션당 최대 MAX_PANES 개). */
export function parsePanes(out: string): Map<string, PaneMeta[]> {
  const bySession = new Map<string, PaneMeta[]>();
  for (const line of out.split('\n')) {
    const [session, id, window, index, command, paneActive, windowActive, height, ...name] = line.split('\t');
    if (!session || !id || !/^%\d+$/.test(id)) continue;
    const pane: PaneMeta = {
      id,
      window: Number(window) || 0,
      windowName: name.join('\t'),
      index: Number(index) || 0,
      command: command ?? '',
      active: paneActive === '1' && windowActive === '1',
      height: Number(height) || 0,
    };
    const list = bySession.get(session) ?? [];
    bySession.set(session, list);
    list.push(pane);
  }
  for (const [session, list] of bySession) {
    list.sort((a, b) => Number(b.active) - Number(a.active) || a.window - b.window || a.index - b.index);
    bySession.set(session, list.slice(0, MAX_PANES));
  }
  return bySession;
}

export async function listPanes(): Promise<Map<string, PaneMeta[]>> {
  const r = await run('tmux', ['list-panes', '-a', '-F', PANE_FORMAT]);
  return r.code === 0 ? parsePanes(r.stdout) : new Map();
}

/** SGR 만 남긴 줄들. 끝의 빈 줄을 버리고 최근 OUTPUT_LINES 줄만 남긴다. */
export function cleanOutput(out: string): string[] {
  const lines = keepSgr(out)
    .split('\n')
    .map((l) => l.trimEnd());
  while (lines.length && stripAnsi(lines[lines.length - 1]!).trim() === '') lines.pop();
  return lines.slice(-OUTPUT_LINES);
}

/** pane 의 최근 출력을 색상(SGR) 포함으로 가져온다. 실패하면 빈 배열. */
export async function capturePane(pane: Pick<PaneMeta, 'id' | 'height'>): Promise<string[]> {
  // 스크롤백 + 화면을 합쳐 OUTPUT_LINES 줄이 되게 시작 줄을 잡는다 (화면이 더 크면 화면 아래쪽만).
  const start = pane.height - OUTPUT_LINES;
  const r = await run('tmux', ['-u', 'capture-pane', '-p', '-e', '-J', '-t', pane.id, '-S', String(start)]);
  return r.code === 0 ? cleanOutput(r.stdout) : [];
}
