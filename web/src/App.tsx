import { useEffect, useState, useSyncExternalStore } from 'react';
import type React from 'react';
import type { ProjectSnapshot, Snapshot } from '../../shared/types.ts';
import { NOT_A_REPO } from '../../shared/types.ts';
import { api, errorMessage } from './api.ts';
import { dateTime, relTime } from './format.ts';
import { Badge, ProjectDetail, Reasons } from './ProjectDetail.tsx';
import { commonParentDir, NewSession } from './NewSession.tsx';
import { Reports } from './Reports.tsx';
import { Settings } from './Settings.tsx';

type Conn = 'connecting' | 'live' | 'down';

// 선 아이콘. 장식이므로 보조 기술에는 숨긴다 (의미는 옆 글자나 title 이 전한다).
const icon = (d: React.ReactNode) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);
const GRID_ICON = icon(<path d="M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z" />);
const DOC_ICON = icon(<path d="M4 1.5h5.5L12.5 4.5v10H4zM9.5 1.5v3h3M6 8h4M6 11h4" />);
const GEAR_ICON = icon(
  <>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
  </>,
);
// 워드마크 옆의 초승달. 밤새 지켜본다는 뜻만 담은 작은 표식이다.
const MARK = (
  <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <path d="M12.6 2.2a8 8 0 1 0 5.2 11.4 6.5 6.5 0 0 1-5.2-11.4Z" />
  </svg>
);

function subscribeHash(cb: () => void) {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}
const getHash = () => window.location.hash;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const lastActivity = (p: ProjectSnapshot) => p.tmux.lastOutputChangeAt ?? p.tmux.lastActivityAt ?? p.lastGitChangeAt;

export function App() {
  const hash = useSyncExternalStore(subscribeHash, getHash);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [conn, setConn] = useState<Conn>('connecting');
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;

    api.snapshot().then(
      (s) => {
        if (alive) setSnapshot((prev) => prev ?? s);
      },
      (e: unknown) => {
        if (alive) setLoadError(errorMessage(e));
      },
    );

    const connect = () => {
      es = new EventSource('/api/events');
      es.onopen = () => setConn('live');
      es.onmessage = (ev: MessageEvent<string>) => {
        try {
          setSnapshot(JSON.parse(ev.data) as Snapshot);
          setLoadError(null);
        } catch {
          // 깨진 메시지는 버리고 다음 스냅샷을 기다린다
        }
      };
      es.onerror = () => {
        setConn('down');
        // EventSource 는 네트워크 오류면 스스로 재연결하지만, HTTP 오류 응답이면 영구히 닫힌다
        if (es?.readyState === EventSource.CLOSED) {
          es.close();
          retry = setTimeout(connect, 3000);
        }
      };
    };
    connect();

    return () => {
      alive = false;
      clearTimeout(retry);
      es?.close();
    };
  }, []);

  const path = hash.replace(/^#/, '') || '/';
  const isReports = path === '/reports';
  const isSettings = path === '/settings';
  const projectId = path.startsWith('/project/') ? safeDecode(path.slice('/project/'.length)) : null;

  let page;
  if (isReports) {
    page = <Reports />;
  } else if (isSettings) {
    page = <Settings />;
  } else if (!snapshot) {
    page = loadError ? (
      <div className="notice error" role="alert">
        <strong>서버에서 상태를 가져오지 못했습니다.</strong>
        <p>{loadError}</p>
        <p className="dim">NightShift 서버가 실행 중인지 확인하세요. 연결되면 자동으로 표시됩니다.</p>
      </div>
    ) : (
      <div className="notice">불러오는 중…</div>
    );
  } else if (projectId !== null) {
    const project = snapshot.projects.find((p) => p.id === projectId);
    page = project ? (
      <ProjectDetail key={project.id} project={project} now={snapshot.generatedAt} refreshSec={snapshot.refreshIntervalSec} />
    ) : (
      <div className="notice error">
        <strong>프로젝트를 찾을 수 없습니다.</strong>
        <p className="mono">{projectId}</p>
        <p>
          <a href="#/">← 대시보드로</a>
        </p>
      </div>
    );
  } else {
    page = <Dashboard snapshot={snapshot} />;
  }

  return (
    <div className="shell">
      <aside className="side">
        <a className="wordmark" href="#/">
          {MARK}
          NightShift
          {snapshot?.demo && <span className="demo-badge">DEMO</span>}
        </a>
        <nav aria-label="주 메뉴">
          <a href="#/" aria-current={!isReports && !isSettings && projectId === null ? 'page' : undefined}>
            {GRID_ICON}
            대시보드
          </a>
          <a href="#/reports" aria-current={isReports ? 'page' : undefined}>
            {DOC_ICON}
            보고서
          </a>
          <a href="#/settings" aria-current={isSettings ? 'page' : undefined}>
            {GEAR_ICON}
            설정
          </a>
        </nav>
        {/* 어느 화면에서든 바로 넘어갈 수 있는 프로젝트 목록. 상태 점으로 한눈에 훑는다 */}
        {snapshot && snapshot.projects.length > 0 && (
          <div className="side-list" role="navigation" aria-label="프로젝트">
            <h4>프로젝트</h4>
            {snapshot.projects.map((p) => (
              <a key={p.id} className={`side-item state-${p.status.state}`} href={`#/project/${encodeURIComponent(p.id)}`} aria-current={p.id === projectId ? 'page' : undefined} title={p.status.reasons[0]}>
                <span className="dot" aria-hidden="true" />
                <span className="clip">{p.name}</span>
                <span className="end">{relTime(lastActivity(p), snapshot.generatedAt)}</span>
              </a>
            ))}
          </div>
        )}
        <div className="side-foot">
          <span className={`conn conn-${conn}`} role="status">
            <span className="dot" aria-hidden="true" />
            {conn === 'live' ? 'live' : conn === 'down' ? '연결 끊김 / 재연결 중' : '연결 중'}
          </span>
          {snapshot && <span>갱신 {dateTime(snapshot.generatedAt)}</span>}
        </div>
      </aside>
      <main>
        <div className="page">
          {snapshot?.configError != null && <ConfigErrorBanner message={snapshot.configError} />}
          {page}
        </div>
      </main>
    </div>
  );
}

