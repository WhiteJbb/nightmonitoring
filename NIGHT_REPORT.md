# NIGHT REPORT

작성: 2026-10-04 · `context.md`의 지시를 구현한 결과 보고.

## 구현 완료 기능

| # | 요구 사항 | 상태 | 비고 |
| --- | --- | --- | --- |
| 1 | 프로젝트 대시보드 (카드) | ✅ | 이름, 경로, 브랜치, clean 여부, 변경 파일 수, +/−, 마지막 커밋·시간, tmux 실행 여부·마지막 활동, 상태 배지와 사유 |
| 2 | tmux 모니터링 | ✅ | 세션 존재·생성 시각·attached·최근 출력 100줄·출력 변경 시각, `tmux attach` 명령 복사 버튼, ANSI 제거 |
| 3 | Git 활동 추적 | ✅ | 브랜치, status, 최근 커밋 10개, 오늘 커밋, 변경 파일, diff stat, +/−, 최초 확인 시점 이후 변경 |
| 4 | 정지 감지 | ✅ | 임계값·오류 패턴·세션 종료 처리 모두 config로 조정 |
| 5 | Morning Report | ✅ | `reports/YYYY-MM-DD-morning-report.md` |
| 6 | 테스트·빌드 실행 | ✅ | config 명령만, 저장소 경로에서, 시간 제한, stdout/stderr 분리 |
| 7 | UI | ✅ | 다크 테마, 요약 스트립, 카드, 상세(터미널 / Git / 테스트·빌드), 보고서, 반응형 |
| 8 | 실시간 갱신 | ✅ | Server-Sent Events, 주기는 `refreshIntervalSec` |
| 9 | Demo mode | ✅ | 정상 / 20분 유휴 / 테스트 실패 / 세션 종료 + 정지 의심 1개 추가 |
| 10 | 문서 | ✅ | README.md, ARCHITECTURE.md, `config/nightshift.example.json` (프로젝트 2개) |

### 직접 확인한 것

- **실제 Git**: 이 저장소와 `~/repos/text-rpg-web`을 등록해 브랜치·변경 파일·커밋·기준점 이후 변경이 수집되는 것을 확인.
- **실제 tmux**: 이 머신의 `nightshift`, `rpg-game` 세션에서 생성 시각·최근 출력·출력 변경 시각이 수집되는 것을 확인.
- **오류 경로**: 존재하지 않는 경로, Git 저장소가 아닌 디렉터리, 없는 tmux 세션이 서버를 죽이지 않고 오류 카드로 표시됨.
- **실제 명령 실행**: 대시보드 API로 이 저장소의 `npm test`를 실행해 종료 코드 0과 로그 파일(`.nightshift/runs/`)을 확인. 중복 실행은 409.
- **보고서**: 실제·demo 양쪽에서 생성해 파일 저장 확인.
- **UI**: demo mode를 브라우저(1280px, 400px)로 열어 대시보드·터미널 탭·테스트·빌드 탭을 스크린샷으로 확인. 콘솔 오류 없음.
- **프로덕션**: `npm run build` 후 `npm start`로 정적 파일과 API 응답 확인.

브라우저에서 직접 눌러 보지 않은 것: 복사 버튼, "연결 끊김" 표시, 초기 로딩 실패 화면 (코드는 있음).

## 실행 방법

```bash
npm install
npm run demo                 # tmux/git 없이 전체 UI 확인
# 실제 사용
cp config/nightshift.example.json config/nightshift.json   # projects 수정
npm run dev                  # 개발 모드
npm run build && npm start   # 프로덕션 모드
```

<http://127.0.0.1:4477>

## 테스트 결과

`npm test` — **통과** (Test Files 8 passed (8) · Tests 46 passed (46))

git·tmux 명령은 `server/exec.ts`를 mock 처리. `exec.test.ts`만 실제 `sh`로 시간 제한·stdout/stderr 분리를 검증.

`npm run lint` — 오류 0.

## 빌드 결과

