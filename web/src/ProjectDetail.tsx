import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Commit, FileStat, ProjectSnapshot, ProjectState, RunKind, RunSummary } from '../../shared/types.ts';
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
}

export function ProjectDetail({ project: p, now }: Props) {
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
        {tab === 'terminal' && <TerminalTab project={p} now={now} />}
        {tab === 'git' && <GitTab project={p} now={now} />}
        {tab === 'runs' && (
          <>
            <RunPanel project={p} kind="test" title="테스트" />
            <RunPanel project={p} kind="build" title="빌드" />
          </>
        )}
      </div>
    </>
  );
}

export function TerminalTab({ project: p, now }: Props) {
  const t = p.tmux;
  const preRef = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  const [paneId, setPaneId] = useState<string | null>(null);
  // 고른 pane 이 사라지면 활성 pane 으로 돌아간다. pane 정보가 없으면 output(색 없음)을 그대로 쓴다
  const pane = t.panes.find((x) => x.id === paneId) ?? t.panes.find((x) => x.active) ?? t.panes[0];
  const text = (pane ? pane.lines : t.output).join('\n');
  const parsed = useMemo(() => parseAnsi(text.split('\n')), [text]);

  // 사용자가 위로 스크롤하지 않은 동안에는 새 출력에 맞춰 바닥에 붙인다
  useLayoutEffect(() => {
    const el = preRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text, pane?.id]);

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
            <span aria-live="polite">{copyMsg ?? '복사'}</span>
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
      {t.panes.length > 1 && (
        <div className="panes" role="group" aria-label="pane 선택">
          {t.panes.map((x) => (
            <button
              key={x.id}
              type="button"
              aria-pressed={x.id === pane?.id}
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
    </>
  );
}

function Commits({ commits, now, empty }: { commits: Commit[]; now: string; empty: string }) {
  if (commits.length === 0) return <p className="dim">{empty}</p>;
  return (
    <ul className="rows commits">
      {commits.map((c) => (
        <li key={c.hash}>
          <span className="hash">{c.hash.slice(0, 7)}</span>
          <span className="grow wrap">{c.subject}</span>
          <span className="dim nowrap" title={dateTime(c.date)}>
            {c.author} · {relTime(c.date, now)}
          </span>
        </li>
      ))}
    </ul>
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
        <button type="button" className="primary" onClick={() => request(api.run, '실행')} disabled={!command || busy || running}>
          {running ? '실행 중…' : '실행'}
        </button>
        {running && (
          <button type="button" onClick={() => request(api.cancelRun, '취소')} disabled={busy}>
            취소
          </button>
        )}
      </div>
      <p className="hint">
        {command
          ? '명령은 설정 파일에서만 바꿀 수 있습니다.'
          : `설정 파일에 이 프로젝트의 ${title} 명령을 등록하면 실행할 수 있습니다.`}
      </p>
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
