// 웹에서 저장소 파일을 열고 고친다. 열 수 있는 파일은 Git 이 아는 것(추적 중이거나 .gitignore 에 걸리지 않은 새 파일)이고,
// .env 처럼 무시된 파일은 호출부가 허락할 때만(터미널 입력이 허용된 프로젝트) 연다. 저장소 밖과 .git 안은 경로를 직접 줘도 열지 않는다.
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
  const files = r.stdout.split('\0').filter((f) => f && !f.endsWith('/'));
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
  const files = [...(await listFiles(repo)), ...(ignoredOk ? await listIgnored(repo) : [])];
  if (!files.includes(rel)) throw new FileError(ignoredOk ? '열 수 없는 파일입니다' : '열 수 없는 파일입니다 (.gitignore 에 걸린 파일은 터미널 입력을 허용한 프로젝트에서만 엽니다)', 404);
  const root = await rootOf(repo);
  const abs = path.join(root, rel);
  const st = await lstat(abs).catch(() => null);
  if (!st?.isFile()) throw new FileError('일반 파일만 열 수 있습니다 (지워졌거나 링크입니다)', 404);
  if (st.size > MAX_FILE_BYTES) throw new FileError('1MB 보다 큰 파일은 열지 않습니다', 413);
  // 상위 폴더가 링크로 바뀌었으면 실제 파일은 다른 곳이다 (저장소 밖이나 .git 안). 실제 경로도 목록에 있어야 한다
  const [real, realRoot] = await Promise.all([realpath(abs), realpath(root)]);
  if (!files.includes(path.relative(realRoot, real).split(path.sep).join('/'))) throw new FileError('링크를 거친 파일은 열지 않습니다', 404);
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

// 두 화면에서 같은 파일을 동시에 저장하면 둘 다 지문 검사를 통과해 서로 덮거나 섞인다. 파일마다 줄 세운다
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
  const abs = await resolve(repo, rel, ignoredOk);
  const changed = async () => versionOf(await readFile(abs)) !== version;
  const conflict = () => new FileError('연 뒤로 파일이 바뀌었습니다 (에이전트가 고쳤을 수 있습니다). 다시 불러온 뒤 고치세요', 409);
  return oneAtATime(abs, async () => {
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
  });
}
