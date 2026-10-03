import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ProjectSnapshot, Snapshot } from '../../shared/types.ts';
import { api, errorMessage } from './api.ts';
import { dateTime, relTime } from './format.ts';
import { Badge, ProjectDetail, Reasons } from './ProjectDetail.tsx';
import { Reports } from './Reports.tsx';

type Conn = 'connecting' | 'live' | 'down';

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
  const projectId = path.startsWith('/project/') ? safeDecode(path.slice('/project/'.length)) : null;

  let page;
  if (isReports) {
    page = <Reports />;
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
      <ProjectDetail key={project.id} project={project} now={snapshot.generatedAt} />
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
          NightShift
        </a>
        {snapshot?.demo && <span className="demo-badge">DEMO</span>}
        <nav aria-label="주 메뉴">
          <a href="#/" aria-current={!isReports ? 'page' : undefined}>
            대시보드
          </a>
          <a href="#/reports" aria-current={isReports ? 'page' : undefined}>
            보고서
          </a>
        </nav>
        <div className="topbar-status">
          <span className={`conn conn-${conn}`} role="status">
            <span className="dot" aria-hidden="true" />
            {conn === 'live' ? 'live' : conn === 'down' ? '연결 끊김 / 재연결 중' : '연결 중'}
          </span>
          {snapshot && <span className="dim">갱신 {dateTime(snapshot.generatedAt)}</span>}
        </div>
      </header>
      <main>{page}</main>
    </>
  );
}

function Dashboard({ snapshot }: { snapshot: Snapshot }) {
  const s = snapshot.summary;
  const tiles: [string, number, string][] = [
    ['전체 프로젝트', s.total, ''],
    ['실행 중인 세션', s.sessionsRunning, ''],
    ['정상', s.running, 'running'],
    ['유휴', s.idle, 'idle'],
    ['정지 의심', s.stalled, 'stalled'],
    ['오류', s.error, 'error'],
  ];
  return (
    <>
      <dl className="summary">
        {tiles.map(([label, value, state]) => (
          <div key={label} className={state && value > 0 ? `tile state-${state}` : 'tile'}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {snapshot.projects.length === 0 ? (
        <div className="notice">
          <strong>등록된 프로젝트가 없습니다.</strong>
          {snapshot.configMissing && (
            <p className="warn">
              설정 파일이 없습니다: <code>{snapshot.configPath}</code>
            </p>
          )}
          <p>
            <code>config/nightshift.example.json</code> 을 <code>{snapshot.configPath}</code> 로 복사한 뒤
            프로젝트를 등록하고 서버를 다시 시작하세요.
          </p>
          <p>
            먼저 둘러보려면 <code>npm run demo</code> 로 데모 모드를 실행할 수 있습니다.
          </p>
        </div>
      ) : (
        <div className="cards">
          {snapshot.projects.map((p) => (
            <ProjectCard key={p.id} p={p} now={snapshot.generatedAt} />
          ))}
        </div>
      )}
    </>
  );
}

function ProjectCard({ p, now }: { p: ProjectSnapshot; now: string }) {
  const { git, tmux, status } = p;
  const last = git.recentCommits[0];
  return (
    <a className={`card state-${status.state}`} href={`#/project/${encodeURIComponent(p.id)}`}>
      <div className="card-head">
        <h2>{p.name}</h2>
        <Badge state={status.state} />
      </div>
      <Reasons reasons={status.reasons} />
      <dl className="kv truncate">
        <dt>경로</dt>
        <dd title={p.repoPath}>{p.repoPath}</dd>
        {git.ok ? (
          <>
            <dt>브랜치</dt>
            <dd title={git.branch}>
              <span className={git.clean ? 'ok' : 'warn'}>{git.clean ? '변경 없음' : '변경 있음'}</span> ·{' '}
              {git.branch}
            </dd>
            <dt>변경</dt>
            <dd>
              파일 {git.changedFiles.length}개 <span className="add">+{git.additions}</span>{' '}
              <span className="del">−{git.deletions}</span>
            </dd>
            <dt>최근 커밋</dt>
            <dd title={last?.subject}>{last ? `${relTime(last.date, now)} · ${last.subject}` : '커밋 없음'}</dd>
          </>
        ) : (
          <>
            <dt>Git</dt>
            <dd className="err wrap">{git.error ?? 'Git 정보를 읽을 수 없습니다'}</dd>
          </>
        )}
        <dt>tmux</dt>
        <dd>
          {!tmux.configured ? (
            <span className="dim">세션 미등록</span>
          ) : (
            <>
              <span className={tmux.exists ? 'ok' : 'err'}>{tmux.exists ? '실행 중' : '세션 없음'}</span> ·{' '}
              {p.tmuxSession}
            </>
          )}
        </dd>
        {tmux.configured && (
          <>
            <dt>마지막 활동</dt>
            <dd>{relTime(tmux.lastOutputChangeAt ?? tmux.lastActivityAt, now)}</dd>
          </>
        )}
      </dl>
    </a>
  );
}
