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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