export function ConfigErrorBanner({ message }: { message: string }) {
  return (
    <div className="notice error banner" role="alert">
      <strong>config 를 다시 읽지 못했습니다. 이전 설정으로 동작 중입니다.</strong>
      <p className="mono pre-wrap">{message}</p>
    </div>
  );
}

export function Dashboard({ snapshot }: { snapshot: Snapshot }) {
  const s = snapshot.summary;
  // 상태 타일을 누르면 그 상태의 줄만 남는다. 다시 누르면 전체.
  const [filter, setFilter] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const reset = () => {
    if (!window.confirm('새 모니터링 세션을 시작할까요?\n"모니터링 시작 이후" 기준점(커밋·변경 기준점)이 지금 시점으로 초기화됩니다.')) return;
    setResetting(true);
    setResetError(null);
    api
      .resetSession()
      .catch((e: unknown) => setResetError(errorMessage(e)))
      .finally(() => setResetting(false));
  };
  // 0 인 상태는 보여 주지 않는다. 문제가 있을 때만 그 상태가 줄에 나타난다.
  const states: [string, number, string][] = [
    ['정상', s.running, 'running'],
    ['입력 대기', s.waiting, 'waiting'],
    ['유휴', s.idle, 'idle'],
    ['정지 의심', s.stalled, 'stalled'],
    ['오류', s.error, 'error'],
  ];
  const active = states.filter(([, value]) => value > 0);
  const shown = filter && active.some(([, , state]) => state === filter) ? snapshot.projects.filter((p) => p.status.state === filter) : snapshot.projects;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>대시보드</h1>
          <div className="meta">
            <span>
              모니터링 시작 {dateTime(snapshot.startedAt)} ({relTime(snapshot.startedAt, snapshot.generatedAt)})
            </span>
            <span>갱신 주기 {snapshot.refreshIntervalSec}초</span>
            {snapshot.autoReportTime !== null && <span>자동 보고서 {snapshot.autoReportTime}</span>}
            {resetError && (
              <span className="err" role="alert">
                세션 초기화 실패: {resetError}
              </span>
            )}
          </div>
        </div>
        <div className="page-actions">
          <button type="button" className="quiet" onClick={reset} disabled={resetting}>
            모니터링 새로 시작
          </button>
        </div>
      </div>
      <div className="overview">
        <span className="stat">
          프로젝트 <span className="num">{s.total}</span>
        </span>
        <span className="stat">
          실행 중인 세션 <span className="num">{s.sessionsRunning}</span>
        </span>
        {active.map(([label, value, state]) => (
          <button key={state} type="button" className={`stat state-${state}`} aria-pressed={filter === state} title={filter === state ? '전체 보기' : `${label} 프로젝트만 보기`} onClick={() => setFilter(filter === state ? null : state)}>
            {label}
            <span className="num">{value}</span>
          </button>
        ))}
      </div>
      {snapshot.projects.length === 0 ? (
        <div className="notice board-empty">
          <strong>등록된 프로젝트가 없습니다.</strong>
          {snapshot.configMissing && (
            <p className="warn">
              설정 파일이 없습니다: <code>{snapshot.configPath}</code>
            </p>
          )}
          <p>돌고 있는 tmux 세션은 여기에 자동으로 나타납니다. "등록"을 누르면 프로젝트가 되고 설정 파일이 만들어집니다.</p>
          <p>
            아직 세션이 없으면 아래의 "+ tmux 세션 만들기"로 시작하세요. 먼저 둘러보려면 <code>npm run demo</code> 로 데모 모드를 실행할 수 있습니다.
          </p>
        </div>
      ) : (
        <div className="board">
          {shown.map((p) => (
            <ProjectCard key={p.id} p={p} now={snapshot.generatedAt} />
          ))}
        </div>
      )}
      {!snapshot.demo && <NewSession defaultDir={commonParentDir(snapshot.projects.map((p) => p.repoPath))} />}
    </>
  );
}

