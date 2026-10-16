import { useEffect, useState, useSyncExternalStore } from "react";
import type React from "react";
import type { ProjectSnapshot, Snapshot } from "../../shared/types.ts";
import { NOT_A_REPO } from "../../shared/types.ts";
import { api, errorMessage } from "./api.ts";
import { dateTime, relTime } from "./format.ts";
import { Badge, ProjectDetail, Reasons } from "./ProjectDetail.tsx";
import { commonParentDir, NewSession } from "./NewSession.tsx";
import { Reports } from "./Reports.tsx";
import { Settings } from "./Settings.tsx";

type Conn = "connecting" | "live" | "down";

// 카드 줄 앞의 작은 표식. 장식이므로 보조 기술에는 숨긴다 (의미는 title 이 전한다).
const icon = (d: React.ReactNode) => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {d}
  </svg>
);
const BRANCH_ICON = icon(
  <>
    <circle cx="4" cy="3.2" r="1.6" />
    <circle cx="4" cy="12.8" r="1.6" />
    <circle cx="12" cy="5" r="1.6" />
    <path d="M4 4.8v6.4M12 6.6c0 3.2-8 2-8 4.6" />
  </>,
);
const COMMIT_ICON = icon(
  <>
    <circle cx="8" cy="8" r="2.6" />
    <path d="M1 8h4.4M10.6 8H15" />
  </>,
);
const SESSION_ICON = icon(<path d="M2.5 4.5 6 8l-3.5 3.5M8.5 11.5h5" />);
// 워드마크 옆의 초승달. 밤새 지켜본다는 뜻만 담은 작은 표식이다.
const MARK = (
  <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <path d="M12.6 2.2a8 8 0 1 0 5.2 11.4 6.5 6.5 0 0 1-5.2-11.4Z" />
  </svg>
);

