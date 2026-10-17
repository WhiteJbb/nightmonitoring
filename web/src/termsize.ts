import type { TermSize } from '../../shared/types.ts';

/** 터미널이 차지할 수 있는 화면 높이 비율 */
export const TERM_MAX_VIEWPORT = 0.7;
/** xterm 한 줄 높이 / 글자 크기 (lineHeight 1.2 × 글꼴 지표, 실측 1.56~1.59 에 여유를 둔다) */
export const ROW_RATIO = 1.6;
/** 전체 화면 모드에서 터미널 위 띠·여백이 차지하는 높이(px) */
const FULL_CHROME = 64;
/**
 * 글자 크기 범위 [최소, 최대]. 컴퓨터는 tmux 창이 화면보다 크면(입력이 꺼져 크기를 못 바꾸는 프로젝트, 다른 터미널이 붙은 세션)
 * 6px 까지 줄여 한 화면에 다 넣고, 작으면 16px 까지 키워 빈자리를 줄인다. 휴대폰은 9px 아래로는 읽기 힘들어 가로로 밀어 본다
 */
export const fontRange = (): [number, number] => (window.matchMedia?.('(pointer: fine)').matches ? [6, 16] : [9, 13]);

/** 컴퓨터에서 터미널 아래로 남기는 여백(px)과 그래도 지키는 최소 높이 */
const BOTTOM_GAP = 24;
const MIN_HEIGHT = 240;
/**
 * 터미널이 쓸 수 있는 높이(px). 전체 화면이면 창 높이에서 위 띠만 뺀다. share: 나란히 보기에서 한 칸이 가지는 몫.
 * 컴퓨터(마우스)에서는 터미널이 시작하는 곳부터 화면 끝까지 쓴다: 위에 제목·탭이 있어 고정 비율이면 아래(입력 줄)가 잘린다.
 * 휴대폰은 아래에 입력칸·키 버튼이 와야 해서 화면의 일정 비율만 쓴다
 */
export function termHeight(full = false, share = 1): number {
  if (full) return (window.innerHeight - FULL_CHROME) * share;
  const area = window.matchMedia?.('(pointer: fine)').matches ? document.querySelector('.term-frame .split, .term-frame > .term-view') : null;
  if (area) return Math.max(MIN_HEIGHT, window.innerHeight - (area.getBoundingClientRect().top + window.scrollY) - BOTTOM_GAP) * share;
  return window.innerHeight * TERM_MAX_VIEWPORT * share;
}
const FALLBACK_CHAR = 7.8; // 13px 고정폭 글꼴의 대략적인 글자 폭 (측정할 수 없는 환경용)

/**
 * 주어진 글꼴에서 고정폭 글자 하나의 폭(px). xterm 처럼 DOM 에 그려 잰다:
 * 캔버스는 기기에 따라 웹 글꼴 대신 대체 글꼴로 재서 칸 수가 모자라고 오른쪽이 빈다
 */
export function charWidth(font: string): number {
  const span = document.createElement('span');
  span.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
  span.style.font = font;
  span.textContent = '0'.repeat(20);
  document.body.appendChild(span);
  const w = span.getBoundingClientRect().width / 20;
  span.remove();
  return w > 0 ? w : FALLBACK_CHAR;
}

/**
 * 터미널 영역에 가로 스크롤 없이 들어가는 칸·줄 수.
 * el 이 있으면 그 요소의 실제 크기와 글꼴로 재고, 없으면(세션을 만드는 시점) 화면 폭으로 어림한다.
 */
export function fitSize(el: HTMLElement | null, full = false, share = 1): TermSize {
  if (el) {
    const cs = getComputedStyle(el);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const cols = Math.floor((el.clientWidth - padX) / charWidth(cs.font || `${cs.fontSize} ${cs.fontFamily}`));
    // 높이는 터미널 내용을 따라 늘어나므로 요소가 아니라 화면 높이로 정한다 (Term 이 글자를 줄이는 기준과 같다)
    const rows = Math.floor((termHeight(full, share) - padY) / ((parseFloat(cs.fontSize) || 13) * ROW_RATIO));
    if (cols > 0 && rows > 0) return { cols, rows };
  }
  // main 의 최대 폭(1400px)과 좌우 여백(32px), 터미널 안쪽 여백·테두리(26px)를 뺀 폭
  const width = Math.min(window.innerWidth || 1280, 1400) - 32 - 26;
  // 휴대폰에서 만들어도 너무 좁지 않게 80칸은 준다 (좁은 화면은 줄바꿈 보기로 읽는다)
  return { cols: Math.max(80, Math.floor(width / charWidth("13px ui-monospace, 'SF Mono', Menlo, Consolas, monospace"))), rows: 40 };
}
