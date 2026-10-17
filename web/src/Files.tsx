import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, MouseEvent, ReactNode, RefObject } from 'react';
import type { FsOp, ProjectSnapshot } from '../../shared/types.ts';
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
/** 옮긴 파일(폴더면 그 안의 파일들)의 초안을 새 경로로 옮긴다 */
function moveDrafts(scope: string, from: string, to: string) {
  const prefix = draftKey(scope, from);
  const keys = new Set(memory.keys());
  try {
    for (let i = 0; i < sessionStorage.length; i++) keys.add(sessionStorage.key(i)!);
  } catch {
    // 저장소를 못 쓰면 메모리 것만
  }
  for (const key of keys) {
    const rest = key.slice(prefix.length);
    if (!key.startsWith(prefix) || (rest !== '' && !from.endsWith('/') && !rest.startsWith('/'))) continue;
    const value = store.get(key);
    store.set(key, null);
    store.set(draftKey(scope, to + rest), value);
  }
}
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

/** 폴더 하나: 하위 폴더와 그 안의 파일(저장소 기준 전체 경로) */
interface Dir {
  dirs: Map<string, Dir>;
  files: string[];
}
/** dirs: 파일이 없어도 보여 줄 폴더 ("a/b/" 꼴, 여기서 만든 빈 폴더) */
function buildTree(paths: string[], dirs: string[] = []): Dir {
  const root: Dir = { dirs: new Map(), files: [] };
  const walk = (parts: string[]) => {
    let dir = root;
    for (const part of parts) {
      let next = dir.dirs.get(part);
      if (!next) dir.dirs.set(part, (next = { dirs: new Map(), files: [] }));
      dir = next;
    }
    return dir;
  };
  for (const path of paths) walk(path.split('/').slice(0, -1)).files.push(path);
  for (const d of dirs) walk(d.split('/').filter(Boolean));
  return root;
}
const baseName = (path: string) => path.replace(/\/$/, '').slice(path.replace(/\/$/, '').lastIndexOf('/') + 1);
/** "a/b.txt" 의 폴더 "a/" (맨 위면 "") */
const parentOf = (path: string) => path.replace(/\/$/, '').slice(0, path.replace(/\/$/, '').lastIndexOf('/') + 1);
/** 복사본 이름: "b.txt" → "b copy.txt", "b copy 2.txt"… */
const copyName = (name: string, n: number) => {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  return `${stem} copy${n > 1 ? ` ${n}` : ''}${ext}`;
};

/** 메뉴처럼 잠깐 펼치는 것: 바깥을 누르거나 Esc 면 닫는다 */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeRef.current();
    };
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', esc);
    };
  }, [ref, open]);
}

// 복사·잘라내기 한 것. 편집기를 열었다 돌아와도 남게 모듈에 둔다. 다른 프로젝트에 붙이지 않게 어디 것인지(scope)도 둔다
let clipboard: { scope: string; path: string; cut: boolean } | null = null;
/** 끌어서 옮길 때 실어 보내는 종류 */
const DRAG_TYPE = 'application/x-nightshift-path';

