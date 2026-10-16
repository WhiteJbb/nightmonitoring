import { useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, KeyboardEvent } from 'react';
import type { Commit, FileStat, InputKey, InputRequest, ProjectSnapshot, ProjectState, RunKind, RunResult, RunSummary, TmuxPane } from '../../shared/types.ts';
import { NOT_A_REPO } from '../../shared/types.ts';
import { StartSession } from './NewSession.tsx';
import { fitSize } from './termsize.ts';
import { Term } from './Term.tsx';
import type { TermStatus } from './Term.tsx';
import { api, errorMessage } from './api.ts';
import { dateTime, duration, relTime, STATE_LABEL } from './format.ts';

export function Badge({ state }: { state: ProjectState }) {
  return <span className={`badge state-${state}`}>{STATE_LABEL[state]}</span>;
}

export function Reasons({ reasons }: { reasons: string[] }) {
  if (reasons.length === 0) return null;
  return (
    <ul className="reasons">
      {reasons.map((r, i) => (
        <li key={i}>{r}</li>
      ))}
    </ul>
  );
}

const TABS = [
  ['terminal', '터미널'],
  ['git', 'Git'],
  ['runs', '테스트·빌드'],
] as const;
type Tab = (typeof TABS)[number][0];
const TAB_IDS = TABS.map(([id]) => id);
// 고른 탭은 주소에 남긴다: #/project/<id>/<탭>. 새로고침·뒤로 가기에도 그대로다
const hashTab = (): Tab => TAB_IDS.find((id) => id === window.location.hash.split('/')[3]) ?? 'terminal';

interface Props {
  project: ProjectSnapshot;
  now: string;
  /** 스냅샷 갱신 주기(초). 실시간 보기가 안 될 때의 표시에 쓴다 */
  refreshSec?: number;
}

const failed = (r: RunResult | null) => r !== null && !r.running && (r.timedOut || (!r.canceled && r.exitCode !== 0));

