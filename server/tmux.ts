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
const PANE_FORMAT = '#{session_name}\t#{pane_id}\t#{window_index}\t#{pane_index}\t#{pane_current_command}\t#{pane_active}\t#{window_active}\t#{pane_height}\t#{pane_width}\t#{pane_current_path}\t#{window_name}';
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
  if (r.code === 0) {
    const sessions = parseSessions(r.stdout);
    // session_attached 는 우리 터미널 스트림의 컨트롤 클라이언트도 센다. 사람이 붙인 터미널만 attached 로 친다
    const c = await run('tmux', ['list-clients', '-F', '#{client_session}\t#{client_control_mode}']);
    if (c.code === 0) {
      const human = new Set(c.stdout.split('\n').filter((l) => l.endsWith('\t0')).map((l) => l.split('\t')[0]));
      for (const [name, s] of sessions) s.attached = human.has(name);
    }
    return { sessions };
  }
  // code 1 = tmux 서버가 안 떠 있음 (세션 0개). null = tmux 실행 자체가 실패.
  if (r.code === null) return { sessions: new Map(), error: `tmux 를 실행할 수 없습니다: ${r.stderr.trim()}` };
  return { sessions: new Map() };
}

/** 세션 이름 → pane 목록 (활성 pane 이 맨 앞, 세션당 최대 MAX_PANES 개). */
export function parsePanes(out: string): Map<string, PaneMeta[]> {
  const bySession = new Map<string, PaneMeta[]>();
  for (const line of out.split('\n')) {
    const [session, id, window, index, command, paneActive, windowActive, height, width, cwd, ...name] = line.split('\t');
    if (!session || !id || !/^%\d+$/.test(id)) continue;
    const pane: PaneMeta = {
      id,
      window: Number(window) || 0,
      windowName: name.join('\t'),
      index: Number(index) || 0,
      command: command ?? '',
      active: paneActive === '1' && windowActive === '1',
      height: Number(height) || 0,
      cols: Number(width) || 0,
      cwd: cwd ?? '',
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
  if (r.code !== 0) return new Map();
  const panes = parsePanes(r.stdout);
  await nameScriptAgents([...panes.values()].flat());
  return panes;
}

/** ps 출력에서 tty 의 전면 프로세스 명령줄 중 에이전트 이름(codex·claude)을 찾는다 */
export function agentOnTty(ps: string, tty: string): string | null {
  for (const line of ps.split('\n')) {
    const [t, stat, ...args] = line.trim().split(/\s+/);
    if (t !== tty || !stat?.includes('+')) continue;
    const m = /\b(codex|claude)\b/i.exec(args.join(' '));
    if (m) return m[1]!.toLowerCase();
  }
  return null;
}

/**
 * Codex 처럼 node 로 도는 에이전트는 tmux 가 명령 이름을 'node' 로만 알려 준다.
 * 그런 pane 만 골라 그 tty 의 전면 프로세스 명령줄로 진짜 이름을 찾는다 (없으면 그대로 둔다).
 */
async function nameScriptAgents(panes: PaneMeta[]): Promise<void> {
  const nodes = panes.filter((p) => p.command === 'node');
  if (!nodes.length) return;
  const [ttys, ps] = await Promise.all([run('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_tty}']), run('ps', ['-A', '-o', 'tty=,stat=,args='])]);
  if (ttys.code !== 0 || ps.code !== 0) return;
  const ttyOf = new Map(ttys.stdout.split('\n').map((l) => l.split(' ') as [string, string | undefined]));
  for (const p of nodes) {
    const tty = ttyOf.get(p.id)?.replace('/dev/', '');
    const name = tty ? agentOnTty(ps.stdout, tty) : null;
    if (name) p.command = name;
  }
}

/** SGR 만 남긴 줄들. 끝의 빈 줄을 버리고 최근 limit 줄만 남긴다. */
export function cleanOutput(out: string, limit = OUTPUT_LINES): string[] {
  const lines = keepSgr(out)
    .split('\n')
    .map((l) => l.trimEnd());
  while (lines.length && stripAnsi(lines[lines.length - 1]!).trim() === '') lines.pop();
  return lines.slice(-limit);
}

/** pane 의 최근 출력을 색상(SGR) 포함으로 가져온다. 실패하면 빈 배열. */
export async function capturePane(pane: Pick<PaneMeta, 'id' | 'height'>, lines = OUTPUT_LINES): Promise<string[]> {
  // 스크롤백 + 화면을 합쳐 lines 줄이 되게 시작 줄을 잡는다 (화면이 더 크면 화면 아래쪽만).
  const start = pane.height - lines;
  const r = await run('tmux', ['-u', 'capture-pane', '-p', '-e', '-J', '-t', pane.id, '-S', String(start)]);
  return r.code === 0 ? cleanOutput(r.stdout, lines) : [];
}

/** tmux 는 인자 끝의 ';' 를 명령 구분자로 먹는다 (-l 이나 -- 뒤라도). '\;' 로 쓰면 글자 ';' 가 된다. */
const tmuxArg = (s: string) => (s.endsWith(';') ? `${s.slice(0, -1)}\\;` : s);

/**
 * pane 에 글자를 그대로 입력한다. -l 로 키 이름 해석을 끄고, -- 로 옵션 해석을 막는다. 실패하면 오류 메시지.
 * 여러 줄은 붙여넣기(bracketed paste)로 넣는다. 키로 보내면 줄바꿈마다 Enter 가 눌리지만,
 * 붙여넣기는 프로그램이 글 안의 줄바꿈으로 받는다 (Claude Code·Codex 는 긴 글을 한 덩어리로 접어 보여 준다).
 */
export async function sendText(id: string, text: string): Promise<string | null> {
  const r = text.includes('\n') ? await paste(id, text) : await run('tmux', ['send-keys', '-t', id, '-l', '--', tmuxArg(text)]);
  return r.code === 0 ? null : r.stderr.trim() || 'tmux send-keys 실패';
}

// 탭 두 개가 동시에 보내도 섞이지 않게 요청마다 다른 버퍼를 쓴다.
let pasteSeq = 0;
async function paste(id: string, text: string) {
  const buffer = `nightshift-${process.pid}-${++pasteSeq}`;
  const set = await run('tmux', ['set-buffer', '-b', buffer, '--', tmuxArg(text)]);
  // -p: 프로그램이 bracketed paste 를 켰을 때만 괄호 코드를 붙인다. -d: 쓰고 나서 버퍼를 지운다.
  return set.code === 0 ? run('tmux', ['paste-buffer', '-p', '-d', '-b', buffer, '-t', id]) : set;
}

/** 터미널 에뮬레이터가 만든 바이트(키·마우스 보고)를 그대로 넣는다. -H 는 16진수 바이트를 키 해석 없이 보낸다. */
export async function sendRaw(id: string, bytes: Uint8Array): Promise<string | null> {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
  const r = await run('tmux', ['send-keys', '-t', id, '-H', ...hex]);
  return r.code === 0 ? null : r.stderr.trim() || 'tmux send-keys 실패';
}

/** pane 에 특수 키 하나를 보낸다. key 는 호출부가 허용 목록으로 검증한 값이어야 한다. */
export async function sendKey(id: string, key: string): Promise<string | null> {
  const r = await run('tmux', ['send-keys', '-t', id, key]);
  return r.code === 0 ? null : r.stderr.trim() || 'tmux send-keys 실패';
}

export interface TermSize {
  cols: number;
  rows: number;
}
export const DEFAULT_SIZE: TermSize = { cols: 120, rows: 40 };

/** 요청으로 받은 크기를 tmux 에 넘겨도 되는 범위의 정수로 만든다. 값이 없거나 이상하면 기본값. */
export function clampSize(cols: unknown, rows: unknown): TermSize {
  const int = (v: unknown, min: number, max: number, fallback: number) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return { cols: int(cols, 40, 300, DEFAULT_SIZE.cols), rows: int(rows, 10, 100, DEFAULT_SIZE.rows) };
}

/**
 * 디렉터리 cwd 에서 셸만 띄운 분리(detached) 세션을 만든다. 실행할 명령은 받지 않는다.
 * 같은 이름의 세션이 이미 있으면 아무것도 하지 않는다. 실패하면 오류 메시지.
 * name 은 호출부가 SESSION_RE 로 검증한 값이어야 한다.
 * size 는 붙어 있는 터미널이 없을 때의 화면 크기 (터미널이 붙으면 그 크기로 바뀐다).
 */
export async function newSession(name: string, cwd: string, size: TermSize = DEFAULT_SIZE): Promise<string | null> {
  if ((await run('tmux', ['has-session', '-t', `=${name}`])).code === 0) return null;
  const r = await run('tmux', ['new-session', '-d', '-s', name, '-c', cwd, '-x', String(size.cols), '-y', String(size.rows)]);
  return r.code === 0 ? null : r.stderr.trim() || 'tmux new-session 실패';
}

/**
 * 세션에 셸만 띄운 윈도우를 하나 더 만들고 그 pane id 를 돌려준다. 실행할 명령은 받지 않는다.
 * -d: 세션에 붙어 있는 터미널이 보던 윈도우는 그대로 둔다.
 */
export async function newWindow(session: string, cwd: string): Promise<{ pane: string } | { error: string }> {
  const r = await run('tmux', ['new-window', '-d', '-t', `=${session}:`, '-c', cwd, '-P', '-F', '#{pane_id}']);
  const pane = r.stdout.trim();
  return r.code === 0 && /^%\d+$/.test(pane) ? { pane } : { error: r.stderr.trim() || 'tmux new-window 실패' };
}

/** 세션의 첫 pane 에 한 줄을 치고 Enter (새 세션에서 에이전트를 띄울 때만 쓴다). 실패하면 오류 메시지 */
export async function typeLine(session: string, line: string): Promise<string | null> {
  const target = `=${session}:`;
  const r = await run('tmux', ['send-keys', '-t', target, '-l', line]);
  if (r.code !== 0) return r.stderr.trim() || 'tmux send-keys 실패';
  const e = await run('tmux', ['send-keys', '-t', target, 'Enter']);
  return e.code === 0 ? null : e.stderr.trim() || 'tmux send-keys 실패';
}

/** 세션을 끝낸다. 실패하면 오류 메시지 */
export async function killSession(session: string): Promise<string | null> {
  const r = await run('tmux', ['kill-session', '-t', `=${session}`]);
  return r.code === 0 ? null : r.stderr.trim() || 'tmux kill-session 실패';
}

export const hasSession = async (session: string) => (await run('tmux', ['has-session', '-t', `=${session}`])).code === 0;

/** pane 이 속한 윈도우의 크기를 바꾼다. 프로그램에는 터미널 크기 변경 신호만 간다. 실패하면 오류 메시지. */
export async function resizeWindow(paneId: string, size: TermSize): Promise<string | null> {
  const wh = `${size.cols}x${size.rows}`;
  // resize-window 는 window-size 를 manual 로 고정해 나중에 붙는 터미널 크기를 따라가지 않는다. 고정을 풀고,
  // 붙은 터미널이 없을 때의 크기(default-size)를 이 크기로 둬서 되돌아가지 않게 한다.
  for (const args of [['resize-window', '-t', paneId, '-x', String(size.cols), '-y', String(size.rows)], ['set-option', '-w', '-t', paneId, '-u', 'window-size'], ['set-option', '-t', paneId, 'default-size', wh]]) {
    const r = await run('tmux', args);
    if (r.code !== 0) return r.stderr.trim() || `tmux ${args[0]} 실패`;
  }
  return null;
}
