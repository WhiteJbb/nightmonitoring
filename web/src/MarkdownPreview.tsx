import { useMemo } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import MarkdownIt from 'markdown-it';
import { api } from './api.ts';

// html: false 는 꼭 둔다: 저장소 글 속 HTML 이 이 대시보드(터미널 입력 권한이 있다)에 끼어들면 안 된다.
// 링크 검사는 기본 것(validateLink)을 쓴다: javascript:·vbscript:·file:·대부분의 data: 를 막는다
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

/** 그대로 두는 주소: 스킴이 있거나(https:, data: …) // 나 # 로 시작한다 */
const absolute = (url: string) => /^([a-z][a-z\d+.-]*:|\/\/|#)/i.test(url);

/** Markdown 파일(from) 기준 상대 주소를 저장소 맨 위 기준 경로로 (/ 로 시작하면 맨 위 기준, GitHub 처럼). 저장소 밖으로 나가면 null */
function resolvePath(from: string, url: string): string | null {
  let rel = url.split(/[?#]/)[0]!;
  try {
    // markdown-it 이 한글·빈칸을 %xx 로 바꿔 둔다
    rel = decodeURIComponent(rel);
  } catch {
    // 깨진 % 는 그대로
  }
  if (!rel) return null;
  const parts = rel.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const part of rel.split('/')) {
    if (part === '..') {
      if (parts.pop() === undefined) return null;
    } else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/') || null;
}

interface Ctx {
  id: string;
  path: string;
}
// 상대 경로 그림은 서버의 그림 주소로. 저장소 밖을 가리키면 빼 버린다
const image = md.renderer.rules.image!;
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!;
  const src = String(token.attrGet('src') ?? '');
  if (!absolute(src)) {
    const { id, path } = env as unknown as Ctx;
    const target = resolvePath(path, src);
    if (!target) return '';
    token.attrSet('src', api.rawUrl(id, target));
  }
  return image(tokens, idx, options, env, self);
};
// 바깥 링크는 새 탭에서 (이 탭은 대시보드로 남는다)
md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  const token = tokens[idx]!;
  if (/^(https?:)?\/\//i.test(String(token.attrGet('href') ?? ''))) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
  }
  return self.renderToken(tokens, idx, options);
};

/** Markdown 미리보기 (고치는 중인 내용 그대로). 저장소 안 다른 파일 링크는 onOpen 으로 파일 탭에서 연다 */
export default function MarkdownPreview({ projectId, path, text, onOpen, onSave }: { projectId: string; path: string; text: string; onOpen: (path: string) => void; onSave: () => void }) {
  const html = useMemo(() => md.render(text, { id: projectId, path } satisfies Ctx), [projectId, path, text]);
  const click = (e: MouseEvent<HTMLDivElement>) => {
    const href = (e.target as Element).closest('a')?.getAttribute('href');
    if (href == null || (absolute(href) && !href.startsWith('#'))) return;
    // # 링크도 막는다: 주소의 # 은 이 대시보드의 화면 경로라 누르면 다른 화면으로 간다
    e.preventDefault();
    const target = href.startsWith('#') ? null : resolvePath(path, href);
    if (target) onOpen(target);
  };
  // 미리보기에서도 ⌘S·Ctrl+S 는 저장 (편집기와 같게)
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      onSave();
    }
  };
  return <div className="md-preview" role="region" aria-label={`${path} 미리보기`} tabIndex={0} onClick={click} onKeyDown={key} dangerouslySetInnerHTML={{ __html: html }} />;
}