export function ProjectDetail({ project: p, now, refreshSec }: Props) {
  const [tab, setTabState] = useState<Tab>(hashTab);
  const setTab = (id: Tab) => {
    setTabState(id);
    // 탭마다 기록이 쌓이지 않게 지금 주소만 바꾼다
    history.replaceState(null, '', `#/project/${encodeURIComponent(p.id)}/${id}`);
  };
  // 화살표·Home·End 로 탭을 옮긴다. 고른 탭만 Tab 순서에 들어간다 (roving tabindex)
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TAB_IDS.indexOf(tab);
    const n = TAB_IDS.length;
    const next = ({ ArrowRight: (i + 1) % n, ArrowLeft: (i + n - 1) % n, Home: 0, End: n - 1 } as Record<string, number>)[e.key];
    if (next === undefined) return;
    e.preventDefault();
    setTab(TAB_IDS[next]!);
    document.getElementById(`tab-${TAB_IDS[next]}`)?.focus();
  };
  // 탭에 붙이는 오류 수: Git 은 로그 오류, 테스트·빌드는 마지막 실행이 실패한 것
  const counts: Record<Tab, number> = { terminal: 0, git: p.logErrors.length, runs: [p.runs.test, p.runs.build].filter(failed).length };
  return (
    <>
      <p className="crumb">
        <a href="#/">← 대시보드</a>
      </p>
      <div className="detail-head">
        <h1>{p.name}</h1>
        <Badge state={p.status.state} />
        {p.id.startsWith('tmux:') && <Register project={p} />}
      </div>
      <Reasons reasons={p.status.reasons} />
      <LogErrorsAck
        project={p}
        onShow={() => {
          setTab('git');
          setTimeout(() => document.getElementById('log-errors')?.scrollIntoView?.({ block: 'start' }));
        }}
      />
      <p className="mono dim wrap">{p.repoPath}</p>

      <div className="tabs" role="tablist" aria-label="프로젝트 정보" onKeyDown={onTabKey}>
        {TABS.map(([id, label]) => (
          <button key={id} id={`tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={tab === id ? `panel-${id}` : undefined} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}>
            {label}
            {counts[id] > 0 && (
              <span className="tab-count" title={`오류 ${counts[id]}건`}>
                {counts[id]}
              </span>
            )}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'terminal' && <TerminalTab project={p} now={now} refreshSec={refreshSec} />}
        {tab === 'git' && <GitTab project={p} now={now} />}
        {tab === 'runs' && (
          <>
            <p className="hint">명령은 설정 파일에서만 바꿀 수 있습니다.</p>
            <RunPanel project={p} kind="test" title="테스트" />
            <RunPanel project={p} kind="build" title="빌드" />
          </>
        )}
      </div>
    </>
  );
}

/** 설정에 없는 tmux 세션을 지금 경로로 프로젝트에 등록한다 (대시보드의 "등록"과 같은 요청). 등록되면 새 프로젝트 화면으로 옮긴다 */
function Register({ project: p }: { project: ProjectSnapshot }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = p.tmuxSession ?? p.name;
  const register = () => {
    setBusy(true);
    setError(null);
    api.createSession({ name: session, repoPath: p.repoPath, tmuxSession: session, allowInput: false }).then(
      ({ id }) => {
        window.location.hash = `#/project/${encodeURIComponent(id)}`;
      },
      (e: unknown) => {
        setError(errorMessage(e));
        setBusy(false);
      },
    );
  };
  return (
    <>
      <span className="dim" title="설정에 없는 tmux 세션. 세션이 닫히면 이 화면도 사라집니다">
        미등록
      </span>
      <button type="button" disabled={busy} onClick={register} title="이 세션을 지금 경로로 프로젝트에 등록합니다">
        {busy ? '등록하는 중…' : '프로젝트로 등록'}
      </button>
      {error && (
        <span className="err" role="alert">
          등록 실패: {error}
        </span>
      )}
    </>
  );
}

/** 로그 오류가 있으면 화면 위쪽에서 바로 보고 확인 처리한다 */
function LogErrorsAck({ project: p, onShow }: { project: ProjectSnapshot; onShow: () => void }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ack = () => {
    setBusy(true);
    setError(null);
    api
      .ackErrors(p.id)
      .then(
        () => {
          setDone(true);
          setTimeout(() => setDone(false), 4000);
        },
        (e: unknown) => setError(errorMessage(e)),
      )
      .finally(() => setBusy(false));
  };
  if (done) {
    return (
      <p className="ok" role="status">
        로그 오류 표시를 지웠습니다. 새 오류는 계속 감지합니다.
      </p>
    );
  }
  if (p.logErrors.length === 0) return null;
  return (
    <div className="notice error log-ack">
      <strong>로그에서 오류 {p.logErrors.length}건을 감지했습니다.</strong>
      <p className="mono wrap">{p.logErrors.at(-1)}</p>
      <div className="actions">
        <button type="button" onClick={onShow}>
          로그 보기
        </button>
        <button type="button" onClick={ack} disabled={busy}>
          로그 오류 확인 완료
        </button>
      </div>
      <p className="hint">지금까지 감지한 오류 표시를 지웁니다. 새 오류는 계속 감지합니다.</p>
      {error && (
        <p className="err" role="alert">
          확인 처리 실패: {error}
        </p>
      )}
    </div>
  );
}

// [tmux 키, 버튼 글자, 설명]
// 터치 화면에서는 이 키들만 늘 보이고 나머지는 "더보기" 뒤로 접힌다.
const PRIMARY_KEYS: InputKey[] = ['PPage', 'NPage', 'Up', 'Down', 'Escape'];
// 마우스 환경인지. 터치 화면에서는 입력 칸에 포커스를 주면 키보드가 올라와 화면을 가린다
const finePointer = () => typeof window.matchMedia !== 'function' || window.matchMedia('(pointer: fine)').matches;
const KEYS: [InputKey, string, string][] = [
  ['Enter', 'Enter', 'Enter 보내기'],
  ['Escape', 'Esc', 'Esc 보내기'],
  ['Tab', 'Tab', 'Tab 보내기'],
  ['BTab', '⇧Tab', 'Shift+Tab 보내기'],
  ['Up', '↑', '위 화살표 보내기'],
  ['Down', '↓', '아래 화살표 보내기'],
  ['Left', '←', '왼쪽 화살표 보내기'],
  ['Right', '→', '오른쪽 화살표 보내기'],
  // 전체 화면으로 도는 프로그램(Claude Code, less 등)은 스크롤백이 tmux 에 없어서, 프로그램 안에서 직접 넘겨야 한다
  ['PPage', 'PgUp', 'Page Up 보내기 (프로그램 안에서 위로)'],
  ['NPage', 'PgDn', 'Page Down 보내기 (프로그램 안에서 아래로)'],
  ['BSpace', '⌫', 'Backspace 보내기 (한 글자 지우기)'],
  ['C-c', 'Ctrl+C', 'Ctrl+C 보내기 (중단)'],
  ['C-d', 'Ctrl+D', 'Ctrl+D 보내기 (EOF·종료)'],
  ['C-u', 'Ctrl+U', 'Ctrl+U 보내기 (줄 지우기)'],
  ['C-l', 'Ctrl+L', 'Ctrl+L 보내기 (화면 지우기)'],
];
const CAUTION: InputKey[] = ['C-c', 'C-d'];

// 입력칸이 비어 있을 때 그대로 pane 으로 넘기는 키
const FORWARD: Record<string, InputKey> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Escape',
  Backspace: 'BSpace',
  PageUp: 'PPage',
  PageDown: 'NPage',
};
// 빈 입력칸에서 Ctrl 조합은 pane 으로 간다. 컴퓨터에선 키 버튼이 숨겨져 있어 이게 유일한 길이다
const CTRL: Record<string, InputKey> = { c: 'C-c', d: 'C-d', u: 'C-u', l: 'C-l' };