function subscribeHash(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}
const getHash = () => window.location.hash;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function App() {
  const hash = useSyncExternalStore(subscribeHash, getHash);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [conn, setConn] = useState<Conn>("connecting");
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
      es = new EventSource("/api/events");
      es.onopen = () => setConn("live");
      es.onmessage = (ev: MessageEvent<string>) => {
        try {
          setSnapshot(JSON.parse(ev.data) as Snapshot);
          setLoadError(null);
        } catch {
          // 깨진 메시지는 버리고 다음 스냅샷을 기다린다
        }
      };
      es.onerror = () => {
        setConn("down");
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

  const path = hash.replace(/^#/, "") || "/";
  const isReports = path === "/reports";
  const isSettings = path === "/settings";
  const projectId = path.startsWith("/project/")
    ? safeDecode(path.slice("/project/".length))
    : null;

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
        <p className="dim">
          NightShift 서버가 실행 중인지 확인하세요. 연결되면 자동으로
          표시됩니다.
        </p>
      </div>
    ) : (
      <div className="notice">불러오는 중…</div>
    );
  } else if (projectId !== null) {
    const project = snapshot.projects.find((p) => p.id === projectId);
    page = project ? (
      <ProjectDetail
        key={project.id}
        project={project}
        now={snapshot.generatedAt}
        refreshSec={snapshot.refreshIntervalSec}
      />
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
    <>
      <header className="topbar">
        <a className="wordmark" href="#/">
          {MARK}
          NightShift
        </a>
        {snapshot?.demo && <span className="demo-badge">DEMO</span>}
        <nav aria-label="주 메뉴">
          <a
            href="#/"
            aria-current={!isReports && !isSettings ? "page" : undefined}
          >
            대시보드
          </a>
          <a href="#/reports" aria-current={isReports ? "page" : undefined}>
            보고서
          </a>
          <a href="#/settings" aria-current={isSettings ? "page" : undefined}>
            설정
          </a>
        </nav>
        <div className="topbar-status">
          <span className={`conn conn-${conn}`} role="status">
            <span className="dot" aria-hidden="true" />
            {conn === "live"
              ? "live"
              : conn === "down"
                ? "연결 끊김 / 재연결 중"
                : "연결 중"}
          </span>
          {snapshot && <span>갱신 {dateTime(snapshot.generatedAt)}</span>}
        </div>
      </header>
      <main>
        {snapshot?.configError != null && (
          <ConfigErrorBanner message={snapshot.configError} />
        )}
        {page}
      </main>
    </>
  );
}

export function ConfigErrorBanner({ message }: { message: string }) {
  return (
    <div className="notice error banner" role="alert">
      <strong>
        config 를 다시 읽지 못했습니다. 이전 설정으로 동작 중입니다.
      </strong>
      <p className="mono pre-wrap">{message}</p>
    </div>
  );
}

export function Dashboard({ snapshot }: { snapshot: Snapshot }) {
  const s = snapshot.summary;
  // 상태 알약을 누르면 그 상태의 카드만 남는다. 다시 누르면 전체.
  const [filter, setFilter] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const reset = () => {
    if (
      !window.confirm(
        '새 모니터링 세션을 시작할까요?\n"모니터링 시작 이후" 기준점(커밋·변경 기준점)이 지금 시점으로 초기화됩니다.',
      )
    )
      return;
    setResetting(true);
    setResetError(null);
    api
      .resetSession()
      .catch((e: unknown) => setResetError(errorMessage(e)))
      .finally(() => setResetting(false));
  };
  // 0 인 상태는 보여 주지 않는다. 문제가 있을 때만 그 상태가 줄에 나타난다.
  const states: [string, number, string][] = [
    ["정상", s.running, "running"],
    ["입력 대기", s.waiting, "waiting"],
    ["유휴", s.idle, "idle"],
    ["정지 의심", s.stalled, "stalled"],
    ["오류", s.error, "error"],
  ];
  const active = states.filter(([, value]) => value > 0);
  const shown =
    filter && active.some(([, , state]) => state === filter)
      ? snapshot.projects.filter((p) => p.status.state === filter)
      : snapshot.projects;
  return (
    <>
      <div className="dash-head">
        <div className="summary">
          <span className="stat">
            프로젝트 <span className="num">{s.total}</span>
          </span>
          <span className="stat">
            실행 중인 세션 <span className="num">{s.sessionsRunning}</span>
          </span>
          {active.map(([label, value, state]) => (
            <button
              key={state}
              type="button"
              className={`stat state-${state}`}
              aria-pressed={filter === state}
              title={filter === state ? "전체 보기" : `${label} 카드만 보기`}
              onClick={() => setFilter(filter === state ? null : state)}
            >
              {label}
              <span className="num">{value}</span>
            </button>
          ))}
        </div>
        <div className="dash-actions">
          <button type="button" onClick={reset} disabled={resetting}>
            모니터링 새로 시작
          </button>
        </div>
      </div>
      <div className="meta">
        <span>
          모니터링 시작 {dateTime(snapshot.startedAt)} (
          {relTime(snapshot.startedAt, snapshot.generatedAt)})
        </span>
        <span>갱신 주기 {snapshot.refreshIntervalSec}초</span>
        {snapshot.autoReportTime !== null && (
          <span>자동 보고서 {snapshot.autoReportTime}</span>
        )}
        {resetError && (
          <span className="err" role="alert">
            세션 초기화 실패: {resetError}
          </span>
        )}
      </div>
      {!snapshot.demo && (
        <NewSession
          defaultDir={commonParentDir(snapshot.projects.map((p) => p.repoPath))}
        />
      )}
      {snapshot.projects.length === 0 ? (
        <div className="notice">
          <strong>등록된 프로젝트가 없습니다.</strong>
          {snapshot.configMissing && (
            <p className="warn">
              설정 파일이 없습니다: <code>{snapshot.configPath}</code>
            </p>
          )}
          <p>
            돌고 있는 tmux 세션은 여기에 자동으로 나타납니다. "등록"을 누르면
            프로젝트가 되고 설정 파일이 만들어집니다.
          </p>
          <p>
            아직 세션이 없으면 위의 "+ tmux 세션 만들기"로 시작하세요. 먼저
            둘러보려면 <code>npm run demo</code> 로 데모 모드를 실행할 수
            있습니다.
          </p>
        </div>
      ) : (
        <div className="cards">
          {shown.map((p) => (
            <ProjectCard key={p.id} p={p} now={snapshot.generatedAt} />
          ))}
        </div>
      )}
    </>
  );
}

/** 설정에 없는 tmux 세션 카드의 "미등록" 표시와 등록·숨김 버튼. 카드 전체가 링크라 클릭이 새지 않게 막는다. */
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
      <span
        className="dim"
        title="설정에 없는 tmux 세션. 세션이 닫히면 카드도 사라집니다"
      >
        미등록
      </span>
      <button
        type="button"
        disabled={busy}
        title="이 세션을 지금 경로로 프로젝트에 등록합니다"
        onClick={act(() =>
          api.createSession({
            name: session,
            repoPath: p.repoPath,
            tmuxSession: session,
            allowInput: false,
          }),
        )}
      >
        등록
      </button>
      <button
        type="button"
        disabled={busy}
        title="대시보드에서 숨깁니다. 설정 화면의 숨긴 세션 목록에서 되돌릴 수 있습니다"
        onClick={act(() => api.hideSession(session))}
      >
        숨김
      </button>
    </span>
  );
}