function FileList({ project: p, onOpen }: { project: ProjectSnapshot; onOpen: (path: string) => void }) {
  const [list, setList] = useState<{ files: string[]; ignored: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // 무시된 파일(.env) 이 생기거나 지워진 것은 Git 변화로 잡히지 않아서 직접 다시 받는 버튼을 둔다
  const [refresh, setRefresh] = useState(0);
  // 펼친 폴더 ("src/"꼴). 파일을 열었다 돌아와도 그대로다
  const treeKey = `tree:${scopeOf(p)}`;
  const [open, setOpen] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(store.get(treeKey) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const setOpenDirs = (next: Set<string>) => {
    setOpen(next);
    store.set(treeKey, JSON.stringify([...next]));
  };
  const toggle = (dir: string) => {
    const next = new Set(open);
    if (!next.delete(dir)) next.add(dir);
    setOpenDirs(next);
  };
  // 여기서 만든 빈 폴더: Git 은 파일만 알아서 목록에 안 나온다
  const emptyKey = `emptyDirs:${scopeOf(p)}`;
  const [emptyDirs, setEmptyDirs] = useState<string[]>(() => {
    try {
      return JSON.parse(store.get(emptyKey) ?? '[]') as string[];
    } catch {
      return [];
    }
  });
  const saveDirs = (next: string[]) => {
    setEmptyDirs(next);
    store.set(emptyKey, JSON.stringify(next));
  };
  /** 지우거나 옮기거나 복사한 뒤 빈 폴더 기억을 맞춘다 (Git 목록으로는 바로잡을 수 없다) */
  const followDirs = (op: FsOp, path: string, to?: string) => {
    const from = path.endsWith('/') ? path : `${path}/`;
    const dest = to && `${to.replace(/\/+$/, '')}/`;
    const under = (d: string) => d.startsWith(from);
    if (op === 'delete') saveDirs(emptyDirs.filter((d) => !under(d)));
    else if (op === 'move' && dest) saveDirs(emptyDirs.map((d) => (under(d) ? dest + d.slice(from.length) : d)));
    else if (op === 'copy' && dest) saveDirs([...new Set([...emptyDirs, ...emptyDirs.filter(under).map((d) => dest + d.slice(from.length))])]);
  };
  // 파일 다루기: 입력 허용 프로젝트만 (서버도 같은 조건으로 막는다)
  const canEdit = p.allowInput;
  const [menu, setMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(menuRef, menu !== null, () => setMenu(null));
  const [clip, setClip] = useState(clipboard?.scope === scopeOf(p) ? clipboard : null);
  const [opError, setOpError] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);

  const known = useMemo(() => new Set(list?.files), [list]);
  const ignored = useMemo(() => new Set(list?.ignored), [list]);
  const all = useMemo(() => (list ? [...list.files, ...list.ignored].sort() : []), [list]);
  const tree = useMemo(() => buildTree(all, emptyDirs), [all, emptyDirs]);
  // Git 에 변화가 있으면 다시 받는다 (에이전트가 만든 새 파일)
  useEffect(() => {
    // 새로 받기 시작하면 앞의 응답은 버린다 (늦게 와도 새 목록을 덮지 않게)
    let current = true;
    api.files(p.id).then(
      (r) => {
        if (!current) return;
        setList(r);
        setError(null);
      },
      (e: unknown) => current && setError(errorMessage(e)),
    );
    return () => {
      current = false;
    };
  }, [p.id, p.repoPath, p.lastGitChangeAt, refresh]);
  if (error) {
    return (
      <p className="err" role="alert">
        {error}
      </p>
    );
  }
  if (!list) return <p className="dim">불러오는 중…</p>;

  /** 작업 하나를 보내고 목록을 다시 받는다. 실패하면 위에 알린다 */
  const act = async (op: FsOp, path: string, to?: string) => {
    setMenu(null);
    setOpError(null);
    try {
      await api.fsOp(p.id, to === undefined ? { op, path } : { op, path, to });
      followDirs(op, path, to);
      // 저장 안 한 내용도 따라간다
      if (op === 'move' && to) moveDrafts(scopeOf(p), path, path.endsWith('/') ? `${to.replace(/\/+$/, '')}/` : to);
      setRefresh((n) => n + 1);
      return true;
    } catch (e) {
      setOpError(errorMessage(e));
      return false;
    }
  };
  const ask = (message: string, initial = '') => window.prompt(message, initial)?.trim() || null;
  const newFile = async (dir: string) => {
    const name = ask(`새 파일 이름 (${dir || '맨 위'} 안, "폴더/이름" 도 됩니다)`);
    if (name && (await act('newFile', dir + name))) onOpen(dir + name);
  };
  const newDir = async (dir: string) => {
    const name = ask(`새 폴더 이름 (${dir || '맨 위'} 안)`);
    if (!name) return;
    const path = `${dir}${name.replace(/\/+$/, '')}/`;
    if (await act('newDir', path)) {
      saveDirs([...new Set([...emptyDirs, path])]);
      setOpenDirs(new Set([...open, ...(dir ? [dir] : []), path]));
    }
  };
  const rename = async (path: string) => {
    const to = ask('새 이름 또는 옮길 경로', path.replace(/\/$/, ''));
    if (to && to !== path.replace(/\/$/, '')) await act('move', path, to);
  };
  const remove = async (path: string) => {
    const untracked = !path.endsWith('/') && !known.has(path) ? '\nGit 에 없는 파일이라 Git 으로는 되살릴 수 없습니다.' : '';
    if (window.confirm(`"${path}" 을(를) 지울까요?\n지운 것은 .git/nightshift-trash 에 7일 동안 남습니다.${untracked}`)) await act('delete', path);
  };
  const copy = (path: string, cut: boolean) => {
    clipboard = { scope: scopeOf(p), path, cut };
    setClip(clipboard);
    setMenu(null);
  };
  /** dir 안으로 붙여넣기. 복사는 같은 이름이 있으면 "이름 copy" 로, 잘라내기는 옮긴다 */
  const paste = async (dir: string) => {
    if (!clipboard || clipboard.scope !== scopeOf(p)) return;
    const { path, cut } = clipboard;
    const name = baseName(path);
    if (cut) {
      if (await act('move', path, dir + name)) {
        clipboard = null;
        setClip(null);
      }
      return;
    }
    setMenu(null);
    setOpError(null);
    // 같은 이름이 있으면 409: 다음 이름으로
    for (let n = 0; n < 20; n++) {
      try {
        const to = dir + (n === 0 ? name : copyName(name, n));
        await api.fsOp(p.id, { op: 'copy', path, to });
        followDirs('copy', path, to);
        return setRefresh((k) => k + 1);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409)) return setOpError(errorMessage(e));
      }
    }
    setOpError('같은 이름이 너무 많습니다');
  };
  const duplicate = async (path: string) => {
    clipboard = { scope: scopeOf(p), path, cut: false };
    await paste(parentOf(path));
    clipboard = clip;
  };

  // 끌어서 옮기기 (컴퓨터): 행을 폴더나 맨 위 영역에 놓는다
  const dragProps = (path: string) =>
    canEdit ? { draggable: true, onDragStart: (e: DragEvent) => e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ scope: scopeOf(p), path })) } : {};
  const dropProps = (dir: string) =>
    canEdit
      ? {
          onDragOver: (e: DragEvent) => {
            if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
            e.preventDefault();
            e.stopPropagation();
            setDropOn(dir);
          },
          onDragLeave: () => setDropOn((d) => (d === dir ? null : d)),
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setDropOn(null);
            // 다른 창의 다른 프로젝트에서 끌어온 것은 받지 않는다 (같은 이름의 엉뚱한 파일을 옮기게 된다)
            let from = '';
            try {
              const drag = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as { scope: string; path: string };
              if (drag.scope === scopeOf(p)) from = drag.path;
            } catch {
              return;
            }
            // 제자리나 자기 안으로는 옮기지 않는다
            if (from && parentOf(from) !== dir && !dir.startsWith(from)) void act('move', from, dir + baseName(from));
          },
        }
      : {};

  const menuFor = (path: string) => {
    const dir = path.endsWith('/');
    const items: [string, () => void][] = [
      ...(dir
        ? ([
            ['새 파일…', () => void newFile(path)],
            ['새 폴더…', () => void newDir(path)],
          ] as [string, () => void][])
        : ([['열기', () => onOpen(path)]] as [string, () => void][])),
      ...(dir && clip ? ([[`붙여넣기 (${baseName(clip.path)})`, () => void paste(path)]] as [string, () => void][]) : []),
      ['이름 바꾸기·옮기기…', () => void rename(path)],
      ['복제', () => void duplicate(path)],
      ['복사', () => copy(path, false)],
      ['잘라내기', () => copy(path, true)],
      ['지우기…', () => void remove(path)],
    ];
    return (
      <div className="menu row-menu" role="menu" ref={menuRef}>
        {items.map(([label, run]) => (
          <button key={label} type="button" role="menuitem" className={label.startsWith('지우기') ? 'danger' : undefined} onClick={run}>
            {label}
          </button>
        ))}
      </div>
    );
  };
  // 행 끝의 ⋯ 와 그 메뉴. 우클릭도 같은 메뉴를 연다. 같은 파일이 '바뀐 파일'과 트리에 다 있으니 어느 쪽 행인지(where)로 가른다
  const actions = (path: string, where: string) =>
    canEdit && (
      <>
        <button type="button" className="row-more" aria-label={`${path} 메뉴`} aria-haspopup="menu" aria-expanded={menu === where + path} onClick={() => setMenu(menu === where + path ? null : where + path)}>
          ⋯
        </button>
        {menu === where + path && menuFor(path)}
      </>
    );
  const onContext = (path: string, where: string) => (e: MouseEvent) => {
    if (!canEdit) return;
    e.preventDefault();
    setMenu(where + path);
  };

  const q = query.trim().toLowerCase();
  const matches = q ? all.filter((f) => f.toLowerCase().includes(q)) : [];
  // 지운 파일은 열 수 없으니 뺀다
  const changed = p.git.changedFiles.filter((f) => known.has(f.path));
  const unsaved = (path: string) => store.get(draftKey(scopeOf(p), path)) !== null;
  const item = (path: string, where: string, { status, label = path, depth = 0 }: { status?: string; label?: string; depth?: number } = {}) => (
    <li key={path} style={depth ? { paddingLeft: depth * 18 } : undefined} onContextMenu={onContext(path, where)} {...dragProps(path)}>
      {status !== undefined && <span className="xy">{status}</span>}
      <button type="button" className={ignored.has(path) ? 'file-link dim' : 'file-link'} onClick={() => onOpen(path)}>
        {label}
      </button>
      {ignored.has(path) && <span className="dim">무시됨</span>}
      {unsaved(path) && <span className="warn">저장 안 함</span>}
      {clip?.path === path && <span className="dim">{clip.cut ? '잘라냄' : '복사함'}</span>}
      {actions(path, where)}
    </li>
  );
  // 폴더를 먼저, 그다음 파일. 펼친 폴더만 그 안을 그린다
  const rows = (dir: Dir, prefix: string, depth: number): ReactNode[] => [
    ...[...dir.dirs.keys()].sort().flatMap((name) => {
      const path = `${prefix}${name}/`;
      const isOpen = open.has(path);
      return [
        <li key={path} className={dropOn === path ? 'drop' : undefined} style={depth ? { paddingLeft: depth * 18 } : undefined} onContextMenu={onContext(path, 'tree:')} {...dragProps(path)} {...dropProps(path)}>
          <button type="button" className="file-link folder" aria-expanded={isOpen} onClick={() => toggle(path)}>
            {isOpen ? '▾' : '▸'} {name}/
          </button>
          {clip?.path === path && <span className="dim">{clip.cut ? '잘라냄' : '복사함'}</span>}
          {actions(path, 'tree:')}
        </li>,
        ...(isOpen ? rows(dir.dirs.get(name)!, path, depth + 1) : []),
      ];
    }),
    // 한 폴더에 파일이 아주 많으면 앞의 것만 (나머지는 이름으로 찾는다)
    ...dir.files.slice(0, SHOWN).map((f) => item(f, 'tree:', { label: baseName(f), depth })),
    ...(dir.files.length > SHOWN
      ? [
          <li key={`${prefix}…`} className="hint" style={{ paddingLeft: depth * 18 }}>
            {dir.files.length - SHOWN}개 더 있습니다. 이름으로 찾으세요.
          </li>,
        ]
      : []),
  ];
  return (
    <>
      <div className="file-tools">
        <input type="search" className="file-search" placeholder="파일 이름으로 찾기" aria-label="파일 찾기" value={query} onChange={(e) => setQuery(e.target.value)} />
        {canEdit && (
          <>
            <button type="button" className="more-rows" onClick={() => void newFile('')}>
              새 파일
            </button>
            <button type="button" className="more-rows" onClick={() => void newDir('')}>
              새 폴더
            </button>
            {clip && (
              <button type="button" className="more-rows" onClick={() => void paste('')} title="맨 위 폴더에 붙여넣습니다">
                붙여넣기
              </button>
            )}
          </>
        )}
        <button type="button" className="more-rows" onClick={() => setRefresh(refresh + 1)} title="파일 목록을 다시 받습니다">
          새로고침
        </button>
      </div>
      {opError && (
        <p className="err" role="alert">
          {opError}
        </p>
      )}
      {!q && changed.length > 0 && (
        <section>
          <h3>바뀐 파일 ({changed.length})</h3>
          <ul className="rows">{changed.slice(0, SHOWN).map((f) => item(f.path, 'changed:', { status: f.status }))}</ul>
          {changed.length > SHOWN && <p className="hint">{changed.length - SHOWN}개 더 있습니다. 이름으로 찾아 좁히세요.</p>}
        </section>
      )}
      {q ? (
        <section>
          <h3>찾은 파일 ({matches.length})</h3>
          <ul className="rows">{matches.slice(0, SHOWN).map((f) => item(f, 'found:'))}</ul>
          {matches.length > SHOWN && <p className="hint">{matches.length - SHOWN}개 더 있습니다. 이름으로 더 좁히세요.</p>}
        </section>
      ) : (
        <section className={dropOn === '' ? 'drop-root drop' : 'drop-root'} {...dropProps('')}>
          <h3>모든 파일 ({all.length})</h3>
          <ul className="rows tree">{rows(tree, '', 0)}</ul>
        </section>
      )}
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
  // 입력칸은 줄바꿈을 LF 로만 돌려준다. CRLF 와 LF 가 섞였거나 CR 만 있는 파일은 저장하면 고치지 않은 줄까지 바뀌므로 보기만 한다
  const [mixed, setMixed] = useState(false);
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
  // 마지막으로 시작한 불러오기만 반영한다: 늦게 온 옛 응답(닫은 편집기의 것 포함)이 저장한 내용·초안을 덮지 않게
  const loads = useRef(0);
  useEffect(
    () => () => {
      loads.current++;
    },
    [],
  );

  const load = async (keepDraft: boolean) => {
    const mine = ++loads.current;
    setLoading(true);
    await pendingSaves.get(key)?.catch(() => {});
    return api.file(p.id, path).then(
      (f) => {
        if (mine !== loads.current) return;
        const content = f.content.replace(/\r\n/g, '\n');
        // 디스크와 같은 초안은 이미 저장된 것이다 (응답 전에 새로고침한 경우): 지우고 지금 지문을 쓴다
        const stored = keepDraft ? loadDraft(key) : null;
        const draft = stored?.text === content ? null : stored;
        if (!draft) store.set(key, null);
        setCrlf(content !== f.content);
        setMixed((content !== f.content && /(^|[^\r])\n/.test(f.content)) || content.includes('\r'));
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
        if (mine !== loads.current) return;
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
    if (!file || saving || loading || mixed || !p.allowInput) return;
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
    if (saving) return;
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
        <button type="button" className="more-rows" disabled={loading || saving} onClick={reload} title="디스크의 지금 내용으로 다시 불러옵니다">
          다시 불러오기
        </button>
        {p.allowInput && (
          <button type="button" className="primary" disabled={!dirty || saving || loading || mixed} onClick={save} title="⌘S / Ctrl+S">
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
      {mixed && <p className="hint">줄바꿈이 섞였거나(CRLF·LF) CR 만 쓰는 파일이라 여기서는 보기만 합니다. 저장하면 고치지 않은 줄까지 바뀝니다.</p>}
      {orphan && <p className="hint">디스크에서 파일을 열지 못해 저장하지 않은 내용만 보여 줍니다. 필요하면 복사해 두세요.</p>}
      {(file || orphan) && (
        <textarea
          className="editor-text"
          aria-label={`${path} 내용`}
          value={text}
          readOnly={!p.allowInput || loading || orphan || mixed}
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
