import type { AgentKind } from '../../shared/types.ts';
import { useState } from 'react';
import { ArrowRight } from '@phosphor-icons/react';
import type { FormEvent } from 'react';
import { api, ApiError } from './api.ts';
import { fitSize } from './termsize.ts';

/** 서버가 clone 을 허용하는 주소 형식 (server/git.ts 의 GIT_URL_RE 와 같다) */
const GIT_URL_RE = /^(https:\/\/[\w.-]+(:\d+)?\/[\w.~/-]+|ssh:\/\/[\w.-]+@?[\w.-]+(:\d+)?\/[\w.~/-]+|[\w.-]+@[\w.-]+:[\w.~/-]+)$/;

/** 주소의 마지막 경로 조각 (".git" 제거). 서버의 repoNameFrom 과 같다. 아직 덜 적은 주소면 빈 문자열 */
export const repoNameFrom = (url: string) =>
  GIT_URL_RE.test(url.trim()) ? (url.trim().replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() ?? '') : '';

const ALLOW_INPUT_CONFIRM =
  '새 세션에 브라우저에서 키 입력을 보낼 수 있게 됩니다.\n대시보드에 접속할 수 있는 사람은 누구나 이 Mac 계정으로 명령을 실행할 수 있습니다.\n\n켤까요?';

/** 프로젝트 이름에서 tmux 세션 이름 후보를 만든다 (tmux 는 공백, ":", "." 을 받지 않는다). */
export const sessionNameFrom = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[\s:.;]+/g, '-')
    .replace(/^[-$=@%]+|-+$/g, '');

/**
 * 등록된 프로젝트들이 가장 많이 모여 있는 상위 디렉터리 (끝에 "/" 포함). 새 세션의 경로 기본값으로 쓴다.
 * 프로젝트가 없으면 빈 문자열.
 */
