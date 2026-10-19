import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';

// iOS 는 16px 보다 작은 글자의 입력칸(코드 편집기 등)을 누르면 화면을 확대한다. maximum-scale 로 막는다.
// iOS 는 그래도 손가락으로는 확대된다. 안드로이드는 손가락 확대까지 막혀서 iOS(데스크톱처럼 보이는 iPad 포함)에만 건다
if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)) {
  document.querySelector('meta[name="viewport"]')?.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1');
}

// 페이지를 연 뒤 서버 화면이 다시 빌드되면, 나중에 받는 조각(편집기·미리보기)의 옛 파일은 지워지고 없다.
// 못 받으면 앱이 통째로 내려가 화면이 까매지므로 새 화면으로 다시 연다(연 파일·초안은 sessionStorage 에 남아 있다).
// 다시 열어도 못 받으면(서버 문제) 되풀이하지 않게 10초 안에는 한 번만
window.addEventListener('vite:preloadError', (e) => {
  try {
    if (Date.now() - Number(sessionStorage.getItem('reloadedForChunk')) < 10_000) return;
    sessionStorage.setItem('reloadedForChunk', String(Date.now()));
  } catch {
    return;
  }
  e.preventDefault();
  location.reload();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
