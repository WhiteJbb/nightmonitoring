// UI → tmux 키 입력. allowInput 을 켠 프로젝트에만, loopback·Tailscale 바인딩일 때만 허용된다 (app.ts).
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { InputKey } from '../shared/types.ts';
import { sendKey, sendText } from './tmux.ts';

export const INPUT_KEYS = ['Enter', 'Escape', 'Tab', 'BTab', 'Up', 'Down', 'Left', 'Right', 'PPage', 'NPage', 'BSpace', 'C-c', 'C-d', 'C-u', 'C-l'] as const satisfies readonly InputKey[];
export const MAX_INPUT_CHARS = 4000;

export type ParsedInput = { pane: string } & ({ text: string; enter: boolean } | { key: InputKey });

/** 신뢰할 수 없는 요청 본문을 검증한다. 문제가 있으면 오류 메시지(문자열). */
export function parseInput(body: unknown): ParsedInput | string {
  if (typeof body !== 'object' || body === null) return '요청 본문이 필요합니다';
  const { pane, text, enter, key } = body as Record<string, unknown>;
  if (typeof pane !== 'string' || !/^%\d+$/.test(pane)) return 'pane 이 올바르지 않습니다';
  if ((text === undefined) === (key === undefined)) return 'text 와 key 중 하나만 보내야 합니다';
  if (key !== undefined) {
    if (!(INPUT_KEYS as readonly unknown[]).includes(key)) return '허용되지 않은 키입니다';
    return { pane, key: key as InputKey };
  }
  if (typeof text !== 'string' || text === '') return 'text 는 비어 있지 않은 문자열이어야 합니다';
  if (text.length > MAX_INPUT_CHARS) return `text 는 ${MAX_INPUT_CHARS}자 이하여야 합니다`;
  if (text.includes('\0')) return 'text 에 NUL 문자를 넣을 수 없습니다';
  return { pane, text, enter: enter === true };
}

/** 입력을 tmux 로 보낸다. 실패하면 오류 메시지. */
export async function sendInput(input: ParsedInput): Promise<string | null> {
  if ('key' in input) return sendKey(input.pane, input.key);
  return (await sendText(input.pane, input.text)) ?? (input.enter ? sendKey(input.pane, 'Enter') : null);
}

/** 보낸 입력을 한 줄 JSON 으로 남긴다. 기록 실패가 입력을 막지는 않는다. */
export async function logInput(file: string, project: string, input: ParsedInput): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), project, ...input })}\n`);
  } catch (e) {
    console.error(`입력 기록 실패: ${(e as Error).message}`);
  }
}