export function ProjectCard({ p, now }: { p: ProjectSnapshot; now: string }) {
  const { git, tmux, status } = p;
  const last = git.recentCommits[0];
  return (
    <a
      className={`card state-${status.state}`}
      href={`#/project/${encodeURIComponent(p.id)}`}
    >
      <div className="card-head">
        <h2>{p.name}</h2>
        {p.id.startsWith("tmux:") && <DiscoveredActions p={p} />}
        <Badge state={status.state} />
      </div>
      <Reasons reasons={status.reasons} />
      {/* 라벨 없이 위계로 읽힌다. 무엇인지는 title 로 보조한다 */}
      <div className="card-rows">
        {git.ok ? (
          <>
            <div>
              {BRANCH_ICON}
              <span
                className="mono clip branch"
                title={`브랜치: ${git.branch}`}
              >
                {git.branch}
              </span>
              <span className="end" title="커밋되지 않은 변경">
                {git.clean ? (
                  "변경 없음"
                ) : (
                  <>
                    파일 {git.changedFiles.length}개{" "}
                    <span className="add">+{git.additions}</span>{" "}
                    <span className="del">−{git.deletions}</span>
                  </>
                )}
              </span>
            </div>
            <div>
              {COMMIT_ICON}
              <span className="clip" title={last?.subject}>
                {last ? last.subject : <span className="dim">커밋 없음</span>}
              </span>
              {last && (
                <span className="end" title="마지막 커밋">
                  {relTime(last.date, now)}
                </span>
              )}
            </div>
          </>
        ) : git.error === NOT_A_REPO ? (
          <div className="dim">{git.error}</div>
        ) : (
          <div className="err wrap">
            {git.error ?? "Git 정보를 읽을 수 없습니다"}
          </div>
        )}
        <div>
          {!tmux.configured ? (
            <span className="dim">세션 미등록</span>
          ) : (
            <>
              {SESSION_ICON}
              <span
                className="mono clip session"
                title={`tmux 세션: ${p.tmuxSession}`}
              >
                {p.tmuxSession}
              </span>
              {tmux.exists ? (
                <span className="end" title="마지막 터미널 활동">
                  {relTime(tmux.lastOutputChangeAt ?? tmux.lastActivityAt, now)}
                </span>
              ) : (
                <span className="end err">세션 없음</span>
              )}
            </>
          )}
        </div>
      </div>
      <div className="card-path" title={p.repoPath}>
        {p.repoPath}
      </div>
    </a>
  );
}
