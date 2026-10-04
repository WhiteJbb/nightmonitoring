// Morning Report 가 쓰는 마크다운 부분집합만 그리는 렌더러.
// 지원: # / ## / ### 제목, "- " 목록, "- [ ] " / "- [x] " 체크 항목, ``` 코드 블록, "> " 인용, 문단, `code`, **bold**
import type { ReactNode } from 'react';

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*.+?\*\*)/).map((part, i) => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{inline(part.slice(2, -2))}</strong>;
    return part;
  });
}

const HEADING_RE = /^(#{1,3}) +(.*)$/;
const TASK_RE = /^\[([ xX])\] +(.*)$/;
const isBlockStart = (l: string) => HEADING_RE.test(l) || l.startsWith('- ') || l.startsWith('```') || l.startsWith('>');

export function Markdown({ source }: { source: string }) {
  const lines = source.split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const key = i;
    const heading = HEADING_RE.exec(line);
    if (line.trim() === '') {
      i++;
    } else if (line.startsWith('```')) {
      // 닫는 펜스가 없으면 끝까지 코드로 본다
      const body: string[] = [];
      for (i++; i < lines.length && !(lines[i] ?? '').startsWith('```'); i++) body.push(lines[i] ?? '');
      i++;
      out.push(
        <pre key={key} tabIndex={0}>
          {body.join('\n')}
        </pre>,
      );
    } else if (heading) {
      // 페이지에 이미 h1 이 있으므로 한 단계씩 내린다
      const Tag = (['h2', 'h3', 'h4'] as const)[(heading[1] ?? '#').length - 1] ?? 'h4';
      out.push(<Tag key={key}>{inline(heading[2] ?? '')}</Tag>);
      i++;
    } else if (line.startsWith('- ')) {
      const items: ReactNode[] = [];
      for (; i < lines.length && (lines[i] ?? '').startsWith('- '); i++) {
        const text = (lines[i] ?? '').slice(2);
        const task = TASK_RE.exec(text);
        items.push(
          task ? (
            <li key={i} className="task">
              <input type="checkbox" disabled checked={task[1] !== ' '} readOnly /> {inline(task[2] ?? '')}
            </li>
          ) : (
            <li key={i}>{inline(text)}</li>
          ),
        );
      }
      out.push(<ul key={key}>{items}</ul>);
    } else if (line.startsWith('>')) {
      const body: string[] = [];
      for (; i < lines.length && (lines[i] ?? '').startsWith('>'); i++) body.push((lines[i] ?? '').replace(/^> ?/, ''));
      out.push(<blockquote key={key}>{inline(body.join(' '))}</blockquote>);
    } else {
      const body: string[] = [];
      for (; i < lines.length && (lines[i] ?? '').trim() !== '' && !isBlockStart(lines[i] ?? ''); i++) body.push(lines[i] ?? '');
      out.push(<p key={key}>{inline(body.join(' '))}</p>);
    }
  }
  return <div className="md">{out}</div>;
}
