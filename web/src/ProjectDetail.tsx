import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Commit, FileStat, InputKey, InputRequest, ProjectSnapshot, ProjectState, RunKind, RunSummary } from '../../shared/types.ts';
import { StartSession } from './NewSession.tsx';
import { parseAnsi } from './ansi.ts';
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

interface Props {
  project: ProjectSnapshot;
  now: string;
  /** 스냅샷 갱신 주기(초). 실시간 보기가 안 될 때의 표시에 쓴다 */
  refreshSec?: number;
}

export function ProjectDetail({ project: p, now, refreshSec }: Props) {
  const [tab, setTab] = useState<Tab>('terminal');
  return (
    <>
      <p className="crumb">
        <a href="#/">← 대시보드</a>
      </p>
      <div className="detail-head">
        <h1>{p.name}</h1>
        <Badge state={p.status.state} />
      </div>
      <Reasons reasons={p.status.reasons} />
      <p className="mono dim wrap">{p.repoPath}</p>

      <div className="tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
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

const POLL_MS = 700;
const POLL_BACKOFF_MS = 3000;

// [tmux 키, 버튼 글자, 설명]
// 터치 화면에서는 이 키들만 늘 보이고 나머지는 "더보기" 뒤로 접힌다.
const PRIMARY_KEYS: InputKey[] = ['Enter', 'Escape', 'Up', 'Down', 'C-c'];
const KEYS: [InputKey, string, string][] = [
  ['Enter', 'Enter', 'Enter 보내기'],
  ['Escape', 'Esc', 'Esc 보내기'],
  ['Tab', 'Tab', 'Tab 보내기'],
  ['BTab', '⇧Tab', 'Shift+Tab 보내기'],
  ['Up', '↑', '위 화살표 보내기'],
  ['Down', '↓', '아래 화살표 보내기'],
  ['Left', '←', '왼쪽 화살표 보내기'],
  ['Right', '→', '오른쪽 화살표 보내기'],
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
};

function InputBar({ projectId, pane, onSent }: { projectId: string; pane: string; onSent: () => void }) {
  const [text, setText] = useState('');
  const [moreKeys, setMoreKeys] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 입력칸은 잠그지 않는다(포커스 유지). 보내는 중의 전송 시도만 무시한다
  const send = (body: InputRequest) => {
    inputRef.current?.focus();
    if (busy) return;
    setBusy(true);
    const sent = body.text;
    if (sent !== undefined) setText('');
    api
      .sendInput(projectId, body)
      .then(
        () => {
          setError(null);
          onSent();
        },
        (e: unknown) => {
          setError(errorMessage(e));
          // 보내지 못한 글은 되돌려 놓는다 (그사이 새로 친 것이 있으면 그대로 둔다)
          if (sent !== undefined) setText((cur) => (cur === '' ? sent : cur));
        },
      )
      .finally(() => setBusy(false));
  };
  const sendText = (enter: boolean) => {
    if (text !== '') send(enter ? { pane, text, enter: true } : { pane, text });
    else if (enter) send({ pane, key: 'Enter' });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // 한글 등 IME 조합 중의 Enter 는 조합 확정이지 전송이 아니다
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const forward = FORWARD[e.key];
    if (e.key === 'Enter') {
      e.preventDefault();
      sendText(true);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (text === '') send({ pane, key: e.shiftKey ? 'BTab' : 'Tab' });
    } else if (text === '' && forward) {
      e.preventDefault();
      send({ pane, key: forward });
    }
  };

  return (
    <div className="input-bar">
      <div className="input-row">
        <input
          ref={inputRef}
          type="text"
          className="mono"
          aria-label="pane 에 보낼 입력"
          placeholder="입력 후 Enter"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={4000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="primary" disabled={busy} onClick={() => sendText(true)}>
          보내기
        </button>
        <button type="button" disabled={busy || text === ''} onClick={() => sendText(false)}>
          Enter 없이 입력
        </button>
      </div>
      <div className={moreKeys ? 'keys open' : 'keys'} role="group" aria-label="특수 키">
        {KEYS.map(([key, label, title]) => (
          <button
            key={key}
            type="button"
            className={[CAUTION.includes(key) ? 'caution' : '', PRIMARY_KEYS.includes(key) ? '' : 'extra'].join(' ').trim() || undefined}
            title={title}
            aria-label={title}
            disabled={busy}
            onClick={() => send({ pane, key })}
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
      <p className="hint">입력은 선택한 pane 에 그대로 전달됩니다. 보낸 내용은 서버에 기록됩니다.</p>
    </div>
  );
}

export function TerminalTab({ project: p, now, refreshSec }: Props) {
  const t = p.tmux;
  const preRef = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  const [paneId, setPaneId] = useState<string | null>(null);
  // 고른 pane 이 사라지면 활성 pane 으로 돌아간다. pane 정보가 없으면 output(색 없음)을 그대로 쓴다
  const pane = t.panes.find((x) => x.id === paneId) ?? t.panes.find((x) => x.active) ?? t.panes[0];
  // 실시간으로 읽어 온 출력. 실패하면 null 로 돌려 스냅샷의 줄로 되돌아간다
  const [live, setLive] = useState<{ pane: string; lines: string[] } | null>(null);
  const pollNow = useRef(() => {});
  const isLive = live !== null && live.pane === pane?.id;
  const text = (isLive ? live.lines : pane ? pane.lines : t.output).join('\n');
  const parsed = useMemo(() => parseAnsi(text.split('\n')), [text]);

  // 사용자가 위로 스크롤하지 않은 동안에는 새 출력에 맞춰 바닥에 붙인다
  useLayoutEffect(() => {
    const el = preRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text, pane?.id]);

  // 고른 pane 을 짧은 주기로 다시 읽는다. 앞 요청이 끝난 뒤에만 다음 요청을 잡는다
  const liveId = t.exists && pane ? pane.id : null;
  useEffect(() => {
    if (liveId === null) return;
    let stopped = false;
    let busy = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      clearTimeout(timer);
      if (stopped || document.visibilityState !== 'visible') return;
      if (busy) {
        again = true; // 진행 중인 요청은 입력 전의 화면일 수 있으니 끝나자마자 한 번 더 읽는다
        return;
      }
      busy = true;
      let delay = POLL_MS;
      try {
        const { lines } = await api.paneLive(p.id, liveId);
        if (!Array.isArray(lines)) throw new Error('bad response');
        if (!stopped) setLive({ pane: liveId, lines });
      } catch {
        delay = POLL_BACKOFF_MS;
        if (!stopped) setLive(null);
      }
      busy = false;
      if (stopped) return;
      if (again) {
        again = false;
        void poll();
      } else timer = setTimeout(wake, delay);
    };
    const wake = () => void poll();
    pollNow.current = wake;
    document.addEventListener('visibilitychange', wake);
    wake();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      pollNow.current = () => {};
      setLive(null);
    };
  }, [p.id, liveId]);

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

  const copy = (cmd: string) => {
    navigator.clipboard.writeText(cmd).then(
      () => setCopyMsg('복사됨'),
      () => setCopyMsg('복사 실패'),
    );
    setTimeout(() => setCopyMsg(null), 1500);
  };

  return (
    <>
      {t.waitingPrompt !== null && (
        <div className="notice waiting" role="status">
          <strong>에이전트가 입력을 기다리고 있습니다.</strong>
          <p className="mono wrap">{t.waitingPrompt}</p>
        </div>
      )}
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
        <dt>attached</dt>
        <dd>{t.attached ? '예' : '아니오'}</dd>
        <dt>마지막 출력 변경</dt>
        <dd>
          {relTime(t.lastOutputChangeAt ?? t.lastActivityAt, now)}
          <span className="dim"> ({dateTime(t.lastOutputChangeAt ?? t.lastActivityAt)})</span>
        </dd>
      </dl>
      {t.error && <p className="err mono wrap">{t.error}</p>}
      {pane && (
        <div className="term-bar">
          {t.panes.length > 1 && (
            <div className="panes" role="group" aria-label="pane 선택">
              {t.panes.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  aria-pressed={x.id === pane.id}
                  onClick={() => {
                    stick.current = true;
                    setPaneId(x.id);
                  }}
                >
                  {x.window}:{x.windowName} · {x.index} <span className="dim">{x.command}</span>
                </button>
              ))}
            </div>
          )}
          <span className={isLive ? 'conn conn-live' : 'conn'}>
            <span className="dot" />
            {isLive ? '실시간' : refreshSec === undefined ? '스냅샷' : `${refreshSec}초 갱신`}
          </span>
        </div>
      )}
      <pre
        ref={preRef}
        className="terminal"
        tabIndex={0}
        aria-label="최근 터미널 출력 100줄"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {text
          ? parsed.map((spans, i) => (
              <span key={i}>
                {spans.map((s, j) => (
                  <span key={j} style={s.style}>
                    {s.text}
                  </span>
                ))}
                {i < parsed.length - 1 && '\n'}
              </span>
            ))
          : '(출력 없음)'}
      </pre>
      {p.allowInput ? (
        pane && <InputBar projectId={p.id} pane={pane.id} onSent={() => pollNow.current()} />
      ) : (
        <p className="hint">
          입력을 보내려면 <a href="#/settings">설정</a>에서 이 프로젝트의 "터미널 입력 허용"을 켜세요.
        </p>
      )}
    </>
  );
}

const COMMITS_SHOWN = 10;

/** 긴 목록은 처음 10개만 보여 주고 나머지는 펼쳐서 본다 (오늘 커밋이 수십 개면 탭이 끝없이 길어진다). */
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
  const { git, since } = p;
  const [acking, setAcking] = useState(false);
  const [ackError, setAckError] = useState<string | null>(null);

  const ack = () => {
    setAcking(true);
    setAckError(null);
    api
      .ackErrors(p.id)
      .catch((e: unknown) => setAckError(errorMessage(e)))
      .finally(() => setAcking(false));
  };
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
          <Stats
            files={since.files}
            additions={since.additions}
            deletions={since.deletions}
            empty="기준점 이후 변경된 파일이 없습니다."
          />
        </section>
      )}

      {p.logErrors.length > 0 && (
        <section>
          <h3 className="err with-action">
            로그 오류 ({p.logErrors.length})
            <button type="button" onClick={ack} disabled={acking}>
              확인 처리
            </button>
          </h3>
          {ackError && (
            <p className="err" role="alert">
              확인 처리 실패: {ackError}
            </p>
          )}
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

  const history = p.history[kind];

  const request = (action: typeof api.run, label: string) => {
    setBusy(true);
    setError(null);
    action(p.id, kind)
      .catch((e: unknown) => setError(`${label} 요청 실패: ${errorMessage(e)}`))
      .finally(() => setBusy(false));
  };

  return (
    <section className="run">
      <h3>{title}</h3>
      <div className="cmdline">
        {command ? <code>{command}</code> : <span className="dim grow">명령이 설정되지 않았습니다</span>}
        <button type="button" onClick={() => request(api.run, '실행')} disabled={!command || busy || running}>
          {running ? '실행 중…' : '실행'}
        </button>
        {running && (
          <button type="button" onClick={() => request(api.cancelRun, '취소')} disabled={busy}>
            취소
          </button>
        )}
      </div>
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
          <h4>stdout</h4>
          <pre className="output" tabIndex={0}>
            {run.stdout || '(비어 있음)'}
          </pre>
          <h4>stderr</h4>
          <pre className="output err-output" tabIndex={0}>
            {run.stderr || '(비어 있음)'}
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
