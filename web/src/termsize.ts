import type { TermSize } from '../../shared/types.ts';

const FALLBACK_CHAR = 7.8; // 13px 고정폭 글꼴의 대략적인 글자 폭 (측정할 수 없는 환경용)

/** 주어진 글꼴에서 고정폭 글자 하나의 폭(px). */
function charWidth(font: string): number {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return FALLBACK_CHAR;
    ctx.font = font;
    const w = ctx.measureText('0'.repeat(20)).width / 20;
    return w > 0 ? w : FALLBACK_CHAR;
  } catch {
    return FALLBACK_CHAR;
  }
}

/**
 * 터미널 영역에 가로 스크롤 없이 들어가는 칸·줄 수.
 * el 이 있으면 그 요소의 실제 크기와 글꼴로 재고, 없으면(세션을 만드는 시점) 화면 폭으로 어림한다.
 */
export function fitSize(el: HTMLElement | null): TermSize {
  if (el) {
    const cs = getComputedStyle(el);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const line = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 13) * 1.45;
    const cols = Math.floor((el.clientWidth - padX) / charWidth(cs.font || `${cs.fontSize} ${cs.fontFamily}`));
    const rows = Math.floor((el.clientHeight - padY) / line);
    if (cols > 0 && rows > 0) return { cols, rows };
  }
  // main 의 최대 폭(1400px)과 좌우 여백(32px), 터미널 안쪽 여백·테두리(26px)를 뺀 폭
  const width = Math.min(window.innerWidth || 1280, 1400) - 32 - 26;
  // 휴대폰에서 만들어도 너무 좁지 않게 80칸은 준다 (좁은 화면은 줄바꿈 보기로 읽는다)
  return { cols: Math.max(80, Math.floor(width / charWidth("13px ui-monospace, 'SF Mono', Menlo, Consolas, monospace"))), rows: 40 };
}
