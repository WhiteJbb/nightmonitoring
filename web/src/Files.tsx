import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ProjectSnapshot } from '../../shared/types.ts';
import { api, ApiError, errorMessage } from './api.ts';

/** 목록에 한 번에 그리는 파일 수 (더 많으면 이름으로 찾아 좁힌다) */
const SHOWN = 200;

// 저장하지 않은 내용은 이 브라우저 탭에 남겨 둔다: 다른 탭을 보고 와도, 새로고침해도 이어서 고친다.
// 그 내용이 기댄 지문(version)도 같이 둬서, 그 사이 파일이 바뀌었으면 저장할 때 서버가 알린다
interface Draft {
  text: string;
  version: string;
}
// 저장소 경로까지 넣는다: 설정에서 경로를 바꾸면 같은 이름의 다른 파일이 된다
const scopeOf = (p: ProjectSnapshot) => `${p.id}:${p.repoPath}`;
const draftKey = (scope: string, path: string) => `draft:${scope}:${path}`;
// 진행 중인 저장. 저장하는 사이에 다시 연 편집기는 이게 끝난 뒤에 불러온다 (안 그러면 저장 전 지문을 쥐고 있게 된다)
const pendingSaves = new Map<string, Promise<unknown>>();
// 브라우저 저장소가 가득 찼거나 쓸 수 없으면 이 페이지의 메모리에라도 둔다 (탭을 오가는 동안은 남는다)
const memory = new Map<string, string>();
const store = {
  // 메모리에 있으면 그게 더 새 것이다 (저장소에 쓰다 실패한 뒤의 내용)
  get: (key: string): string | null => {
    try {
      return memory.get(key) ?? sessionStorage.getItem(key);
    } catch {
      return memory.get(key) ?? null;
    }
  },
  set: (key: string, value: string | null) => {
    memory.delete(key);
    try {
      if (value === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, value);
    } catch {
      if (value !== null) memory.set(key, value);
    }
  },
};
const loadDraft = (key: string): Draft | null => {
  try {
    return JSON.parse(store.get(key) ?? 'null') as Draft | null;
  } catch {
    return null;
  }
};

/** 파일 탭: 저장소 파일을 골라 열고 고친다 (서버: files.ts). 마지막에 연 파일은 탭을 다시 열면 그대로 열린다 */
export function FilesTab({ project: p }: { project: ProjectSnapshot }) {
  const openKey = `open:${scopeOf(p)}`;
  const [open, setOpen] = useState(() => store.get(openKey));
  const choose = (path: string | null) => {
    store.set(openKey, path);
    setOpen(path);
  };
  // 저장소 경로가 바뀌면 편집기를 새로 만든다
  return open ? <Editor key={p.repoPath} project={p} path={open} onClose={() => choose(null)} /> : <FileList project={p} onOpen={choose} />;
}

function FileList({ project: p, onOpen }: { project: ProjectSnapshot; onOpen: (path: string) => void }) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // Git 에 변화가 있으면 다시 받는다 (에이전트가 만든 새 파일)
  useEffect(() => {
    api.files(p.id).then(
      (r) => {
        setFiles(r.files);
        setError(null);
      },
      (e: unknown) => setError(errorMessage(e)),
    );
  }, [p.id, p.repoPath, p.lastGitChangeAt]);
  if (error) {
    return (
      <p className="err" role="alert">
        {error}
      </p>
    );
  }
  if (!files) return <p className="dim">불러오는 중…</p>;
  const q = query.trim().toLowerCase();
  const matches = q ? files.filter((f) => f.toLowerCase().includes(q)) : files;
  // 지운 파일은 열 수 없으니 뺀다
  const changed = p.git.changedFiles.filter((f) => files.includes(f.path));
  const unsaved = (path: string) => store.get(draftKey(scopeOf(p), path)) !== null;
  const item = (path: string, status?: string) => (
    <li key={path}>
      {status !== undefined && <span className="xy">{status}</span>}
      <button type="button" className="file-link" onClick={() => onOpen(path)}>
        {path}
      </button>
      {unsaved(path) && <span className="warn">저장 안 함</span>}
    </li>
  );
  return (
    <>
      <input type="search" className="file-search" placeholder="파일 이름으로 찾기" aria-label="파일 찾기" value={query} onChange={(e) => setQuery(e.target.value)} />
      {!q && changed.length > 0 && (
        <section>
          <h3>바뀐 파일 ({changed.length})</h3>
          <ul className="rows">{changed.map((f) => item(f.path, f.status))}</ul>
        </section>
      )}
      <section>
        <h3>{q ? `찾은 파일 (${matches.length})` : `모든 파일 (${files.length})`}</h3>
        <ul className="rows">{matches.slice(0, SHOWN).map((f) => item(f))}</ul>
        {matches.length > SHOWN && <p className="hint">{matches.length - SHOWN}개 더 있습니다. 이름으로 찾아 좁히세요.</p>}
      </section>
    </>
  );
}