export function commonParentDir(repoPaths: string[]): string {
  const counts = new Map<string, number>();
  for (const p of repoPaths) {
    const parent = p.replace(/\/+$/, '').replace(/[^/]+$/, '');
    if (parent && parent !== '/') counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  let best = '';
  for (const [dir, n] of counts) if (n > (counts.get(best) ?? 0)) best = dir;
  return best;
}

/** 대시보드에서 새 tmux 세션을 만들고 바로 프로젝트로 등록하는 접이식 폼. */
const AGENTS: [AgentKind | '', string][] = [
  ['', '셸만'],
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
];

export function NewSession({ defaultDir = '' }: { defaultDir?: string }) {
  const [open, setOpen] = useState(false);
  const [gitUrl, setGitUrl] = useState('');
  // 이름·경로·세션 이름은 사용자가 직접 고치기 전까지(null) 앞 칸에서 만든 값을 따라간다.
  // 이름과 경로는 Git 주소의 저장소 이름, 세션 이름은 프로젝트 이름
  const [nameEdit, setName] = useState<string | null>(null);
  const [pathEdit, setRepoPath] = useState<string | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [allowInput, setAllowInput] = useState(false);
  // 만들자마자 띄울 에이전트 ('' = 셸만)
  const [agent, setAgent] = useState<AgentKind | ''>('');
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const repo = repoNameFrom(gitUrl);
  const name = nameEdit ?? repo;
  // Git 주소를 적으면 같은 폴더 아래에 받는다. 아니면 비워 둔다 (서버가 홈 폴더에서 연다)
  const repoPath = pathEdit ?? (repo ? defaultDir + repo : '');
  const [more, setMore] = useState(false);
  const tmuxSession = session ?? sessionNameFrom(name);
  const cloning = busy && gitUrl.trim() !== '';

  if (!open) {
    return (
      <button type="button" className="new-session-toggle" onClick={() => setOpen(true)}>
        + tmux 세션 만들기
      </button>
    );
  }

  // 뚝 사라지지 않게 짧게 흐려진 뒤 닫는다. 퇴장은 등장(180ms)보다 빠르게.
  const close = () => {
    setClosing(true);
    setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, 120);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    api
      // 지금 보는 화면에 맞는 크기로 만든다: 터미널 탭에서 가로 스크롤이 생기지 않게
      .createSession({ name: name.trim() || tmuxSession, repoPath: repoPath.trim(), tmuxSession, allowInput, ...(gitUrl.trim() ? { gitUrl: gitUrl.trim() } : {}), ...(agent ? { agent } : {}), ...fitSize(null) })
      .then(({ id }) => {
        // 새 프로젝트의 터미널 화면으로 바로 이동한다
        window.location.hash = `#/project/${encodeURIComponent(id)}`;
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err : new Error(String(err)));
        setBusy(false);
      });
  };

  return (
    <form className={closing ? 'settings new-session closing' : 'settings new-session'} onSubmit={submit} aria-busy={busy}>
      <h3>tmux 세션 만들기</h3>
      <p className="hint">세션 이름만 적고 에이전트를 고르면 바로 띄웁니다. 저장소를 받거나 폴더를 정하려면 "자세히"를 펼치세요.</p>
      <div className="settings-grid">
        <div className="field">
          <label>
            <span>tmux 세션 이름</span>
            <input
              type="text"
              className="mono"
              required
              spellCheck={false}
              value={tmuxSession}
              disabled={busy}
              onChange={(e) => setSession(e.target.value)}
            />
          </label>
          <p className="hint">공백, ":", "." 은 쓸 수 없습니다</p>
        </div>
        <div className="field">
          <span id="agent-label" className="field-label">
            바로 시작할 에이전트
          </span>
          {/* 세 가지 중 하나: 알약 안에서 고른 칸만 밝다 (탭과 같은 모양) */}
          <div className="seg" role="radiogroup" aria-labelledby="agent-label">
            {AGENTS.map(([value, label]) => (
              <button key={value} type="button" role="radio" aria-checked={agent === value} disabled={busy} onClick={() => {
                  setAgent(value);
                  // 에이전트를 띄우는 건 지시하려는 것이다: 입력 허용도 같이 켠다 (끌 수 있다)
                  if (value) setAllowInput(true);
                }}>
                {label}
              </button>
            ))}
          </div>
          <p className="hint">{agent ? `새 세션에서 ${agent} 를 띄우고 터미널 입력을 켭니다. 이미 있던 세션이면 건드리지 않습니다` : '셸만 띄웁니다'}</p>
        </div>
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={allowInput}
              disabled={busy}
              onChange={(e) => {
                if (e.target.checked && !window.confirm(ALLOW_INPUT_CONFIRM)) return;
                setAllowInput(e.target.checked);
              }}
            />
            터미널 입력 허용
          </label>
          <p className="hint">켜면 만들자마자 터미널 탭에서 입력을 보낼 수 있습니다</p>
        </div>
      </div>
      <details className="more-fields" open={more} onToggle={(e) => setMore(e.currentTarget.open)}>
        <summary>자세히 (Git 저장소·폴더·프로젝트 이름)</summary>
        <div className="settings-grid">
          <div className="field">
            <label>
              <span>Git 저장소 주소 (선택)</span>
              <input
                type="text"
                className="mono"
                spellCheck={false}
                placeholder="https://github.com/me/my-app.git"
                value={gitUrl}
                disabled={busy}
                onChange={(e) => setGitUrl(e.target.value)}
              />
            </label>
            <p className="hint">적으면 저장소 경로에 먼저 clone 합니다. 비공개 저장소는 이 Mac 의 SSH 키·자격 증명을 씁니다</p>
          </div>
          <div className="field">
            <label>
              <span>프로젝트 이름</span>
              <input type="text" placeholder="비우면 세션 이름" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
            </label>
          </div>
          <div className="field">
            <label>
              <span>저장소 경로</span>
              <input
                type="text"
                className="mono"
                spellCheck={false}
                placeholder="비우면 홈 폴더 (~)"
                value={repoPath}
                disabled={busy}
                // 미리 채운 폴더 뒤에 바로 이어 쓸 수 있게 커서를 끝에 둔다
                onFocus={(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
                onChange={(e) => setRepoPath(e.target.value)}
              />
            </label>
          </div>
        </div>
      </details>
      {/* 누른 버튼 바로 위에 둔다: 휴대폰에서는 버튼 아래가 화면 밖이기 쉽다 */}
      {cloning && (
        <p className="hint pending" role="status">
          저장소를 받는 중… 큰 저장소는 몇 분 걸릴 수 있습니다. 끝나면 터미널 화면으로 넘어갑니다.
        </p>
      )}
      <div className="row">
        <button type="submit" className="primary cta" disabled={busy}>
          {busy ? (cloning ? '저장소를 받는 중…' : '만드는 중…') : '만들기'}
          {!busy && <ArrowRight size={18} weight="bold" aria-hidden="true" />}
        </button>
        <button type="button" onClick={close} disabled={busy || closing}>
          닫기
        </button>
      </div>
      {error && (
        <div className="notice error" role="alert">
          <strong>세션을 만들지 못했습니다.</strong>
          <p>{error.message}</p>
          {error instanceof ApiError && error.issues.length > 0 && (
            <ul className="mono">
              {error.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}

/** 등록된 세션이 꺼져 있을 때: 같은 이름으로 다시 만든다. */
export function StartSession({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState(false);
  const [agent, setAgent] = useState<AgentKind | ''>('');
  const [error, setError] = useState<string | null>(null);
  const start = () => {
    setBusy(true);
    setError(null);
    // 성공하면 다음 스냅샷에서 세션이 나타나 이 화면이 터미널로 바뀐다. 그때까지 "시작하는 중…"을 유지한다
    api.startSession(projectId, { ...fitSize(null), ...(agent ? { agent } : {}) }).then(
      () => setTimeout(() => setBusy(false), 15_000),
      (e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      },
    );
  };
  return (
    <>
      <div className="seg" role="radiogroup" aria-label="함께 띄울 에이전트">
        {AGENTS.map(([value, label]) => (
          <button key={value} type="button" role="radio" aria-checked={agent === value} disabled={busy} onClick={() => setAgent(value)}>
            {label}
          </button>
        ))}
      </div>{' '}
      <button type="button" onClick={start} disabled={busy}>
        {busy ? '시작하는 중…' : '세션 시작'}
      </button>
      <p className="hint">저장소 경로에서 같은 이름의 새 세션을 만듭니다. 고르면 에이전트까지 띄웁니다.</p>
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
