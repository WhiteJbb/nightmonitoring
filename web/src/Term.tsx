import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TermEvent } from '../../shared/types.ts';
import { api, errorMessage } from './api.ts';
import { charWidth } from './termsize.ts';

/** 'connecting' | 'live' | 'down' | 'exit' 또는 서버가 보낸 오류 메시지 */
export type TermStatus = string;

export const TERM_FONT = "'JetBrains Mono Variable', 'Term Hangul', ui-monospace, 'SF Mono', Menlo, monospace";
export const TERM_FONT_SIZE = 13;
/** 한 요청에 넣는 raw 바이트 상한 (서버의 MAX_RAW_BYTES 와 같다) */
const RAW_CHUNK = 4096;

// SGR 마우스 보고 중 버튼 없는 이동: 코드의 하위 2비트가 3(버튼 없음)이고 32(이동) 비트가 켜진 것
// eslint-disable-next-line no-control-regex -- 터미널 이스케이프 시퀀스를 다룬다
const MOTION_RE = /\x1b\[<(?:35|39|43|47|51|55|59|63);\d+;\d+[Mm]/g;
const LINE_HEIGHT = 1.2;
/** 터미널이 차지할 수 있는 화면 높이 비율 */
const TERM_MAX_VIEWPORT = 0.7;
/** 휠을 이만큼(px) 굴릴 때마다 PgUp/PgDn 한 번 */
const WHEEL_PAGE_PX = 120;
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
      lineHeight: LINE_HEIGHT,
      disableStdin: !canInput,
      cursorBlink: canInput,
      theme: { background: '#05070c', foreground: '#e8ebf2', cursor: '#e8ebf2', selectionBackground: 'rgba(255, 255, 255, 0.25)' },
    });
    term.open(el);

    // pane 이 영역보다 넓거나 화면보다 높으면 글자를 줄인다 (9px 아래로는 안 간다).
    // 터미널 전체가 한 화면에 들어와야 그 위에서 쓸기를 프로그램 스크롤로 쓸 수 있다
    const fitFont = () => {
      const width = el.clientWidth;
      if (!width) return;
      const perPx = charWidth(`${TERM_FONT_SIZE}px ${TERM_FONT}`) / TERM_FONT_SIZE;
      const byWidth = Math.floor(width / (term.cols * perPx));
      // 줄 높이는 글꼴 지표에 따라 글자 크기의 1.2배보다 크다. 그려진 화면에서 실제 비율을 잰다
      const screen = el.querySelector<HTMLElement>('.xterm-screen');
      const size = Number(term.options.fontSize) || TERM_FONT_SIZE;
      const ratio = screen && screen.clientHeight > 0 ? screen.clientHeight / term.rows / size : LINE_HEIGHT * 1.3;
      const byHeight = Math.floor((window.innerHeight * TERM_MAX_VIEWPORT) / (term.rows * ratio));
      term.options.fontSize = Math.max(9, Math.min(TERM_FONT_SIZE, byWidth, byHeight));
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

    // 휠: 마우스를 받는 프로그램(Claude Code)엔 xterm 이 휠 보고를 보낸다. 마우스를 안 받는 전체 화면 프로그램(Codex)엔
    // xterm 이 화살표 키로 바꿔 보내는데, 거기선 화살표가 입력 기록 탐색이다. 대신 PgUp/PgDn 으로 넘긴다
    let wheelAcc = 0;
    term.attachCustomWheelEventHandler((ev) => {
      if (!canInput || term.buffer.active.type !== 'alternate' || term.modes.mouseTrackingMode !== 'none') return true;
      wheelAcc += ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
      while (Math.abs(wheelAcc) >= WHEEL_PAGE_PX) {
        const down = wheelAcc > 0;
        wheelAcc -= down ? WHEEL_PAGE_PX : -WHEEL_PAGE_PX;
        queue += down ? '\x1b[6~' : '\x1b[5~';
      }
      void flush();
      ev.preventDefault();
      return false;
    });
    // 터치: 대체 화면엔 xterm 스크롤백이 없어 손가락으로 쓸어도 아무 일이 없다. 쓴 거리만큼 휠 이벤트로 바꿔 위 경로를 탄다
    let lastY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      lastY = e.touches.length === 1 ? e.touches[0]!.clientY : null;
    };
    const onTouchMove = (e: TouchEvent) => {
      // 일반 화면은 xterm 이 스크롤백을 손가락으로 직접 움직인다
      if (lastY === null || term.buffer.active.type !== 'alternate') return;
      const t = e.touches[0]!;
      const dy = lastY - t.clientY;
      if (Math.abs(dy) < 8) return;
      lastY = t.clientY;
      e.preventDefault();
      // 컴퓨터의 휠처럼 쓸기는 터미널 안을 움직인다. 보기 전용이라 프로그램에 보낼 수 없거나, 터미널이 화면보다 커서
      // 일부가 영영 안 보일 때만 페이지를 움직인다 (xterm 이 터치 이동을 막아 페이지가 저절로는 안 움직인다)
      const r = el.getBoundingClientRect();
      if (!canInput || (r.height > window.innerHeight && ((dy > 0 && r.bottom > window.innerHeight + 1) || (dy < 0 && r.top < -1)))) {
        window.scrollBy(0, dy);
        return;
      }
      const target = el.querySelector('.xterm-screen') ?? el;
      target.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, deltaMode: 0, clientX: t.clientX, clientY: t.clientY, bubbles: true, cancelable: true }));
    };
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });

    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fitFont) : null;
    ro?.observe(el);
    return () => {
      input.dispose();
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      ro?.disconnect();
      es.close();
      term.dispose();
    };
  }, [projectId, pane, canInput]);

  return <div ref={host} className="xterm-host" aria-label="터미널" />;
}
