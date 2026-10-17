import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { Annotation, Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';

// 바깥(디스크에서 다시 읽기 등)에서 문서를 갈아 끼운 변경. 사용자 편집이 아니니 onChange 를 부르지 않는다
const External = Annotation.define<boolean>();
// 컴파트먼트는 설정 칸의 이름표일 뿐이라 편집기 여러 개가 나눠 써도 된다
const langPart = new Compartment();
const readOnlyPart = new Compartment();
const wrapPart = new Compartment();
const labelPart = new Compartment();

const ink = '#e8ebf2';
// 검색 칸·버튼: 앱의 알약 모양에 맞추고 높이를 맞춘다 (앱의 전역 button 규칙이 섞여 들어와서)
const field = { color: ink, backgroundColor: 'rgba(255, 255, 255, 0.06)', backgroundImage: 'none', border: '1px solid rgba(255, 255, 255, 0.16)', borderRadius: '999px', fontSize: '12px', padding: '0 12px', minHeight: '30px' };
// 앱 테마와 상관없이 터미널 색 판 위에 놓이므로 늘 어둡게 (oneDark 테마는 배경이 달라 글자 색만 빌린다)
const theme = EditorView.theme(
  {
    '&': { height: '70vh', minHeight: '40vh', color: ink, backgroundColor: 'var(--term)', borderRadius: '20px', overflow: 'hidden', fontSize: 'var(--fs-code, 13px)' },
    '&.cm-focused': { outline: 'none', boxShadow: '0 0 0 1px rgba(255, 255, 255, 0.3)' },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono)', lineHeight: '1.55' },
    '.cm-content': { caretColor: ink, padding: '14px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: ink },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'rgba(255, 255, 255, 0.18)' },
    '.cm-gutters': { backgroundColor: 'var(--term)', color: 'rgba(255, 255, 255, 0.35)', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.04)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(255, 255, 255, 0.04)', color: 'rgba(255, 255, 255, 0.7)' },
    '.cm-foldPlaceholder': { backgroundColor: 'rgba(255, 255, 255, 0.08)', border: 'none', color: ink },
    '.cm-searchMatch': { backgroundColor: 'rgba(114, 161, 255, 0.35)', outline: '1px solid #457dff' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(255, 159, 67, 0.45)' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(170, 254, 102, 0.1)' },
    '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'rgba(186, 208, 248, 0.28)' },
    '.cm-panels': { backgroundColor: '#0d1119', color: ink },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid rgba(255, 255, 255, 0.1)' },
    '.cm-panels.cm-panels-bottom': { borderTop: '1px solid rgba(255, 255, 255, 0.1)' },
    '.cm-textfield': field,
    '.cm-button': { ...field, '&:hover, &:active': { backgroundImage: 'none', backgroundColor: 'rgba(255, 255, 255, 0.14)' } },
    '.cm-panel.cm-search label': { fontSize: '12px', color: 'rgba(255, 255, 255, 0.75)' },
    '.cm-panel.cm-search [name=close]': { color: 'rgba(255, 255, 255, 0.7)' },
    // 터치: 44pt 이상, iOS 가 확대하지 않는 글자 크기 (styles.css 의 터치 규칙과 같은 기준)
    '@media (pointer: coarse)': { '.cm-textfield, .cm-button': { minHeight: '44px', fontSize: '16px' } },
    '.cm-tooltip': { backgroundColor: '#161b26', color: ink, border: '1px solid rgba(255, 255, 255, 0.12)' },
  },
  { dark: true },
);

// 읽기 전용이어도 Tab 으로 들어가 고르고 복사하고 찾을 수 있게 (editable 을 끄면 포커스를 못 받는다)
const readOnlyExt = (ro: boolean) => [EditorState.readOnly.of(ro), EditorView.editable.of(!ro), ...(ro ? [EditorView.contentAttributes.of({ tabindex: '0' })] : [])];

/** CodeMirror 6 편집기. 뷰는 한 번만 만들고, 읽기 전용·줄바꿈·언어는 컴파트먼트로 그 자리에서 바꾼다 */
export default function CodeEditor({ value, onChange, path, readOnly, wrap, onSave, ariaLabel }: { value: string; onChange: (value: string) => void; path: string; readOnly: boolean; wrap: boolean; onSave: () => void; ariaLabel: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // 콜백이 바뀌어도 편집기를 다시 만들지 않는다 (키맵·리스너는 늘 최신 것을 부른다)
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };

  // 뷰는 마운트 때 한 번만 만든다. 이후 값·설정은 아래 효과들이 반영한다
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const save = () => {
      cb.current.onSave();
      return true;
    };
    const v = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: value,
        extensions: [
          // ⌘S·Ctrl+S 는 브라우저 저장 창 대신 저장. 다른 키맵보다 먼저 받는다
          Prec.high(keymap.of([{ key: 'Mod-s', run: save, preventDefault: true }])),
          basicSetup,
          keymap.of([indentWithTab]),
          syntaxHighlighting(oneDarkHighlightStyle),
          theme,
          // 아래 효과들이 같은 커밋 안에서 곧바로 채운다
          langPart.of([]),
          readOnlyPart.of([]),
          wrapPart.of([]),
          labelPart.of([]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((t) => t.annotation(External))) cb.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === value) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value }, annotations: External.of(true) });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: [readOnlyPart.reconfigure(readOnlyExt(readOnly)), wrapPart.reconfigure(wrap ? EditorView.lineWrapping : []), labelPart.reconfigure(EditorView.contentAttributes.of({ 'aria-label': ariaLabel }))] });
  }, [readOnly, wrap, ariaLabel]);

  useEffect(() => {
    const desc = LanguageDescription.matchFilename(languages, path);
    // 이미 받아 둔 언어는 바로, 모르는 파일은 일반 텍스트로
    view.current?.dispatch({ effects: langPart.reconfigure(desc?.support ?? []) });
    if (!desc || desc.support) return;
    let live = true;
    // 받는 사이 닫히거나 다른 파일로 바뀌면 버린다. 못 받으면 일반 텍스트로 둔다
    desc.load().then(
      (lang) => {
        if (live) view.current?.dispatch({ effects: langPart.reconfigure(lang) });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [path]);

  return <div className="code-editor" ref={host} />;
}