/** pane: 입력을 보낼 pane. 고른 pane 이 사라졌으면 null 이고, 다시 고를 때까지 보내지 않는다 */
function InputBar({ projectId, pane: target, showTarget }: { projectId: string; pane: TmuxPane | null; showTarget: boolean }) {
  const pane = target?.id ?? '';
  const [text, setText] = useState('');
  const [moreKeys, setMoreKeys] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 올리는 중인 이미지 수. 다 올라가 경로가 입력에 들어가기 전엔 프롬프트를 보내지 않는다
  const [uploading, setUploading] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 이미지는 서버에 파일로 저장하고 그 경로를 입력 칸에 넣는다. Claude Code·Codex 는 프롬프트 안의 이미지 경로를 첨부로 읽는다.
  const attach = (file: File | undefined) => {
    if (!file || !file.type.startsWith('image/')) return;
    setUploading((n) => n + 1);
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      api
        .upload(projectId, { type: file.type, data: String(reader.result).split(',')[1] ?? '' })
        .then(
          ({ path }) => {
            setText((cur) => `${cur.trimEnd()}${cur.trim() ? ' ' : ''}${path} `);
            inputRef.current?.focus();
          },
          (e: unknown) => setError(errorMessage(e)),
        )
        .finally(() => setUploading((n) => n - 1));
    };
    reader.onerror = () => {
      setError('이미지를 읽지 못했습니다');
      setUploading((n) => n - 1);
    };
    reader.readAsDataURL(file);
  };
  const imageOf = (files: FileList | undefined) => (files ? [...files].find((f) => f.type.startsWith('image/')) : undefined);
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const file = imageOf(e.clipboardData?.files);
    if (!file) return; // 글은 평소대로 붙는다
    e.preventDefault();
    attach(file);
  };
  const onDrop = (e: DragEvent<HTMLTextAreaElement>) => {
    const file = imageOf(e.dataTransfer?.files);
    if (!file) return;
    e.preventDefault();
    attach(file);
  };

  // 입력칸은 잠그지 않는다(포커스 유지). 보내는 중의 전송 시도만 무시한다
  const send = (body: InputRequest) => {
    // 글을 보낸 뒤에는 이어서 칠 수 있게 입력 칸에 포커스를 둔다.
    // 키 버튼은 마우스 환경에서만 포커스를 되돌린다 (터치 화면에서 PgUp 을 누를 때마다 키보드가 뜨지 않게).
    if (body.text !== undefined || finePointer()) inputRef.current?.focus();
    // 보낼 pane 이 없거나, 이미지 경로가 아직 안 들어왔는데 프롬프트를 제출하려 하면 보내지 않는다
    if (busy || !target || (uploading > 0 && (body.text !== undefined || body.key === 'Enter'))) return;
    setBusy(true);
    const sent = body.text;
    if (sent !== undefined) setText('');
    api
      .sendInput(projectId, body)
      .then(
        () => setError(null),
        (e: unknown) => {
          setError(errorMessage(e));
          // 보내지 못한 글은 되돌려 놓는다. 그사이 새로 친 글이 있으면 그 앞에 붙여 둘 다 남긴다
          if (sent !== undefined) setText((cur) => (cur === '' ? sent : `${sent}\n${cur}`));
        },
      )
      .finally(() => setBusy(false));
  };
  const sendText = (enter: boolean) => {
    if (text !== '') send(enter ? { pane, text, enter: true } : { pane, text });
    else if (enter) send({ pane, key: 'Enter' });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 한글 등 IME 조합 중의 Enter 는 조합 확정이지 전송이 아니다
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.metaKey || e.altKey) return;
    if (e.ctrlKey) {
      const ctrl = text === '' ? CTRL[e.key.toLowerCase()] : undefined;
      if (ctrl) {
        e.preventDefault();
        send({ pane, key: ctrl });
      }
      return;
    }
    const forward = FORWARD[e.key];
    if (e.key === 'Enter') {
      // Shift+Enter 는 줄바꿈. 터치 화면의 키보드에는 Shift+Enter 가 없으니 Enter 가 줄바꿈이고 "보내기" 버튼이 보낸다
      if (e.shiftKey || !finePointer()) return;
      e.preventDefault();
      sendText(true);
    } else if (e.key === 'Tab') {
      // 빈 입력칸에서만 pane 으로 보낸다. 글을 치는 중엔 평소처럼 포커스가 옮겨져 키보드로 빠져나갈 수 있다
      if (text === '') {
        e.preventDefault();
        send({ pane, key: e.shiftKey ? 'BTab' : 'Tab' });
      }
    } else if (text === '' && forward) {
      e.preventDefault();
      send({ pane, key: forward });
    }
  };

  const blocked = busy || !target || uploading > 0;
  return (
    <div className={target ? 'input-bar' : 'input-bar lost'}>
      {/* pane 이 하나뿐이면 보낼 곳이 뻔하니 숨긴다 */}
      {target ? (
        (showTarget || uploading > 0) && (
          <p className="input-target">
            {showTarget && (
              <>
                보낼 곳: <span className="mono">{target.window}:{target.windowName} · {target.index}</span> <span className="dim mono">{target.command}</span>
              </>
            )}
            {uploading > 0 && <span className="warn">{showTarget ? ' · ' : ''}이미지 올리는 중…</span>}
          </p>
        )
      ) : (
        <p className="err input-target" role="alert">
          선택한 pane 이 사라졌습니다. 위에서 pane 을 다시 고르면 보낼 수 있습니다.
        </p>
      )}
      <div className="input-row">
        <textarea
          ref={inputRef}
          className="mono"
          aria-label="pane 에 보낼 입력"
          placeholder={finePointer() ? '입력 후 Enter (줄바꿈은 Shift+Enter)' : '입력 후 보내기'}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={20000}
          rows={Math.min(8, text.split('\n').length)}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
        />
        <button type="button" className="primary" disabled={blocked} onClick={() => sendText(true)}>
          보내기
        </button>
        <button type="button" className="type-only" disabled={blocked || text === ''} title="Enter 를 누르지 않고 글만 pane 에 넣습니다 (아직 제출하지 않음)" onClick={() => sendText(false)}>
          입력만 하기
        </button>
        <button type="button" disabled={uploading > 0} title="이미지를 골라 파일로 저장하고 경로를 입력에 넣습니다 (붙여넣기·끌어다 놓기도 됩니다)" onClick={() => fileRef.current?.click()}>
          {uploading > 0 ? '이미지 올리는 중…' : '이미지'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          aria-label="이미지 파일"
          onChange={(e) => {
            attach(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
      <div className={moreKeys ? 'keys open' : 'keys'} role="group" aria-label="특수 키">
        {KEYS.map(([key, label, title]) => (
          <button
            key={key}
            type="button"
            className={[CAUTION.includes(key) ? 'caution' : '', PRIMARY_KEYS.includes(key) ? '' : 'extra'].join(' ').trim() || undefined}
            title={title}
            aria-label={title}
            disabled={busy || !target || (key === 'Enter' && uploading > 0)}
            onClick={() => {
              // 중단·종료 키는 되돌릴 수 없다. 버튼은 손가락이 미끄러지기 쉬우니 한 번 묻는다 (키보드의 Ctrl+C 는 그대로)
              if (CAUTION.includes(key) && !window.confirm(`${label} 를 보낼까요? 실행 중인 프로그램이 중단될 수 있습니다.`)) return;
              send({ pane, key });
            }}
          >
            {label}
          </button>
        ))}
        <button type="button" className="more" aria-expanded={moreKeys} onClick={() => setMoreKeys(!moreKeys)}>
          {moreKeys ? '접기' : '더보기'}
        </button>
      </div>
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      <p className="hint input-help">
        입력은 선택한 pane 에 그대로 전달됩니다. 보낸 내용은 서버에 기록됩니다. 빈 입력칸에서는 Esc·방향키·Tab·PgUp/PgDn·Ctrl+C 같은 키가 그대로 pane 으로 갑니다. 이미지를 붙여넣거나 끌어다 놓으면 파일로 저장돼 경로가 들어갑니다.
      </p>
    </div>
  );
}

export function TerminalTab({ project: p, now }: Props) {
  const t = p.tmux;
  const viewRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  // 휴대폰에선 터미널 탭을 열면 터미널 틀을 화면 맨 위로 올린다: 터미널과 입력칸이 한 화면에 들어온다
  useEffect(() => {
    if (window.matchMedia?.('(max-width: 720px)').matches) frameRef.current?.scrollIntoView?.({ block: 'start' });
  }, []);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  const [paneId, setPaneId] = useState<string | null>(null);
  // 고른 pane 이 사라지면 보기는 활성 pane 으로 돌아가지만, 입력은 다시 고를 때까지 막는다 (다른 pane 으로 새지 않게)
  const chosen = t.panes.find((x) => x.id === paneId);
  const lost = paneId !== null && !chosen;
  const pane = chosen ?? t.panes.find((x) => x.active) ?? t.panes[0];
  const [showInfo, setShowInfo] = useState(false);
  const [fitting, setFitting] = useState(false);
  const [fitError, setFitError] = useState<string | null>(null);
  const [status, setStatus] = useState<TermStatus>('connecting');
  // 스트림이 알려 준 pane 크기 (칸·줄)
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);
  // 늘리면 터미널을 새로 붙인다 (끊김·pane 종료 뒤 "다시 연결")
  const [attempt, setAttempt] = useState(0);
  // 전체 화면: 터미널이 창을 다 채우고, 붙은 터미널이 없으면 tmux 크기도 그 화면에 맞춘다
  const [full, setFull] = useState(false);
  // 터미널에서 복사·이미지 붙여넣기의 결과를 잠깐 보여 준다
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = (msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2500);
  };
  const [answering, setAnswering] = useState<string | null>(null);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const autoFitted = useRef<string | null>(null);
  const canFit = p.allowInput && t.exists && !t.attached;
  // 붙어 있는 터미널이 없으면, 터미널을 연 화면(휴대폰·컴퓨터) 크기에 pane 을 한 번 맞춘다. 나중에 다른 화면에서 열면 거기에 맞춘다
  useEffect(() => {
    if (!canFit || !pane || !size || autoFitted.current === pane.id) return;
    // 첫 화면이 그려진 뒤에 재야 실제 칸 폭을 쓴다
    const timer = setTimeout(() => {
      autoFitted.current = pane.id;
      const want = fitSize(viewRef.current);
      if (want.cols !== size.cols || want.rows !== size.rows) void api.fitPane(p.id, pane.id, want).catch((e: unknown) => setFitError(errorMessage(e)));
    }, 300);
    return () => clearTimeout(timer);
  }, [canFit, pane, size, p.id]);

  if (!t.configured) {
    return (
      <div className="notice">
        <strong>tmux 세션이 등록되지 않았습니다.</strong>
        <p>설정 파일에서 이 프로젝트의 tmux 세션 이름을 지정하면 터미널 출력을 볼 수 있습니다.</p>
      </div>
    );
  }
  if (!t.exists) {
    return (
      <div className="notice error">
        <strong>tmux 세션을 찾을 수 없습니다.</strong>
        <p>
          등록된 세션 <code>{p.tmuxSession}</code> 이(가) 실행 중이 아닙니다.
        </p>
        {t.error && <p className="mono wrap">{t.error}</p>}
        <StartSession projectId={p.id} />
      </div>
    );
  }

  // pane 이 터미널 영역과 크기가 다른지
  const want = fitSize(viewRef.current, full);
  const misfit = size !== null && (size.cols !== want.cols || size.rows !== want.rows);
  const fit = () => {
    if (!pane) return;
    setFitting(true);
    setFitError(null);
    api
      .fitPane(p.id, pane.id, fitSize(viewRef.current, full))
      .catch((e: unknown) => setFitError(errorMessage(e)))
      .finally(() => setFitting(false));
  };

  const copy = (cmd: string) => {
    navigator.clipboard.writeText(cmd).then(
      () => setCopyMsg('복사됨'),
      () => setCopyMsg('복사 실패'),
    );
    setTimeout(() => setCopyMsg(null), 1500);
  };

  const live = status === 'live';
  const statusLabel = status === 'live' ? '실시간' : status === 'connecting' ? '연결 중' : status === 'down' ? '연결 끊김 · 재연결 중' : status === 'exit' ? 'pane 종료' : status;

  return (
    <>
      {t.waitingPrompt !== null && (
        <div className="notice waiting" role="status">
          <strong>에이전트가 입력을 기다리고 있습니다.</strong>
          <p className="mono wrap">{t.waitingPrompt}</p>
          {/* 번호 선택지는 버튼으로 바로 답한다: 그 번호 키를 프롬프트가 뜬 pane 에 보낸다 */}
          {p.allowInput && t.waitingChoices && (
            <div className="choices" role="group" aria-label="바로 답하기">
              {t.waitingChoices.options.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  disabled={answering !== null}
                  onClick={() => {
                    setAnswering(o.key);
                    setAnswerError(null);
                    api
                      .sendInput(p.id, { pane: t.waitingChoices!.pane, text: o.key })
                      .catch((e: unknown) => setAnswerError(errorMessage(e)))
                      .finally(() => setAnswering(null));
                  }}
                >
                  {o.key}. {o.label}
                </button>
              ))}
            </div>
          )}
          {answerError && (
            <p className="err" role="alert">
              {answerError}
            </p>
          )}
        </div>
      )}
      {/* 좁은 화면에서는 접혀 있다가 "세션 정보"로 펼친다: 터미널이 화면 위쪽을 차지하게 */}
      <div className={showInfo ? 'term-info open' : 'term-info'}>
        {t.attachCommand && (
          <div className="cmdline">
            <code>{t.attachCommand}</code>
            <button type="button" onClick={() => copy(t.attachCommand!)}>
              {/* 알림 영역은 그대로 두고 안쪽 글자만 바꿔 그린다: 낭독기가 변화를 읽고, 등장 전환도 걸린다 */}
              <span aria-live="polite">
                <span key={copyMsg ?? '복사'} className="swap">
                  {copyMsg ?? '복사'}
                </span>
              </span>
            </button>
          </div>
        )}
        <dl className="kv inline">
          <dt>세션</dt>
          <dd>{p.tmuxSession}</dd>
          <dt>생성 시각</dt>
          <dd>{dateTime(t.createdAt)}</dd>
          <dt>외부 터미널 연결</dt>
          <dd>{t.attached ? '예' : '아니오'}</dd>
          <dt>마지막 출력 변경</dt>
          <dd>
            {relTime(t.lastOutputChangeAt ?? t.lastActivityAt, now)}
            <span className="dim"> ({dateTime(t.lastOutputChangeAt ?? t.lastActivityAt)})</span>
          </dd>
        </dl>
      </div>
      {t.error && <p className="err mono wrap">{t.error}</p>}
      <div className={full ? 'term-frame full' : 'term-frame'} ref={frameRef}>
        {pane && (
          <div className="term-bar">
            {(t.panes.length > 1 || lost) && (
              <div className="panes" role="group" aria-label="pane 선택">
                {t.panes.map((x) => (
                  <button key={x.id} type="button" aria-pressed={!lost && x.id === pane.id} onClick={() => setPaneId(x.id)}>
                    {x.window}:{x.windowName} · {x.index} <span className="dim">{x.command}</span>
                  </button>
                ))}
              </div>
            )}
            <button type="button" className="more-rows info-toggle" aria-expanded={showInfo} onClick={() => setShowInfo(!showInfo)}>
              세션 정보
            </button>
            {size && (
              <span className="dim mono" title="pane 크기 (칸 × 줄)">
                {size.cols}×{size.rows}
              </span>
            )}
            {/* 붙어 있는 터미널이 없는 세션만: 이 화면 크기로 맞춘다 (붙어 있으면 그 터미널까지 바뀐다) */}
            {canFit && misfit && (
              <button type="button" className="more-rows" disabled={fitting} onClick={fit} title="tmux 화면을 이 터미널 영역 크기로 바꿉니다">
                화면에 맞추기
              </button>
            )}
            {fitError && (
              <span className="err" role="alert">
                {fitError}
              </span>
            )}
            {notice && (
              <span className="dim" role="status">
                {notice}
              </span>
            )}
            <span className={live ? 'conn conn-live' : status === 'down' ? 'conn conn-down' : 'conn'} role="status">
              <span className="dot" />
              {statusLabel}
            </span>
            <button
              type="button"
              className="more-rows full-toggle"
              aria-pressed={full}
              onClick={() => {
                const next = !full;
                setFull(next);
                // 바뀐 틀이 그려진 뒤에 재서 맞춘다
                if (canFit && pane) requestAnimationFrame(() => void api.fitPane(p.id, pane.id, fitSize(viewRef.current, next)).catch((e: unknown) => setFitError(errorMessage(e))));
              }}
            >
              {full ? '전체 화면 끝내기' : '전체 화면'}
            </button>
            {status !== 'live' && status !== 'connecting' && (
              <button type="button" className="more-rows" onClick={() => setAttempt(attempt + 1)}>
                다시 연결
              </button>
            )}
          </div>
        )}
        <div ref={viewRef} className="term-view">
          {pane ? (
            <Term key={`${pane.id}:${attempt}`} projectId={p.id} pane={pane.id} canInput={p.allowInput && !lost} full={full} onNotice={showNotice} onStatus={setStatus} onSize={(cols, rows) => setSize({ cols, rows })} />
          ) : (
            <pre className="terminal" tabIndex={0} aria-label="최근 터미널 출력">
              {t.output.join('\n')}
            </pre>
          )}
        </div>
      </div>
      {pane &&
        (p.allowInput ? (
          <InputBar projectId={p.id} pane={lost ? null : pane} showTarget={t.panes.length > 1} />
        ) : (
          <p className="hint">{p.id.startsWith('tmux:') ? '입력을 보내려면 먼저 위의 "프로젝트로 등록"으로 등록한 뒤, 설정에서 "터미널 입력 허용"을 켜세요.' : '입력을 보내려면 설정에서 이 프로젝트의 "터미널 입력 허용"을 켜세요.'}</p>
        ))}
    </>
  );
}

