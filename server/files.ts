// 웹에서 저장소 파일을 열고 고친다. 열 수 있는 파일은 Git 이 아는 것(추적 중이거나 .gitignore 에 걸리지 않은 새 파일)뿐이라,
// .env 처럼 무시된 파일과 저장소 밖은 경로를 직접 줘도 열지 않는다.
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
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

/** 저장소 기준 상대 경로 목록 (정렬). 저장소가 아니면 FileError */
export async function listFiles(repo: string): Promise<string[]> {
  const r = await run('git', ['-C', repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (r.code !== 0) throw new FileError(r.stderr.trim() || 'Git 저장소가 아닙니다', 400);
  // 충돌 중인 파일은 단계마다 한 번씩 나온다
  return [...new Set(r.stdout.split('\0').filter(Boolean))].sort().slice(0, MAX_FILES);
}

/** 목록에 있는, 저장소 안의 일반 파일의 절대 경로. 너무 큰 파일은 읽기 전에 거른다 */
async function resolve(repo: string, rel: unknown): Promise<string> {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new FileError('경로가 올바르지 않습니다', 400);
  if (!(await listFiles(repo)).includes(rel)) throw new FileError('열 수 없는 파일입니다 (Git 이 모르는 파일이거나 .gitignore 에 걸린 파일)', 404);
  const abs = path.join(repo, rel);
  const st = await lstat(abs).catch(() => null);
  if (!st?.isFile()) throw new FileError('일반 파일만 열 수 있습니다 (지워졌거나 링크입니다)', 404);
  if (st.size > MAX_FILE_BYTES) throw new FileError('1MB 보다 큰 파일은 열지 않습니다', 413);
  // 링크된 상위 폴더를 거쳐 저장소 밖으로 나가지 않게
  const [real, root] = await Promise.all([realpath(abs), realpath(repo)]);
  if (!real.startsWith(root + path.sep)) throw new FileError('저장소 밖의 파일입니다', 404);
  return abs;
}

/** UTF-8 글 파일만. 그 밖의 것을 글로 고쳐 저장하면 깨진다 */
function asText(buf: Buffer): string {
  try {
    if (buf.includes(0)) throw new Error('binary');
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new FileError('글(UTF-8) 파일만 열 수 있습니다', 415);
  }
}

export async function readText(repo: string, rel: unknown): Promise<{ content: string; version: string }> {
  const buf = await readFile(await resolve(repo, rel));
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
export async function writeText(repo: string, rel: unknown, content: unknown, version: unknown): Promise<string> {
  if (typeof content !== 'string' || typeof version !== 'string') throw new FileError('내용과 지문이 필요합니다', 400);
  const buf = Buffer.from(content, 'utf8');
  if (buf.length > MAX_FILE_BYTES) throw new FileError('1MB 보다 큰 파일은 저장하지 않습니다', 413);
  const abs = await resolve(repo, rel);
  return oneAtATime(abs, async () => {
    if (versionOf(await readFile(abs)) !== version) throw new FileError('연 뒤로 파일이 바뀌었습니다 (에이전트가 고쳤을 수 있습니다). 다시 불러온 뒤 고치세요', 409);
    await writeFile(abs, buf);
    return versionOf(buf);
  });
}
