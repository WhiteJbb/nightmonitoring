import { open } from 'node:fs/promises';

// CSI, OSC, 기타 ESC 시퀀스와 탭·개행을 제외한 제어 문자.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;

export const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');

// eslint-disable-next-line no-control-regex
const SGR_RE = /^\x1b\[[0-9;:]*m$/;
/** 색상용 SGR 시퀀스만 남기고 나머지 제어 시퀀스를 제거한다. */
export const keepSgr = (s: string): string => s.replace(ANSI_RE, (m) => (SGR_RE.test(m) ? m : ''));

/**
 * 패턴 목록을 줄 판정 함수로 만든다. "/…/flags" 는 정규식, 그 외는 대소문자 무시 부분 일치.
 * 정규식이 잘못되면 throw (config 검증에서 잡는다).
 */
export function compileMatcher(patterns: string[]): (line: string) => boolean {
  const tests = patterns.map((p) => {
    const m = /^\/(.+)\/([a-z]*)$/.exec(p);
    if (m) {
      const re = new RegExp(m[1]!, m[2]!.replace(/[gy]/g, ''));
      return (line: string) => re.test(line);
    }
    const needle = p.toLowerCase();
    return (line: string) => line.toLowerCase().includes(needle);
  });
  return (line) => tests.some((t) => t(line));
}

// 숫자(경과 시간·토큰 수), 점자 스피너, 흔한 스피너 글리프.
const VOLATILE_RE = /[\d\u2800-\u28ff✢✳✶✻✽✺·∗*|/\\—-]/g;
/** 스피너·카운터만 도는 화면을 "변화 없음"으로 보기 위한 비교용 정규화. */
export const stripVolatile = (s: string): string => s.replace(VOLATILE_RE, '');

const PROMPT_SCAN_LINES = 15;
/** 화면 마지막 줄들에서 입력 대기 프롬프트를 찾는다. 없으면 null. */
export function findPrompt(lines: string[], patterns: string[]): string | null {
  if (!patterns.length) return null;
  const match = compileMatcher(patterns);
  const recent = lines.filter((l) => l.trim() !== '').slice(-PROMPT_SCAN_LINES);
  return recent.find(match)?.trim() ?? null;
}

const TAIL_BYTES = 64 * 1024;
const TAIL_LINES = 200;
const MAX_MATCHES = 20;

/** 파일 끝부분을 줄 단위로 읽는다. 파일이 없거나 읽을 수 없으면 빈 배열. */
export async function tailFile(file: string): Promise<string[]> {
  let fh;
  try {
    fh = await open(file, 'r');
    const { size } = await fh.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, size - length);
    return stripAnsi(buf.toString('utf8')).split('\n').slice(-TAIL_LINES);
  } catch {
    return [];
  } finally {
    await fh?.close();
  }
}

export function findErrors(lines: string[], patterns: string[], ignore: string[] = []): string[] {
  if (!patterns.length) return [];
  const isError = compileMatcher(patterns);
  const isIgnored = compileMatcher(ignore);
  return lines.filter((line) => isError(line) && !isIgnored(line)).slice(-MAX_MATCHES);
}

export async function scanLog(file: string, patterns: string[], ignore: string[] = []): Promise<string[]> {
  return findErrors(await tailFile(file), patterns, ignore);
}