function Editor({ project: p, path, onClose }: { project: ProjectSnapshot; path: string; onClose: () => void }) {
  const key = draftKey(scopeOf(p), path);
  // 디스크의 내용과 지문
  const [file, setFile] = useState<{ content: string; version: string } | null>(null);
  const [text, setText] = useState('');
  // 입력칸은 줄바꿈을 LF 로 바꿔 돌려준다. CRLF 파일은 저장할 때 되돌려 놓는다 (안 그러면 한 글자만 고쳐도 모든 줄이 바뀐다)
  const [crlf, setCrlf] = useState(false);
  // 지금 고치는 내용이 기댄 지문 (되살린 내용이면 그때의 것)
  const [base, setBase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 불러오는 동안은 고치지 못하게 한다 (응답이 그 사이 친 내용을 덮는다)
  const [loading, setLoading] = useState(true);
  // 디스크에서 못 연 파일의 저장 안 한 내용: 보여만 준다 (복사해 두라고)
  const [orphan, setOrphan] = useState(false);
  // 닫은 편집기의 늦은 응답이 다시 연 편집기의 초안을 건드리지 않게
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = async (keepDraft: boolean) => {
    setLoading(true);
    await pendingSaves.get(key)?.catch(() => {});
    return api.file(p.id, path).then(
      (f) => {
        if (!alive.current) return;
        const draft = keepDraft ? loadDraft(key) : null;
        if (!keepDraft) store.set(key, null);
        const content = f.content.replace(/\r\n/g, '\n');
        setCrlf(content !== f.content);
        setFile({ content, version: f.version });
        setText(draft?.text ?? content);
        setBase(draft?.version ?? f.version);
        setNotice(draft ? '저장하지 않은 내용을 되살렸습니다' : null);
        setError(null);
        setConflict(false);
        setOrphan(false);
        setLoading(false);
      },
      (e: unknown) => {
        if (!alive.current) return;
        setError(errorMessage(e));
        setLoading(false);
        // 그 사이 파일이 지워졌거나 이름이 바뀌었어도 고친 내용은 꺼내 볼 수 있게
        const draft = keepDraft ? loadDraft(key) : null;
        if (draft) {
          setText(draft.text);
          setOrphan(true);
        }
      },
    );
  };
  useEffect(() => {
    void load(true);
  }, [p.id, path]);

  const dirty = file !== null && text !== file.content;
  const edit = (value: string) => {
    setText(value);
    setNotice(null);
    // 저장하는 동안에는 지우지 않는다: 원래 내용으로 되돌려도 저장이 끝나면 그건 '안 저장한 내용'이 된다 (끝날 때 정리한다)
    store.set(key, !saving && file && value === file.content && base === file.version ? null : JSON.stringify({ text: value, version: base } satisfies Draft));
  };
  const save = () => {
    // 불러오는 중에는 막는다: 늦게 온 응답이 저장한 것을 옛 내용으로 덮는다
    if (!file || saving || loading || !p.allowInput) return;
    const sent = text;
    const sentBase = base;
    setSaving(true);
    setError(null);
    const saved = api.saveFile(p.id, { path, content: crlf ? sent.replace(/\n/g, '\r\n') : sent, version: sentBase });
    pendingSaves.set(key, saved);
    void saved
      .finally(() => {
        if (pendingSaves.get(key) === saved) pendingSaves.delete(key);
      })
      .catch(() => {});
    saved
      .then(
        ({ version }) => {
          // 남은 초안은 저장소에서 본다 (그 사이 탭을 나갔다 다시 열어 고쳤을 수도 있다):
          // 이 저장이 남긴 것이면 지우고, 그 뒤에 더 고친 것이면 새 지문에 기대어 남겨 둔다
          const draft = loadDraft(key);
          if (draft?.text === sent) store.set(key, null);
          else if (draft?.version === sentBase) store.set(key, JSON.stringify({ text: draft.text, version } satisfies Draft));
          setFile({ content: sent, version });
          setBase(version);
          setNotice('저장했습니다');
        },
        (e: unknown) => {
          setError(errorMessage(e));
          setConflict(e instanceof ApiError && e.status === 409);
        },
      )
      .finally(() => setSaving(false));
  };
  const reload = () => {
    // 처음 불러오기가 실패했으면 아직 되살린 내용이 없다: 다시 시도할 때도 되살린다
    if (!file) return void load(true);
    if (dirty && !window.confirm('고친 내용을 버리고 디스크의 내용을 다시 불러올까요?')) return;
    void load(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  };

  return (
    <div className="editor">
      <div className="editor-bar">
        <button type="button" className="more-rows" onClick={onClose}>
          ← 목록
        </button>
        <span className="mono grow wrap editor-path">{path}</span>
        {dirty && <span className="warn">저장 안 함</span>}
        <button type="button" className="more-rows" disabled={loading} onClick={reload} title="디스크의 지금 내용으로 다시 불러옵니다">
          다시 불러오기
        </button>
        {p.allowInput && (
          <button type="button" className="primary" disabled={!dirty || saving || loading} onClick={save} title="⌘S / Ctrl+S">
            {saving ? '저장하는 중…' : '저장'}
          </button>
        )}
      </div>
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      {conflict && <p className="hint">고친 내용이 필요하면 복사해 둔 뒤 "다시 불러오기"를 누르세요.</p>}
      {notice && (
        <p className="dim" role="status">
          {notice}
        </p>
      )}
      {!p.allowInput && <p className="hint">보기만 할 수 있습니다. 고치려면 설정에서 이 프로젝트의 "터미널 입력 허용"을 켜세요.</p>}
      {orphan && <p className="hint">디스크에서 파일을 열지 못해 저장하지 않은 내용만 보여 줍니다. 필요하면 복사해 두세요.</p>}
      {(file || orphan) && (
        <textarea
          className="editor-text"
          aria-label={`${path} 내용`}
          value={text}
          readOnly={!p.allowInput || loading || orphan}
          wrap="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => edit(e.target.value)}
          onKeyDown={onKeyDown}
        />
      )}
    </div>
  );
}
