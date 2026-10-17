// 웹에서 저장소 파일을 열고 고친다. 열 수 있는 파일은 Git 이 아는 것(추적 중이거나 .gitignore 에 걸리지 않은 새 파일)이고,
// .env 처럼 무시된 파일은 호출부가 허락할 때만(터미널 입력이 허용된 프로젝트) 연다. 저장소 밖과 .git 안은 경로를 직접 줘도 열지 않는다.
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FsOp } from '../shared/types.ts';
import { run } from './exec.ts';

export const MAX_FILE_BYTES = 1024 * 1024;
/** 목록에 담는 파일 수 상한 (큰 모노레포에서 응답이 너무 커지지 않게) */
export const MAX_FILES = 20_000;

/** 응답 상태 코드를 가진 오류 (app.ts 가 그대로 돌려준다) */
export class FileError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** 내용의 지문. 저장할 때 연 뒤로 바뀌었는지 비교한다 */
const versionOf = (buf: Buffer) => createHash('sha1').update(buf).digest('hex');

/** 저장소의 맨 위 폴더. 프로젝트 경로가 저장소 안의 하위 폴더여도 경로는 Git 상태(바뀐 파일)처럼 맨 위 기준으로 쓴다 */
async function rootOf(repo: string): Promise<string> {
  const r = await run('git', ['-C', repo, 'rev-parse', '--show-toplevel']);
  if (r.code !== 0) throw new FileError(r.stderr.trim() || 'Git 저장소가 아닙니다', 400);
  return r.stdout.trim();
}

/** 저장소 맨 위 기준 상대 경로 목록 (정렬). 저장소가 아니면 FileError */
export async function listFiles(repo: string): Promise<string[]> {
  const root = await rootOf(repo);
  const [r, gone] = await Promise.all([run('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard']), run('git', ['-C', root, 'ls-files', '-z', '--deleted'])]);
  if (r.code !== 0) throw new FileError(r.stderr.trim() || 'Git 저장소가 아닙니다', 400);
  // 추적 중이지만 지운 파일은 열 수 없으니 뺀다. 충돌 중인 파일은 단계마다 한 번씩 나온다
  const deleted = new Set(gone.stdout.split('\0'));
  return [...new Set(r.stdout.split('\0').filter((f) => f && !deleted.has(f)))].sort().slice(0, MAX_FILES);
}

/**
 * .gitignore 에 걸린 파일 (.env, 로그 등). 무시된 폴더(node_modules/, dist/)는 통째로 한 줄로 나오므로 빼서
 * 그 안의 수많은 파일은 담지 않는다.
 */