`npm run build` (`tsc --noEmit` strict + `vite build`) — 성공.

```
dist/web/index.html                   0.48 kB │ gzip:  0.29 kB
dist/web/assets/index-Cj_zBOwh.css    6.26 kB │ gzip:  2.10 kB
dist/web/assets/index-Ct01ESfg.js   238.03 kB │ gzip: 73.99 kB
✓ built in 72ms
```

## 주요 파일 구조

```
shared/types.ts        서버·UI 공유 API 타입
server/index.ts        진입점 (인자, config, listen 127.0.0.1)
server/config.ts       config 로드·검증·기본값
server/exec.ts         child_process 를 쓰는 유일한 모듈 (git/tmux allowlist, 등록 명령 실행)
server/git.ts          Git 수집
server/tmux.ts         tmux 수집
server/logs.ts         로그 tail, 오류 패턴, ANSI 제거
server/status.ts       상태 판정 (순수 함수)
server/monitor.ts      폴링 루프, 기준점·변경 시각 추적, 구독
server/runner.ts       테스트·빌드 실행 상태
server/report.ts       Morning Report
server/demo.ts         demo mode 수집기
server/app.ts          Express 라우트, SSE, Host/Origin 방어
server/*.test.ts       단위 테스트
web/src/               React UI (App, ProjectDetail, Reports, api, format, styles.css)
config/nightshift.example.json
```

## 보안상 제한한 기능

- 서버는 기본 `127.0.0.1` 바인딩. loopback이 아닌 주소로 바꾸면 시작 시 경고.
- 웹 UI·API에 명령 입력 경로 없음. 실행 API는 프로젝트 id와 `test|build`만 받고 요청 본문을 읽지 않음.
- git·tmux는 allowlist + `execFile`(셸 미경유, argv 전달)로만 실행.
- 테스트·빌드는 config의 명령을 등록된 저장소 경로에서만 실행, 시간 초과 시 프로세스 그룹 종료, 출력 1MB 상한.
- Host 헤더 검사(DNS rebinding), 변경 요청 Origin 검사(CSRF).
- tmux 세션 이름 검증 + `=name:` 정확 일치 대상 지정. 표시용 attach 명령은 셸 인용.
- 보고서 조회는 파일명 정규식으로 경로 탈출 차단.
- 터미널 출력은 React 텍스트로만 렌더링(HTML 주입 없음).

## 선택한 가정

- **Node ≥ 22.18의 TypeScript 네이티브 실행**을 사용해 서버 빌드 단계와 `tsx`를 없앰. `npm run build`는 타입 체크 + 프론트엔드 빌드.
- **프로세스·포트 하나**: 개발 모드에서도 Express가 Vite를 미들웨어로 품음 (`concurrently`, 프록시 없음).
- config는 **JSON만** 지원 (YAML은 의존성 추가가 필요해 제외). 검증은 손으로 작성.
- "모니터링 시작" = 서버 시작 시각. 기준점은 메모리에만 있어 **재시작하면 초기화**.
- "Git 변화" = 마지막 커밋 시각 또는 working tree 변경이 관측된 시각. 서버 시작 전의 미커밋 변경 시각은 알 수 없어 마지막 커밋 시각으로 대체.
- tmux 세션 미등록 프로젝트는 Git 활동만으로 유휴/정지를 판정.
- **마지막 테스트·빌드 실패는 오류 상태**로 표시 (demo의 "테스트가 실패한 프로젝트" 요구에 맞춤). 다시 실행해 성공하면 해제.
- 오류 패턴은 **로그 파일**에만 적용 (대소문자 무시 부분 일치, 끝 200줄). 터미널 출력에는 적용하지 않음 — 에이전트 출력에는 "0 errors" 같은 문구가 흔해 오탐이 심함.
- 최근 출력 변경 시각의 초기값은 tmux `session_activity`/`window_activity` 중 늦은 쪽. 이후에는 캡처 내용 비교로 갱신.
- 같은 날 보고서는 덮어씀. demo 보고서는 `reports/demo/`로 분리.
- 원격 저장소가 없고 "외부 서비스에 배포하지 않는다"는 조건이 있어 **PR 대신 기능 브랜치를 로컬에서 `--no-ff` 머지**함.
- UI·문서는 한국어.

