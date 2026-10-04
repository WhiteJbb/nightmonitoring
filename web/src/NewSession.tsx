import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from './api.ts';

const ALLOW_INPUT_CONFIRM =
  '새 세션에 브라우저에서 키 입력을 보낼 수 있게 됩니다.\n대시보드에 접속할 수 있는 사람은 누구나 이 Mac 계정으로 명령을 실행할 수 있습니다.\n\n켤까요?';

/** 프로젝트 이름에서 tmux 세션 이름 후보를 만든다 (tmux 는 공백, ":", "." 을 받지 않는다). */
export const sessionNameFrom = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[\s:.]+/g, '-')
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
export function NewSession({ defaultDir = '' }: { defaultDir?: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  // 대부분 같은 폴더 아래에서 작업하므로 거기까지 미리 채워 둔다
  const [repoPath, setRepoPath] = useState(defaultDir);
  // 사용자가 세션 이름을 직접 고치기 전까지는 프로젝트 이름을 따라간다
  const [session, setSession] = useState<string | null>(null);
  const [allowInput, setAllowInput] = useState(false);
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const tmuxSession = session ?? sessionNameFrom(name);

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
      .createSession({ name: name.trim(), repoPath: repoPath.trim(), tmuxSession, allowInput })
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
    <form className={closing ? 'settings new-session closing' : 'settings new-session'} onSubmit={submit}>
      <h3>tmux 세션 만들기</h3>
      <p className="hint">
        저장소 경로에서 셸만 띄운 새 세션을 만들고 프로젝트로 등록합니다. 같은 이름의 세션이 이미 있으면 그 세션을
        등록합니다.
      </p>
      <div className="settings-grid">
        <div className="field">
          <label>
            <span>프로젝트 이름</span>
            <input type="text" required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
        <div className="field">
          <label>
            <span>저장소 경로</span>
            <input
              type="text"
              className="mono"
              required
              spellCheck={false}
              placeholder="~/code/my-app"
              value={repoPath}
              // 미리 채운 폴더 뒤에 바로 이어 쓸 수 있게 커서를 끝에 둔다
              onFocus={(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
              onChange={(e) => setRepoPath(e.target.value)}
            />
          </label>
        </div>
        <div className="field">
          <label>
            <span>tmux 세션 이름</span>
            <input
              type="text"
              className="mono"
              required
              spellCheck={false}
              value={tmuxSession}
              onChange={(e) => setSession(e.target.value)}
            />
          </label>
          <p className="hint">공백, ":", "." 은 쓸 수 없습니다</p>
        </div>
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={allowInput}
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
      <div className="row">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? '만드는 중…' : '만들기'}
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
  const [error, setError] = useState<string | null>(null);
  const start = () => {
    setBusy(true);
    setError(null);
    // 성공하면 다음 스냅샷에서 세션이 나타나 이 화면이 터미널로 바뀐다
    api
      .startSession(projectId)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <button type="button" onClick={start} disabled={busy}>
        {busy ? '시작하는 중…' : '세션 시작'}
      </button>
      <p className="hint">저장소 경로에서 셸만 띄운 새 세션을 같은 이름으로 만듭니다.</p>
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