const COMMITS_SHOWN = 10;
function Commits({ commits, now, empty }: { commits: Commit[]; now: string; empty: string }) {
  const [all, setAll] = useState(false);
  if (commits.length === 0) return <p className="dim">{empty}</p>;
  const hidden = commits.length - COMMITS_SHOWN;
  return (
    <>
      <ul className="rows commits">
        {(all ? commits : commits.slice(0, COMMITS_SHOWN)).map((c) => (
          <li key={c.hash}>
            <span className="hash">{c.hash.slice(0, 7)}</span>
            <span className="grow wrap subject">{c.subject}</span>
            <span className="dim nowrap" title={dateTime(c.date)}>
              {c.author} · {relTime(c.date, now)}
            </span>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button type="button" className="more-rows" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? '접기' : `${hidden}개 더 보기`}
        </button>
      )}
    </>
  );
}

function FilePath({ file }: { file: { path: string; from?: string } }) {
  return (
    <span className="grow wrap">
      {file.from && <span className="dim">{file.from} → </span>}
      {file.path}
    </span>
  );
}

function Stats({ files, additions, deletions, empty }: { files: FileStat[]; additions: number; deletions: number; empty: string }) {
  if (files.length === 0) return <p className="dim">{empty}</p>;
  return (
    <ul className="rows">
      {files.map((f) => (
        <li key={f.path}>
          <FilePath file={f} />
          {f.untracked && <span className="new-mark">new</span>}
          <span className="add">+{f.additions}</span>
          <span className="del">−{f.deletions}</span>
        </li>
      ))}
      <li className="total">
        <span className="grow">합계 · 파일 {files.length}개</span>
        <span className="add">+{additions}</span>
        <span className="del">−{deletions}</span>
      </li>
    </ul>
  );
}