export async function listIgnored(repo: string): Promise<string[]> {
  const root = await rootOf(repo);
  const r = await run('git', ['-C', root, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']);
  if (r.code !== 0) throw new FileError(r.stderr.trim() || 'Git 저장소가 아닙니다', 400);
  // 따옴표·역슬래시·제어 문자가 든 경로는 check-ignore 가 따옴표로 감싸 돌려줘 맞춰 볼 수 없다: 안전하게 뺀다
  // eslint-disable-next-line no-control-regex -- Git 이 따옴표로 감싸는 문자를 그대로 거른다
  const files = r.stdout.split('\0').filter((f) => f && !f.endsWith('/') && !/["\\\x00-\x1f\x7f]/.test(f));
  // 무시된 폴더라도 그 안에 추적 중인 파일이 있으면 접히지 않고 파일이 하나씩 나온다. 그런 폴더 안은 직접 걸러 낸다
  const parents = (f: string) => f.split('/').slice(0, -1).map((_, i, parts) => `${parts.slice(0, i + 1).join('/')}/`);
  const dirs = [...new Set(files.flatMap(parents))];
  const ignoredDirs = new Set<string>();
  for (let i = 0; i < dirs.length; i += 500) {
    // -z 는 --stdin 과만 된다. 줄 단위로 읽고, 한글 폴더 이름이 \355… 로 바뀌지 않게 quotePath 를 끈다
    const c = await run('git', ['-C', root, '-c', 'core.quotePath=false', 'check-ignore', '--no-index', '--', ...dirs.slice(i, i + 500)]);
    for (const d of c.stdout.split('\n')) if (d) ignoredDirs.add(d);
  }
  return files
    .filter((f) => !parents(f).some((d) => ignoredDirs.has(d)))
    .sort()
    .slice(0, MAX_FILES);
}

/** 목록에 있는, 저장소 안의 일반 파일의 실제 절대 경로 (링크를 푼 것: 같은 파일은 늘 같은 이름이라 저장 줄 세우기에 쓴다). 너무 큰 파일은 읽기 전에 거른다 */
async function resolve(repo: string, rel: unknown, ignoredOk: boolean): Promise<string> {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new FileError('경로가 올바르지 않습니다', 400);
  // 무시된 파일 목록은 필요할 때만 받는다 (큰 빌드 결과물이 있으면 무겁거나 실패할 수 있다: 그래도 보통 파일은 열린다)
  const tracked = await listFiles(repo);
  let ignored: string[] | null = null;
  const known = async (f: string) => tracked.includes(f) || (ignoredOk && (ignored ??= await listIgnored(repo).catch(() => [])).includes(f));
  if (!(await known(rel))) throw new FileError(ignoredOk ? '열 수 없는 파일입니다' : '열 수 없는 파일입니다 (.gitignore 에 걸린 파일은 터미널 입력을 허용한 프로젝트에서만 엽니다)', 404);
  const root = await rootOf(repo);
  const abs = path.join(root, rel);
  const st = await lstat(abs).catch(() => null);
  if (!st?.isFile()) throw new FileError('일반 파일만 열 수 있습니다 (지워졌거나 링크입니다)', 404);
  if (st.size > MAX_FILE_BYTES) throw new FileError('1MB 보다 큰 파일은 열지 않습니다', 413);
  // 상위 폴더가 링크로 바뀌었으면 실제 파일은 다른 곳이다 (저장소 밖이나 .git 안). 실제 경로도 목록에 있어야 한다
  const [real, realRoot] = await Promise.all([realpath(abs), realpath(root)]);
  // 맥에서 Foo.ts → foo.ts 로 바꾸면 Git 목록은 옛 이름으로 남는다: 파일 이름의 대소문자만 다른 것은 같은 파일로 본다.
  // 폴더 부분은 정확히 같아야 한다 (대소문자를 가리는 디스크에서 폴더를 링크로 바꿔치기한 것은 폴더 경로가 달라져 걸린다)
  const realRel = path.relative(realRoot, real).split(path.sep).join('/');
  const sameName = async () =>
    [...tracked, ...(ignoredOk ? (ignored ?? []) : [])].some((f) => path.posix.dirname(f) === path.posix.dirname(realRel) && f.toLowerCase() === realRel.toLowerCase());
  if (!(await known(realRel)) && !(await sameName())) throw new FileError('링크를 거친 파일은 열지 않습니다', 404);
  return real;
}

/** UTF-8 글 파일만. 그 밖의 것을 글로 고쳐 저장하면 깨진다 */
function asText(buf: Buffer): string {
  try {
    if (buf.includes(0)) throw new Error('binary');
    // ignoreBOM: BOM 을 글에 남겨 저장할 때 그대로 돌려놓는다 (지우면 고치지 않아도 바이트가 바뀐다)
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    throw new FileError('글(UTF-8) 파일만 열 수 있습니다', 415);
  }
}

/** ignoredOk: .gitignore 에 걸린 파일도 연다 */
export async function readText(repo: string, rel: unknown, ignoredOk = false): Promise<{ content: string; version: string }> {
  const buf = await readFile(await resolve(repo, rel, ignoredOk));
  return { content: asText(buf), version: versionOf(buf) };
}

// 두 화면에서 같은 파일을 동시에 저장하면 둘 다 지문 검사를 통과해 서로 덮거나 섞인다. 저장소마다 줄 세운다 (파일 다루기와 같은 줄)
const saving = new Map<string, Promise<unknown>>();
function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (saving.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
  saving.set(key, next);
  void next
    .finally(() => {
      if (saving.get(key) === next) saving.delete(key);
    })
    .catch(() => {});
  return next;
}

/** version 은 연 때의 지문. 그 사이 바뀌었으면(에이전트가 고쳤을 수 있다) 덮어쓰지 않는다. 새 지문을 돌려준다 */
export async function writeText(repo: string, rel: unknown, content: unknown, version: unknown, ignoredOk = false): Promise<string> {
  if (typeof content !== 'string' || typeof version !== 'string') throw new FileError('내용과 지문이 필요합니다', 400);
  const buf = Buffer.from(content, 'utf8');
  if (buf.length > MAX_FILE_BYTES) throw new FileError('1MB 보다 큰 파일은 저장하지 않습니다', 413);
  const conflict = () => new FileError('연 뒤로 파일이 바뀌었습니다 (에이전트가 고쳤을 수 있습니다). 다시 불러온 뒤 고치세요', 409);
  // 파일 다루기(옮기기·지우기)와 같은 줄에 선다: 저장 직전 확인과 바꿔 끼우기 사이에 파일이 옮겨지면 옛 이름으로 되살아난다.
  // 경로 검사도 줄 안에서 한다: 기다리는 사이 앞 요청이 폴더를 밖을 가리키는 링크로 바꿨을 수 있다
  return oneAtATime(`fs:${await rootOf(repo)}`, async () => {
    const abs = await resolve(repo, rel, ignoredOk);
    // 같은 파일이 다른 프로젝트(겹친 저장소)에서도 열려 있을 수 있어 파일 줄에도 선다
    return oneAtATime(abs, () => save(abs));
  });
  async function save(abs: string): Promise<string> {
    const changed = async () => versionOf(await readFile(abs)) !== version;
    if (await changed()) throw conflict();
    // 옆에 다 쓴 뒤 바꿔 끼운다: 쓰다 실패해도(디스크 가득 등) 원래 파일은 그대로다. 권한은 원래 것을 따른다
    const { mode } = await stat(abs);
    // 바꿔 끼우면 읽기 전용이어도 써지므로 직접 막는다
    if (!(mode & 0o200)) throw new FileError('읽기 전용 파일입니다', 403);
    // 저장마다 다른 짧은 이름 (긴 파일 이름에 붙이면 255바이트를 넘는다). wx 로 남의 것을 덮지 않는다
    const tmp = path.join(path.dirname(abs), `.nightshift-${randomUUID()}.tmp`);
    try {
      // 나만 읽을 수 있게 만든 뒤 원래 권한을 준다 (만들 때 mode 는 umask 에 깎이고, 넓게 만들면 잠깐 남이 읽을 수 있다)
      await writeFile(tmp, buf, { mode: 0o600, flag: 'wx' });
      await chmod(tmp, mode & 0o7777);
      // 쓰는 사이 에이전트가 고쳤을 수 있다: 바꿔 끼우기 직전에 한 번 더 본다
      if (await changed()) throw conflict();
      await rename(tmp, abs);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    return versionOf(buf);
  }
}

// ── 파일 다루기 (새 파일·폴더, 이동, 복사, 삭제). 터미널 입력과 같은 조건에서만 부른다 (app.ts).
// 쓰기라서 목록 규칙 대신 "저장소 안, .git 밖"만 지킨다. 무시된 폴더 안이라도 셸로 할 수 있는 일이다.

/** 지운 것은 .git 안 휴지통에 이만큼 둔다 (Git 에 없는 .env 같은 파일도 되살릴 수 있게) */
export const TRASH_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

const exists = (abs: string) => lstat(abs).then(() => true, () => false);

/** 쓰기 대상 경로: 저장소 맨 위 기준의 정규화된 상대 경로. 실제 위치(가장 가까운 기존 상위 폴더의 링크를 푼 것)도 저장소 안, .git 밖이어야 한다 */
async function target(repo: string, rel: unknown): Promise<{ abs: string; rel: string }> {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.startsWith('/')) throw new FileError('경로가 올바르지 않습니다', 400);
  const norm = rel.replace(/\/+$/, '');
  if (path.posix.normalize(norm) !== norm || norm === '.' || norm === '..' || norm.startsWith('../')) throw new FileError('경로가 올바르지 않습니다', 400);
  // 대소문자를 가리지 않는 디스크(맥)에서는 .GIT 도 .git 이다
  if (norm.split('/').some((part) => part.toLowerCase() === '.git')) throw new FileError('.git 안은 건드리지 않습니다', 400);
  const root = await rootOf(repo);
  const realRoot = await realpath(root);
  // 실제 경로의 어느 부분이든 .git 이면 (하위 저장소의 .git 을 가리키는 링크 포함) 안 된다
  const inGit = (real: string) => path.relative(realRoot, real).split(path.sep).some((part) => part.toLowerCase() === '.git');
  // 대상 자체가 링크로 .git 을 가리켜도 막는다
  const realTarget = await realpath(path.join(root, norm)).catch(() => null);
  if (realTarget && inGit(realTarget)) throw new FileError('.git 안은 건드리지 않습니다', 400);
  let dir = path.dirname(path.join(root, norm));
  for (;;) {
    const real = await realpath(dir).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
    if (real === null) {
      dir = path.dirname(dir);
      continue;
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new FileError('저장소 밖입니다', 400);
    if (inGit(real)) throw new FileError('.git 안은 건드리지 않습니다', 400);
    return { abs: path.join(root, norm), rel: norm };
  }
}

/** 폴더 안 어딘가에 .git 이 있는지 (다른 저장소·서브모듈). 링크는 따라가지 않는다. 너무 크면 확인을 포기한다 */
const SCAN_LIMIT = 50_000;
async function holdsGit(dir: string): Promise<boolean | 'too-big'> {
  const stack = [dir];
  let seen = 0;
  while (stack.length) {
    for (const entry of await readdir(stack.pop()!, { withFileTypes: true })) {
      if (entry.name.toLowerCase() === '.git') return true;
      if (++seen > SCAN_LIMIT) return 'too-big';
      if (entry.isDirectory()) stack.push(path.join(entry.parentPath, entry.name));
    }
  }
  return false;
}

/** 옮기거나 복사할 곳이 자기 안이면 안 된다 (폴더를 제 하위 폴더로) */
const inside = (child: string, parent: string) => child === parent || child.startsWith(`${parent}/`);

/** 지운 것을 .git/nightshift-trash/<시각>/<경로> 로 옮긴다. 오래된 것은 이때 비운다 */
async function toTrash(repo: string, abs: string, rel: string, now = Date.now()): Promise<void> {
  const r = await run('git', ['-C', repo, 'rev-parse', '--absolute-git-dir']);
  if (r.code !== 0) throw new FileError(r.stderr.trim() || 'Git 저장소가 아닙니다', 400);
  const trash = path.join(r.stdout.trim(), 'nightshift-trash');
  for (const name of await readdir(trash).catch(() => [])) {
    if (now - Number(name) > TRASH_KEEP_MS) await rm(path.join(trash, name), { recursive: true, force: true });
  }
  const dest = path.join(trash, String(now), rel);
  await mkdir(path.dirname(dest), { recursive: true });
  // 다른 디스크면 rename 이 안 된다: 복사한 뒤 지운다
  await rename(abs, dest).catch(async (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EXDEV') throw e;
    await cp(abs, dest, { recursive: true, verbatimSymlinks: true });
    await rm(abs, { recursive: true, force: true });
  });
}

/** 파일 다루기 하나. to 는 move·copy 에서 새 경로 */
export async function fsOp(repo: string, op: FsOp | unknown, rel: unknown, to?: unknown): Promise<void> {
  // ponytail: 저장소 하나의 파일 다루기는 하나씩 (있는지 보고 옮기는 사이 다른 요청이 같은 자리를 덮지 않게). 드문 일이라 이걸로 충분하다.
  // 경로 검사도 줄 안에서 한다: 기다리는 사이 앞 요청이 폴더를 밖을 가리키는 링크로 바꿨을 수 있다
  return oneAtATime(`fs:${await rootOf(repo)}`, async () => applyOp(repo, op, await target(repo, rel), to));
}

async function applyOp(repo: string, op: unknown, src: { abs: string; rel: string }, to: unknown): Promise<void> {
  try {
    if (op === 'newFile' || op === 'newDir') {
      if (await exists(src.abs)) throw new FileError('이미 있습니다', 409);
      if (op === 'newDir') return void (await mkdir(src.abs, { recursive: true }));
      await mkdir(path.dirname(src.abs), { recursive: true });
      return void (await writeFile(src.abs, '', { flag: 'wx' }));
    }
    if (!(await exists(src.abs))) throw new FileError('없는 파일입니다', 404);
    // 폴더째 지우거나 옮기거나 복사할 때 안에 다른 저장소(.git)가 있으면 그 기록까지 휩쓸린다
    if ((await lstat(src.abs)).isDirectory()) {
      const git = await holdsGit(src.abs);
      if (git === true) throw new FileError('안에 다른 Git 저장소(.git)가 있는 폴더는 여기서 다루지 않습니다. 터미널에서 하세요', 400);
      if (git === 'too-big') throw new FileError('폴더가 너무 커서 안을 확인할 수 없습니다. 터미널에서 하세요', 400);
    }
    if (op === 'delete') return void (await toTrash(repo, src.abs, src.rel));
    if (op !== 'move' && op !== 'copy') throw new FileError('알 수 없는 작업입니다', 400);
    const dst = await target(repo, to);
    // 같은 자리면 '이미 있음'(409): 붙여넣기는 그걸 보고 "이름 copy" 로 다시 시도한다.
    // 단, 대소문자만 바꾸는 이름 바꾸기(맥에서 Foo.ts → foo.ts)는 같은 파일을 가리키므로 허용한다
    const sameEntry = async () => {
      const [a, b] = await Promise.all([lstat(src.abs), lstat(dst.abs)]);
      return a.ino === b.ino && a.dev === b.dev;
    };
    const caseOnly = op === 'move' && dst.rel !== src.rel && dst.rel.toLowerCase() === src.rel.toLowerCase();
    if ((await exists(dst.abs)) && !(caseOnly && (await sameEntry()))) throw new FileError(`이미 있습니다: ${dst.rel}`, 409);
    if (inside(dst.rel, src.rel)) throw new FileError('자기 안으로는 옮기거나 복사할 수 없습니다', 400);
    await mkdir(path.dirname(dst.abs), { recursive: true });
    if (op === 'move') await rename(src.abs, dst.abs);
    else await cp(src.abs, dst.abs, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  } catch (e) {
    if (e instanceof FileError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    throw new FileError((e as Error).message, code === 'ENOENT' ? 404 : code === 'EEXIST' ? 409 : 400);
  }
}
