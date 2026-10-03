import { open } from 'node:fs/promises';

// CSI, OSC, 기타 ESC 시퀀스와 탭·개행을 제외한 제어 문자.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;

export const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');

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

// ponytail: 대소문자 무시 부분 문자열 매칭이라 "0 errors" 같은 줄도 걸린다.
// 오탐이 문제되면 config 의 errorPatterns 를 좁히거나 정규식 지원을 추가할 것.
export function findErrors(lines: string[], patterns: string[]): string[] {
  const needles = patterns.map((p) => p.toLowerCase());
  if (!needles.length) return [];
  return lines
    .filter((line) => {
      const lower = line.toLowerCase();
      return needles.some((n) => lower.includes(n));
    })
    .slice(-MAX_MATCHES);
}

export async function scanLog(file: string, patterns: string[]): Promise<string[]> {
  return findErrors(await tailFile(file), patterns);
}
