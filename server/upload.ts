// 웹에서 올린 이미지를 파일로 저장한다. 경로를 프롬프트에 넣으면 Claude Code·Codex 가 첨부로 읽는다.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** 신뢰할 수 없는 요청 본문({type, data(base64)})을 검증한다. 문제가 있으면 오류 메시지(문자열). */
export function parseUpload(body: unknown): { ext: string; data: Buffer } | string {
  if (typeof body !== 'object' || body === null) return '요청 본문이 필요합니다';
  const { type, data } = body as Record<string, unknown>;
  const ext = typeof type === 'string' ? IMAGE_TYPES[type] : undefined;
  if (!ext) return 'PNG, JPEG, GIF, WebP 이미지만 받습니다';
  if (typeof data !== 'string' || !data) return '이미지 데이터가 비어 있습니다';
  const buf = Buffer.from(data, 'base64');
  if (buf.length === 0) return '이미지를 읽을 수 없습니다';
  if (buf.length > MAX_UPLOAD_BYTES) return '이미지는 10MB 이하여야 합니다';
  return { ext, data: buf };
}

// ponytail: 올린 파일은 지우지 않는다. 쌓이면 .nightshift/uploads 를 비우면 된다.
/** dir 아래에 `<프로젝트>-<시각>.<ext>` 로 저장하고 절대 경로를 돌려준다. */
export async function saveUpload(dir: string, projectId: string, ext: string, data: Buffer): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${projectId.replace(/[^\w.-]+/g, '_')}-${Date.now()}.${ext}`);
  await writeFile(file, data);
  return file;
}
