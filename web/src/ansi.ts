// tmux pane 출력의 SGR(색상) 시퀀스를 React 스타일 조각으로 바꾸는 순수 파서.

export interface SpanStyle {
  color?: string;
  backgroundColor?: string;
  fontWeight?: 'bold';
  opacity?: number;
  fontStyle?: 'italic';
  textDecoration?: 'underline';
}

export interface Span {
  text: string;
  style: SpanStyle;
}

// 어두운 터미널 배경(#06080b)에서 읽히도록 고른 16색
const PALETTE = [
  '#5c6370', '#f87171', '#4ade80', '#e8c547', '#6ea8fe', '#c792ea', '#56c8d8', '#d6dde6',
  '#8c98a8', '#ff9b9b', '#86efac', '#fde68a', '#9cc4ff', '#e0b8ff', '#8be9fd', '#ffffff',
] as const;
const DEFAULT_FG = '#d6dde6';
const DEFAULT_BG = '#06080b';

interface State {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

const initial = (): State => ({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false });

const byte = (n: number | undefined) => Math.max(0, Math.min(255, n ?? 0));

function color256(n: number): string {
  if (n < 16) return PALETTE[n] ?? DEFAULT_FG;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const c = n - 16;
  const level = (i: number) => (i === 0 ? 0 : 55 + i * 40);
  return `rgb(${level(Math.floor(c / 36))},${level(Math.floor(c / 6) % 6)},${level(c % 6)})`;
}

/** 38/48 뒤의 확장 색을 읽는다. 반환: [색 또는 null, 소비한 파라미터 수] */
function extended(p: number[], i: number): [string | null, number] {
  if (p[i + 1] === 5) return [color256(byte(p[i + 2])), 2];
  if (p[i + 1] === 2) return [`rgb(${byte(p[i + 2])},${byte(p[i + 3])},${byte(p[i + 4])})`, 4];
  return [null, p.length]; // 알 수 없는 형식이면 나머지 파라미터를 버린다
}

function applySgr(s: State, params: string): State {
  const p = params === '' ? [0] : params.split(';').map((x) => (x === '' ? 0 : Number(x)));
  let st = s;
  for (let i = 0; i < p.length; i++) {
    const c = p[i] ?? 0;
    if (c === 0) st = initial();
    else if (c === 1) st = { ...st, bold: true };
    else if (c === 2) st = { ...st, dim: true };
    else if (c === 3) st = { ...st, italic: true };
    else if (c === 4) st = { ...st, underline: true };
    else if (c === 7) st = { ...st, inverse: true };
    else if (c === 22) st = { ...st, bold: false, dim: false };
    else if (c === 23) st = { ...st, italic: false };
    else if (c === 24) st = { ...st, underline: false };
    else if (c === 27) st = { ...st, inverse: false };
    else if (c >= 30 && c <= 37) st = { ...st, fg: PALETTE[c - 30] ?? null };
    else if (c >= 90 && c <= 97) st = { ...st, fg: PALETTE[c - 90 + 8] ?? null };
    else if (c === 39) st = { ...st, fg: null };
    else if (c >= 40 && c <= 47) st = { ...st, bg: PALETTE[c - 40] ?? null };
    else if (c >= 100 && c <= 107) st = { ...st, bg: PALETTE[c - 100 + 8] ?? null };
    else if (c === 49) st = { ...st, bg: null };
    else if (c === 38 || c === 48) {
      const [color, used] = extended(p, i);
      if (color) st = c === 38 ? { ...st, fg: color } : { ...st, bg: color };
      i += used;
    }
  }
  return st;
}

function styleOf(s: State): SpanStyle {
  const fg = s.inverse ? (s.bg ?? DEFAULT_BG) : s.fg;
  const bg = s.inverse ? (s.fg ?? DEFAULT_FG) : s.bg;
  const style: SpanStyle = {};
  if (fg) style.color = fg;
  if (bg) style.backgroundColor = bg;
  if (s.bold) style.fontWeight = 'bold';
  if (s.dim) style.opacity = 0.6;
  if (s.italic) style.fontStyle = 'italic';
  if (s.underline) style.textDecoration = 'underline';
  return style;
}

// 1) SGR (캡처)  2) 그 밖의 CSI (끝 바이트가 잘린 것 포함)  3) OSC  4) 2바이트 이스케이프 / 홀로 남은 ESC
// eslint-disable-next-line no-control-regex
const ESC_RE = /\x1b(?:\[([0-9;]*)m|\[[0-?]*[ -/]*[@-~]?|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[^[\]]?)/g;

/** 줄마다 스타일 조각 배열을 만든다. SGR 상태는 줄을 넘어 이어지고, SGR 이 아닌 이스케이프는 버린다. */
export function parseAnsi(lines: string[]): Span[][] {
  let state = initial();
  return lines.map((line) => {
    const spans: Span[] = [];
    const push = (text: string) => {
      if (text) spans.push({ text, style: styleOf(state) });
    };
    let last = 0;
    for (const m of line.matchAll(ESC_RE)) {
      push(line.slice(last, m.index));
      if (m[1] !== undefined) state = applySgr(state, m[1]);
      last = m.index + m[0].length;
    }
    push(line.slice(last));
    return spans;
  });
}
