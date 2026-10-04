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

/** 지금 이 순간의 pane 출력 (폴링 주기를 기다리지 않는 실시간 보기용). */
export async function capturePaneNow(id: string): Promise<string[]> {
  const h = await run('tmux', ['display-message', '-p', '-t', id, '#{pane_height}']);
  return capturePane({ id, height: Number(h.stdout.trim()) || 0 });
}

/** pane 에 글자를 그대로 입력한다. -l 로 키 이름 해석을 끄고, -- 로 옵션 해석을 막는다. 실패하면 오류 메시지. */
export async function sendText(id: string, text: string): Promise<string | null> {
  const r = await run('tmux', ['send-keys', '-t', id, '-l', '--', text]);
  return r.code === 0 ? null : r.stderr.trim() || 'tmux send-keys 실패';
}

/** pane 에 특수 키 하나를 보낸다. key 는 호출부가 허용 목록으로 검증한 값이어야 한다. */
export async function sendKey(id: string, key: string): Promise<string | null> {
  const r = await run('tmux', ['send-keys', '-t', id, key]);
  return r.code === 0 ? null : r.stderr.trim() || 'tmux send-keys 실패';
}

/**
 * 디렉터리 cwd 에서 셸만 띄운 분리(detached) 세션을 만든다. 실행할 명령은 받지 않는다.
 * 같은 이름의 세션이 이미 있으면 아무것도 하지 않는다. 실패하면 오류 메시지.
 * name 은 호출부가 SESSION_RE 로 검증한 값이어야 한다.
 */
export async function newSession(name: string, cwd: string): Promise<string | null> {
  if ((await run('tmux', ['has-session', '-t', `=${name}`])).code === 0) return null;
  // 붙어 있는 클라이언트가 없을 때의 화면 크기. 붙으면 그 터미널 크기로 바뀐다.
  const r = await run('tmux', ['new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50']);
  return r.code === 0 ? null : r.stderr.trim() || 'tmux new-session 실패';
}
