# NightShift 아키텍처

tmux에서 장시간 실행되는 AI 코딩 에이전트와 Git 저장소 진행 상황을 한 화면에서 보는 **로컬 전용** 대시보드.

## 원칙

- 프로세스 하나, 포트 하나. Express가 API와 프론트엔드(개발: Vite 미들웨어, 프로덕션: `dist/web` 정적 파일)를 함께 서빙한다.
- 서버는 Node의 TypeScript 네이티브 실행(type stripping, Node ≥ 22.18)으로 바로 돌린다. 서버용 빌드 단계·`tsx`·`concurrently` 없음.
- DB 없음. 상태는 메모리, 설정은 JSON, 보고서는 Markdown 파일.
- 의존성 최소: 런타임은 `express`, `react`, `react-dom` 뿐. 라우터·UI 킷·마크다운·검증 라이브러리 없음.

## 디렉터리

```
shared/types.ts        서버·UI가 공유하는 API 타입 (type-only)
server/
  index.ts             진입점: 인자 파싱, config 로드, listen(127.0.0.1)
  config.ts            JSON config 로드·검증·기본값
  exec.ts              ★ child_process를 쓰는 유일한 모듈
  git.ts               git 정보 수집 (exec.run 경유)
  tmux.ts              tmux 세션/pane 수집 (exec.run 경유)
  logs.ts              로그 파일 tail + 오류 패턴 탐지, ANSI 제거
  status.ts            상태 판정 (순수 함수)
  monitor.ts           폴링 루프, 기준점(baseline)·출력 변경 시각 추적, 구독자 알림
  runner.ts            config에 등록된 test/build 명령 실행
  report.ts            Morning Report Markdown 생성·저장·조회
  demo.ts              demo mode용 가짜 수집기
  app.ts               Express 라우트, SSE, 보안 미들웨어
  *.test.ts            vitest 단위 테스트 (exec 모듈 mock)
web/
  index.html
  src/                 React UI (해시 라우팅, 순수 CSS)
config/nightshift.example.json
reports/               생성된 보고서
.nightshift/runs/      마지막 test/build 실행의 stdout/stderr 로그
```

## 데이터 흐름

```
config.json ──> Monitor ──(refreshIntervalSec 마다)──> Collector(project)
                              │                          ├─ git.ts   ─┐
                              │                          ├─ tmux.ts  ─┼─> exec.ts ─> git / tmux
                              │                          └─ logs.ts  ─┘ (fs)
                              ├─ status.ts 로 상태 판정
                              └─ Snapshot ──> SSE(/api/events) ──> React
```

- `Monitor`는 `Collector` 인터페이스(실제/데모)만 안다. demo mode는 가짜 Collector를 꽂는 것뿐이므로 상태 판정·보고서·UI는 실제 코드 그대로 동작한다.
- 스냅샷 하나에 화면에 필요한 모든 것(터미널 100줄 포함)을 담는다. UI는 SSE로 받은 최신 스냅샷만 그린다. SSE가 끊기면 `EventSource`가 자동 재연결한다.

## 상태 판정 (`status.ts`)

우선순위: 오류 > 정지 의심 > 유휴 > 정상.

| 상태 | 조건 |
| --- | --- |
| error | 저장소 경로 없음/Git 저장소 아님, 등록된 tmux 세션 없음, 로그에서 오류 패턴 발견, 마지막 test/build 실패 |
| stalled | 출력 변화 없음 ≥ `stalledMinutes` **그리고** Git 변화 없음 ≥ `noCommitMinutes` |
| idle | 출력 변화 없음 ≥ `idleMinutes` |
| running | 그 외 |

- "출력 변경 시각": pane 캡처 내용이 이전 폴링과 달라진 시각. 최초 관측 시에는 tmux `session_activity`를 쓴다.
- "Git 변경 시각": 마지막 커밋 시각과, working tree 지문(status+numstat)이 달라진 시각 중 늦은 쪽.
- tmux 세션이 등록되지 않은 프로젝트는 Git 활동만으로 판정한다.

## 명령 실행과 보안 (`exec.ts`)

- `run(bin, args)`: `git`, `tmux`만 허용하는 allowlist + `execFile`(셸 미경유) → 인자 escaping 문제가 구조적으로 없다. 타임아웃·출력 상한 있음. 절대 throw하지 않고 `{code, stdout, stderr}`를 돌려준다.
- `runConfigured(command, cwd, timeout)`: config의 test/build 명령 전용. 셸로 실행하되 명령 문자열은 **config 파일에서만** 온다. API는 프로젝트 id와 `test|build`만 받고 본문은 읽지 않는다. cwd는 등록된 저장소 경로로 고정, 타임아웃 시 프로세스 그룹째 종료, stdout/stderr 분리 저장.
- 서버는 `127.0.0.1` 바인딩. Host 헤더가 loopback이 아니면 거부(DNS rebinding 방어), 변경 요청은 Origin이 다르면 거부(CSRF 방어).
- tmux 세션 이름은 config 로드 시 검증(`:`·`.`·공백, 선행 `-` `$` `=` `@` `%` 금지), 대상은 `=name:` 정확 일치로 지정.
- 보고서 조회는 파일명 정규식 검증으로 경로 탈출 차단.

## API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/snapshot` | 현재 스냅샷 |
| GET | `/api/events` | SSE, 폴링마다·실행 상태 변경 시 스냅샷 푸시 |
| POST | `/api/projects/:id/run/:kind` | `kind` = `test` \| `build`. 202 / 400 / 404 / 409 |
| GET | `/api/reports` | 보고서 목록 |
| GET | `/api/reports/:name` | 보고서 내용 |
| POST | `/api/reports` | Morning Report 생성 후 저장 |

## 구현 계획

1. 스캐폴드 (package.json, tsconfig strict, eslint, vite, 공유 타입)
2. config loader
3. exec + git 수집
4. tmux 수집, 로그 스캔
5. 상태 판정
6. monitor + API 서버 (SSE)
7. React 대시보드
8. test/build runner
9. Morning Report
10. demo mode
11. lint / test / build 검증, 실제 tmux·git으로 확인
12. README.md, NIGHT_REPORT.md