export function GitTab({ project: p, now }: Props) {
  const { git } = p;
  // 실시간 스냅샷의 기준점 정보는 목록이 빠진 요약이다 (partial). 탭을 열거나 Git 이 바뀌면 전체를 받는다
  const [full, setFull] = useState<ProjectSnapshot['since']>(null);
  useEffect(() => {
    if (!p.since?.partial) return;
    let live = true;
    api.project(p.id).then(
      (x) => live && setFull(x.since),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [p.id, p.lastGitChangeAt, p.since?.partial]);
  const since = p.since?.partial ? full : p.since;
  return (
    <>
      {git.ok ? (
        <>
          <dl className="kv inline">
            <dt>브랜치</dt>
            <dd>{git.branch}</dd>
            <dt>HEAD</dt>
            <dd>{git.head?.slice(0, 7) ?? '—'}</dd>
            <dt>작업 트리</dt>
            <dd className={git.clean ? 'ok' : 'warn'}>{git.clean ? '변경 없음 (clean)' : '변경 있음 (dirty)'}</dd>
            <dt>마지막 Git 변경</dt>
            <dd>{relTime(p.lastGitChangeAt, now)}</dd>
          </dl>

          <section>
            <h3>변경된 파일 ({git.changedFiles.length})</h3>
            {git.changedFiles.length === 0 ? (
              <p className="dim">변경된 파일이 없습니다.</p>
            ) : (
              <ul className="rows">
                {git.changedFiles.map((f) => (
                  <li key={f.path}>
                    <span className="xy">{f.status}</span>
                    <FilePath file={f} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3>Diff stat (HEAD 대비)</h3>
            <Stats files={git.diffStat} additions={git.additions} deletions={git.deletions} empty="diff 가 없습니다." />
          </section>

          <section>
            <h3>최근 커밋</h3>
            <Commits commits={git.recentCommits.slice(0, 10)} now={now} empty="커밋이 없습니다." />
          </section>

          <section>
            <h3>오늘 커밋 ({git.todayCommits.length})</h3>
            <Commits commits={git.todayCommits} now={now} empty="오늘 커밋이 없습니다." />
          </section>
        </>
      ) : git.error === NOT_A_REPO ? (
        // tmux 만 감시하는 프로젝트도 있다. 오류가 아니다
        <div className="notice">
          <strong>연결된 Git 저장소가 없습니다.</strong>
          <p>터미널 감시는 계속됩니다.</p>
        </div>
      ) : (
        <div className="notice error">
          <strong>Git 정보를 읽을 수 없습니다.</strong>
          <p className="mono wrap">{git.error ?? '알 수 없는 오류'}</p>
        </div>
      )}

      {since && (
        <section>
          <h3>모니터링 시작 이후</h3>
          <dl className="kv inline">
            <dt>기준 시각</dt>
            <dd>{dateTime(since.baseline.at)}</dd>
            <dt>기준 브랜치</dt>
            <dd>{since.baseline.branch}</dd>
            <dt>기준 HEAD</dt>
            <dd>{since.baseline.head?.slice(0, 7) ?? '—'}</dd>
          </dl>
          <h4>커밋 ({since.commits.length})</h4>
          <Commits commits={since.commits} now={now} empty="기준점 이후 커밋이 없습니다." />
          <h4>변경 파일</h4>
          <Stats files={since.files} additions={since.additions} deletions={since.deletions} empty="기준점 이후 변경된 파일이 없습니다." />
        </section>
      )}

      {p.logErrors.length > 0 && (
        <section id="log-errors">
          <h3 className="err">로그 오류 ({p.logErrors.length})</h3>
          <p className="hint">확인 처리는 화면 위쪽의 "로그 오류 확인 완료"에서 합니다.</p>
          {p.logFile && <p className="mono dim wrap">{p.logFile}</p>}
          <pre className="output err-output">{p.logErrors.join('\n')}</pre>
        </section>
      )}
    </>
  );
}

function Verdict({ run }: { run: RunSummary }) {
  if (run.canceled) return <span className="dim">취소됨</span>;
  if (run.timedOut) return <span className="err">시간 초과</span>;
  return run.exitCode === 0 ? <span className="ok">성공</span> : <span className="err">실패</span>;
}

export function RunPanel({ project: p, kind, title }: { project: ProjectSnapshot; kind: RunKind; title: string }) {
  const command = kind === 'test' ? p.testCommand : p.buildCommand;
  const run = p.runs[kind];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = run?.running ?? false;
  // 요청이 받아들여진 뒤 다음 스냅샷이 오기 전까지의 표시. 실행 상태가 바뀌면(또는 10초 뒤) 지운다
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => setPending(null), [running, run?.startedAt]);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setPending(null), 10_000);
    return () => clearTimeout(timer);
  }, [pending]);

  const history = p.history[kind];
  // 스냅샷에는 출력의 끝부분만 온다. 펼치면 전체를 받아 같은 실행인 동안 보여 준다
  const [full, setFull] = useState<RunResult | null>(null);
  const shown = full && run && full.startedAt === run.startedAt ? full : run;
  const loadFull = () => {
    setBusy(true);
    setError(null);
    api
      .runOutput(p.id, kind)
      .then(setFull, (e: unknown) => setError(`전체 출력을 불러오지 못했습니다: ${errorMessage(e)}`))
      .finally(() => setBusy(false));
  };

  const request = (action: typeof api.run, label: string) => {
    setBusy(true);
    setError(null);
    action(p.id, kind)
      .then(
        () => setPending(`${label} 요청함…`),
        (e: unknown) => setError(`${label} 요청 실패: ${errorMessage(e)}`),
      )
      .finally(() => setBusy(false));
  };

  return (
    <section className="run">
      <h3>{title}</h3>
      <div className="cmdline">
        {command ? <code>{command}</code> : <span className="dim grow">명령이 설정되지 않았습니다</span>}
        <button type="button" onClick={() => request(api.run, '실행')} disabled={!command || busy || running || pending !== null}>
          {running ? '실행 중…' : '실행'}
        </button>
        {running && (
          <button type="button" onClick={() => request(api.cancelRun, '취소')} disabled={busy || pending !== null}>
            취소
          </button>
        )}
      </div>
      {(busy || pending) && (
        <p className="hint" role="status">
          {pending ?? '요청 보내는 중…'}
        </p>
      )}
      {!command && <p className="hint">설정 파일에 이 프로젝트의 {title} 명령을 등록하면 실행할 수 있습니다.</p>}
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      {!run ? (
        <p className="dim">아직 실행 기록이 없습니다.</p>
      ) : (
        <>
          <dl className="kv inline">
            <dt>결과</dt>
            <dd>{run.running ? <span className="warn">실행 중…</span> : <Verdict run={run} />}</dd>
            <dt>종료 코드</dt>
            <dd>{run.exitCode ?? '—'}</dd>
            <dt>소요 시간</dt>
            <dd>{duration(run.durationMs)}</dd>
            <dt>시작 시각</dt>
            <dd>{dateTime(run.startedAt)}</dd>
            <dt>실행한 명령</dt>
            <dd className="wrap">{run.command}</dd>
          </dl>
          {shown?.truncated && (
            <p className="hint">
              출력이 길어 끝부분만 보여 줍니다.{' '}
              <button type="button" onClick={loadFull} disabled={busy}>
                전체 출력 보기
              </button>
            </p>
          )}
          <h4>stdout</h4>
          <pre className="output" tabIndex={0}>
            {shown?.stdout || '(비어 있음)'}
          </pre>
          <h4>stderr</h4>
          <pre className="output err-output" tabIndex={0}>
            {shown?.stderr || '(비어 있음)'}
          </pre>
        </>
      )}
      {history.length > 0 && (
        <>
          <h4>실행 이력 ({history.length})</h4>
          <table className="history">
            <thead>
              <tr>
                <th>시작 시각</th>
                <th>결과</th>
                <th>종료 코드</th>
                <th>소요 시간</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={`${h.startedAt}-${i}`}>
                  <td>{dateTime(h.startedAt)}</td>
                  <td>
                    <Verdict run={h} />
                  </td>
                  <td>{h.exitCode ?? '—'}</td>
                  <td>{duration(h.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