## 알려진 문제 / 미완성

- config 변경은 서버 재시작 필요 (hot reload 없음).
- 기준점·실행 결과가 메모리에만 있어 서버 재시작 시 사라짐 (실행 로그 파일과 보고서는 남음).
- tmux는 세션의 활성 윈도우·활성 pane만 캡처. 여러 pane/윈도우 미지원.
- 스피너처럼 계속 바뀌는 화면은 "출력 변화"로 잡혀, 에이전트가 멈춘 채 스피너만 도는 경우를 정지로 판정하지 못함.
- diff 줄 수에 untracked 파일은 포함되지 않음 (변경 파일 목록에는 나옴).
- 로그 오류 패턴은 부분 일치라 오탐 가능. 한번 걸린 줄은 로그 끝 200줄 밖으로 밀려날 때까지 오류로 남음.
- 보고서는 화면에서 원문(Markdown 텍스트)으로 보여 줌. 렌더링 없음.
- 실행 중인 테스트·빌드를 UI에서 취소할 수 없음 (시간 제한까지 대기).
- UI 컴포넌트 테스트 없음 (서버 모듈만 단위 테스트).
- 같은 줄 수로 내용만 바뀌는 수정, 이미 untracked인 파일의 추가 수정은 "Git 변화"로 잡히지 않음 (커밋·파일 목록·줄 수 변화만 감지).
- 이름이 바뀐 파일은 `old -> new` 형태로, 특수 문자가 든 파일명은 Git이 인용한 형태로 표시됨.

### Codex 리뷰 반영

구현 후 Codex(`codex exec`, 읽기 전용)로 리뷰해 7건을 받았고 5건을 수정함: `::1` 바인딩 시 Host 검사 누락, SSE 느린 클라이언트 버퍼 누적, tmux 수집 예외 시 세션이 미등록으로 보이던 문제, 빈 저장소에서 시작했을 때 기준점 diff 누락, `$`·`=` 등으로 시작하는 세션 이름. 나머지 2건(위 두 항목)은 알려진 문제로 남김.

## 다음 버전에 추가할 기능

- 기준점·실행 이력의 디스크 저장 (재시작 후에도 밤샘 기록 유지)
- config hot reload, YAML 지원
- 다중 pane/윈도우 선택
- 상태 변화 시 macOS 알림 (정지 의심·오류 발생 시)
- 터미널 출력 색상 유지 (ANSI → 스타일 변환)
- 실행 취소 버튼, 실행 이력
- 정해진 시각에 Morning Report 자동 생성
- 프롬프트 대기 감지 (예: "Do you want to proceed?" 패턴)

## 전체 Git 커밋 목록

이 보고서를 추가한 마지막 커밋(`docs: add final night report`)과 그 머지 커밋은 목록 아래에 이어집니다. 전체는 `git log --oneline --graph`.

```
* f4cc4e8 docs: add setup guide
* db3a9e1 fix: harden host check, SSE backpressure, tmux and baseline edge cases
* 5022a16 test: cover command runner timeout and allowlist
*   191b146 Merge branch 'feat/dashboard'
|\  
| * cb4ff05 feat: build monitoring dashboard
|/  
*   caff6f0 Merge branch 'feat/api-server'
|\  
| * 6e3c85a chore: ignore browser test artifacts
| * 37e9bde feat: add API server with SSE, command runner and morning reports
|/  
*   fb90548 Merge branch 'feat/server-core'
|\  
| * 4d8a4c9 feat: add project status detection
| * 54ce415 feat: implement git and tmux monitoring
| * 858d9cb feat: add configuration and project discovery
|/  
* 3d985cf chore: initialize nightshift project
```