/** 설정에 없는 tmux 세션 줄의 "미등록" 표시와 등록·숨김 버튼. 줄 전체가 링크라 클릭이 새지 않게 막는다. */
function DiscoveredActions({ p }: { p: ProjectSnapshot }) {
  const [busy, setBusy] = useState(false);
  const act = (fn: () => Promise<unknown>) => async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      window.alert(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const session = p.tmuxSession ?? p.name;
  return (
    <span className="discovered">
      <span className="dim" title="설정에 없는 tmux 세션. 세션이 닫히면 이 줄도 사라집니다">
        미등록
      </span>
      <button type="button" disabled={busy} title="이 세션을 지금 경로로 프로젝트에 등록합니다" onClick={act(() => api.createSession({ name: session, repoPath: p.repoPath, tmuxSession: session, allowInput: false }))}>
        등록
      </button>
      <button type="button" disabled={busy} title="대시보드에서 숨깁니다. 설정 화면의 숨긴 세션 목록에서 되돌릴 수 있습니다" onClick={act(() => api.hideSession(session))}>
        숨김
      </button>
    </span>
  );
}

/** 대시보드의 프로젝트 한 줄: 이름·상태 | 브랜치·변경 | 마지막 커밋 | 세션. 줄 전체가 상세 화면 링크다. */
export function ProjectCard({ p, now }: { p: ProjectSnapshot; now: string }) {
  const { git, tmux, status } = p;
  const last = git.recentCommits[0];
  return (
    <a className={`row state-${status.state}`} href={`#/project/${encodeURIComponent(p.id)}`}>
      <div className="row-main">
        <div className="row-title">
          <h2>{p.name}</h2>
          <Badge state={status.state} />
          {p.id.startsWith('tmux:') && <DiscoveredActions p={p} />}
        </div>
        <Reasons reasons={status.reasons} />
        <div className="row-path" title={p.repoPath}>
          {p.repoPath}
        </div>
      </div>
      <div className="row-col">
        <span className="lbl">브랜치 · 변경</span>
        {git.ok ? (
          <span className="val">
            <span className="mono clip branch" title={`브랜치: ${git.branch}`}>
              {git.branch}
            </span>
            <span className="sub" title="커밋되지 않은 변경">
              {git.clean ? (
                '변경 없음'
              ) : (
                <>
                  파일 {git.changedFiles.length}개 <span className="add">+{git.additions}</span> <span className="del">−{git.deletions}</span>
                </>
              )}
            </span>
          </span>
        ) : git.error === NOT_A_REPO ? (
          <span className="val dim">{git.error}</span>
        ) : (
          <span className="val err wrap">{git.error ?? 'Git 정보를 읽을 수 없습니다'}</span>
        )}
      </div>
      <div className="row-col">
        <span className="lbl">마지막 커밋</span>
        <span className="val">
          <span className="clip" title={last?.subject}>
            {last ? last.subject : <span className="dim">커밋 없음</span>}
          </span>
          {last && <span className="sub">{relTime(last.date, now)}</span>}
        </span>
      </div>
      <div className="row-col">
        <span className="lbl">tmux 세션</span>
        {!tmux.configured ? (
          <span className="val dim">세션 미등록</span>
        ) : (
          <span className="val">
            <span className="mono clip" title={`tmux 세션: ${p.tmuxSession}`}>
              {p.tmuxSession}
            </span>
            {tmux.exists ? <span className="sub">{relTime(tmux.lastOutputChangeAt ?? tmux.lastActivityAt, now)}</span> : <span className="sub err">세션 없음</span>}
          </span>
        )}
      </div>
    </a>
  );
}
