import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TermEvent } from '../../shared/types.ts';
import { api, errorMessage } from './api.ts';
import { charWidth } from './termsize.ts';

/** 'connecting' | 'live' | 'down' | 'exit' 또는 서버가 보낸 오류 메시지 */
export type TermStatus = string;

export const TERM_FONT = "'JetBrains Mono Variable', ui-monospace, 'SF Mono', Menlo, monospace";
export const TERM_FONT_SIZE = 13;
/** 한 요청에 넣는 raw 바이트 상한 (서버의 MAX_RAW_BYTES 와 같다) */
const RAW_CHUNK = 4096;

// SGR 마우스 보고 중 버튼 없는 이동: 코드의 하위 2비트가 3(버튼 없음)이고 32(이동) 비트가 켜진 것
// eslint-disable-next-line no-control-regex -- 터미널 이스케이프 시퀀스를 다룬다
const MOTION_RE = /\x1b\[<(?:35|39|43|47|51|55|59|63);\d+;\d+[Mm]/g;
const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const encode = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));

/**
 * pane 하나를 실제 터미널(xterm.js)로 그린다. 서버의 SSE 스트림(첫 화면 + 이어지는 바이트)을 그대로 쓰고,
 * 입력이 허용된 프로젝트면 키·마우스 보고 바이트를 pane 으로 돌려보낸다. 크기는 tmux pane 을 따른다.
 */
export function Term({ projectId, pane, canInput, onStatus, onSize }: { projectId: string; pane: string; canInput: boolean; onStatus: (s: TermStatus) => void; onSize: (cols: number, rows: number) => void }) {
  const host = useRef<HTMLDivElement>(null);
  // 콜백이 바뀌어도 터미널을 다시 만들지 않는다
  const cb = useRef({ onStatus, onSize });
  cb.current = { onStatus, onSize };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      cols: 80,
      rows: 24,
      scrollback: 5000,
      fontFamily: TERM_FONT,
      fontSize: TERM_FONT_SIZE,
      lineHeight: 1.2,
      disableStdin: !canInput,
      cursorBlink: canInput,
      theme: { background: '#05070c', foreground: '#e8ebf2', cursor: '#e8ebf2', selectionBackground: 'rgba(255, 255, 255, 0.25)' },
    });
    term.open(el);

    // pane 이 영역보다 넓으면 글자를 줄여 가로 스크롤을 피한다 (9px 아래로는 안 간다)
    const fitFont = () => {
      const width = el.clientWidth;
      if (!width) return;
      const perPx = charWidth(`${TERM_FONT_SIZE}px ${TERM_FONT}`) / TERM_FONT_SIZE;
      term.options.fontSize = Math.max(9, Math.min(TERM_FONT_SIZE, Math.floor(width / (term.cols * perPx))));
    };

    const es = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/term/${encodeURIComponent(pane)}`);
    es.onmessage = (ev: MessageEvent<string>) => {
      const e = JSON.parse(ev.data) as TermEvent;
      if (e.type === 'init') {
        // 다시 연결될 때마다 첫 화면이 다시 오므로 깨끗이 지우고 그린다
        term.reset();
        term.resize(e.cols, e.rows);
        fitFont();
        term.write(decode(e.data));
        cb.current.onStatus('live');
        cb.current.onSize(e.cols, e.rows);
      } else if (e.type === 'out') term.write(decode(e.data));
      else if (e.type === 'resize') {
        term.resize(e.cols, e.rows);
        fitFont();
        cb.current.onSize(e.cols, e.rows);
      } else {
        // 오류·종료 뒤에는 서버가 더 보내지 않는다. 재연결은 탭을 다시 열 때
        cb.current.onStatus(e.type === 'exit' ? 'exit' : e.message);
        es.close();
      }
    };
    es.onerror = () => cb.current.onStatus('down');

    // 키·마우스 보고는 묶어서 한 번에 하나씩 보낸다. 보내는 동안 모인 것은 다음 요청에 합친다
    const enc = new TextEncoder();
    let queue = '';
    let sending = false;
    const flush = async () => {
      if (sending || queue === '') return;
      sending = true;
      const bytes = enc.encode(queue);
      queue = '';
      try {
        for (let i = 0; i < bytes.length; i += RAW_CHUNK) await api.sendRaw(projectId, { pane, data: encode(bytes.subarray(i, i + RAW_CHUNK)) });
      } catch (e) {
        cb.current.onStatus(errorMessage(e));
      }
      sending = false;
      void flush();
    };
    const input = term.onData((d) => {
      if (!canInput) return; // disableStdin 이면 오지 않지만, 보기 전용 프로젝트의 바이트는 어떤 경우에도 보내지 않는다
      // 버튼을 누르지 않은 채 움직인 보고(SGR 버튼 코드 35·51·67…)는 버린다. 마우스를 스칠 때마다 요청이 나가지 않게
      d = d.replace(MOTION_RE, '');
      if (d === '') return;
      queue += d;
      void flush();
    });

    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fitFont) : null;
    ro?.observe(el);
    return () => {
      input.dispose();
      ro?.disconnect();
      es.close();
      term.dispose();
    };
  }, [projectId, pane, canInput]);

  return <div ref={host} className="xterm-host" aria-label="터미널" />;
}
