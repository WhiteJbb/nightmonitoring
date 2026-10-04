# NightShift

tmux에서 밤새 돌아가는 AI 코딩 에이전트와 Git 저장소의 진행 상황을 한 화면에서 확인하는 **macOS용 로컬 전용** 관제 대시보드.

- 프로젝트별 Git 상태(브랜치, 변경 파일, +/− 줄 수, 최근 커밋)와 tmux 세션 상태를 카드로 표시
- tmux pane의 최근 출력 100줄을 자동 새로고침으로 표시, `tmux attach` 명령 복사
- 정상 실행 / 유휴 / 정지 의심 / 오류 자동 판정
- config에 등록해 둔 테스트·빌드 명령을 버튼으로 실행
- 버튼 한 번으로 Markdown **Morning Report** 생성 (`reports/YYYY-MM-DD-morning-report.md`)
- 외부 DB·외부 API·API 키 없음. 서버는 `127.0.0.1`에만 바인딩

## 요구 사항

- macOS
- Node.js **22.18 이상** (서버를 TypeScript 그대로 실행합니다)
- `git`, `tmux` (demo mode에는 필요 없음)

## 설치

```bash
git clone <this-repo> nightshift
cd nightshift
npm install
```

## 실행

```bash
# 1) config 준비
cp config/nightshift.example.json config/nightshift.json
#    config/nightshift.json 을 열어 projects 를 내 저장소로 수정

# 2) 개발 모드 (프론트엔드 HMR 포함, 빌드 불필요)
npm run dev

# 또는 프로덕션 모드
npm run build
npm start
```

브라우저에서 <http://127.0.0.1:4477> 을 엽니다.

| 옵션 | 설명 |
| --- | --- |
| `--config <path>` 또는 `NIGHTSHIFT_CONFIG` | config 파일 경로 (기본 `config/nightshift.json`) |
| `--demo` 또는 `NIGHTSHIFT_DEMO=1` | demo mode |

예: `npm start -- --config ~/my-nightshift.json`

config를 수정한 뒤에는 서버를 다시 시작해야 반영됩니다. config 파일이 없으면 빈 대시보드로 시작하고, 형식이 잘못되었으면 문제 목록을 출력하고 종료합니다.

## Demo mode

tmux 세션이나 Git 저장소가 없어도 모든 화면을 볼 수 있습니다.

```bash
npm run demo
```

정상 작업 중 / 20분간 활동 없음(유휴) / 테스트 실패(오류) / tmux 세션 종료(오류) / 47분간 정지(정지 의심) 프로젝트가 표시됩니다. demo에서는 실제 명령이 실행되지 않으며, 보고서는 `reports/demo/`에 저장됩니다.

## config 작성

`config/nightshift.json` (예제: [`config/nightshift.example.json`](config/nightshift.example.json))

```json
{
  "host": "127.0.0.1",
  "port": 4477,
  "refreshIntervalSec": 5,
  "thresholds": { "idleMinutes": 15, "stalledMinutes": 30, "noCommitMinutes": 30 },
  "errorPatterns": ["error", "failed", "exception"],
  "sessionExitIsError": true,
  "commandTimeoutSec": 600,
  "reportsDir": "reports",
  "projects": [
    {
      "name": "My Web App",
      "repoPath": "~/code/my-web-app",
      "tmuxSession": "webapp-agent",
      "testCommand": "npm test",
      "buildCommand": "npm run build",
      "logFile": "logs/agent.log"
    }
  ]
}
```

`projects` 외에는 모두 생략 가능하며, 생략하면 위 값이 기본값입니다.

| 키 | 설명 |
| --- | --- |
| `refreshIntervalSec` | 상태 갱신 주기(초) |
| `thresholds.idleMinutes` | 터미널 출력이 이 시간 동안 안 바뀌면 **유휴** |
| `thresholds.stalledMinutes` | 터미널 출력이 이 시간 동안 안 바뀌고… |
| `thresholds.noCommitMinutes` | …Git 변화(커밋·working tree)도 이 시간 동안 없으면 **정지 의심** |
| `errorPatterns` | 로그 파일에서 찾을 단어(대소문자 무시, 부분 일치). `[]`이면 로그 검사 끔 |
| `sessionExitIsError` | 등록된 tmux 세션이 없을 때 오류로 표시할지 |
| `commandTimeoutSec` | 테스트·빌드 명령 실행 시간 제한(초) |
| `reportsDir` | 보고서 저장 디렉터리 |

### 프로젝트 등록

`projects` 배열에 항목을 추가하고 서버를 재시작합니다.

| 키 | 필수 | 설명 |
| --- | --- | --- |
| `name` | ✓ | 표시 이름 |
| `repoPath` | ✓ | Git 저장소 경로. `~` 사용 가능. 상대 경로는 NightShift 디렉터리 기준 |
| `tmuxSession` | | 연결할 tmux 세션 이름 |
| `testCommand` | | 테스트 명령 (저장소 경로에서 실행) |
| `buildCommand` | | 빌드 명령 (저장소 경로에서 실행) |
| `logFile` | | 오류 패턴을 검사할 로그 파일. 상대 경로는 `repoPath` 기준 |

### tmux 세션 연결

1. 에이전트를 이름 있는 세션에서 실행합니다.

   ```bash
   tmux new -s webapp-agent -c ~/code/my-web-app
   # 세션 안에서 에이전트 실행 후 Ctrl-b d 로 분리
   ```

2. 그 이름을 프로젝트의 `tmuxSession`에 적습니다. 현재 세션 목록은 `tmux ls`로 확인합니다.
3. 대시보드의 프로젝트 → **터미널** 탭에 최근 출력과 `tmux attach -t webapp-agent` 명령(복사 버튼)이 표시됩니다.

세션의 활성 윈도우·활성 pane만 캡처합니다. 세션 이름에는 공백, `:`, `.`을 쓸 수 없고 `-` `$` `=` `@` `%`로 시작할 수 없습니다.

## 상태 판정

| 상태 | 조건 |
| --- | --- |
| 오류 | 저장소 경로 없음 / Git 저장소 아님, 등록된 tmux 세션 없음, 로그에서 오류 패턴 발견, 마지막 테스트·빌드 실패 |
| 정지 의심 | 출력 변화 없음 ≥ `stalledMinutes` 그리고 Git 변화 없음 ≥ `noCommitMinutes` |
| 유휴 | 출력 변화 없음 ≥ `idleMinutes` |
| 정상 실행 | 그 외 |

tmux 세션을 등록하지 않은 프로젝트는 Git 활동만으로 판정합니다.

## 테스트·빌드 실행과 Morning Report

- 프로젝트 상세 → **테스트·빌드** 탭의 실행 버튼은 config의 `testCommand` / `buildCommand`를 그대로 실행합니다. 종료 코드, 소요 시간, stdout, stderr가 따로 표시되고 마지막 실행 로그는 `.nightshift/runs/<id>-<test|build>.{stdout,stderr}.log`에 남습니다.
- **보고서** 화면의 "Morning Report 생성" 버튼은 모니터링 시작 이후의 커밋·변경 파일·터미널 출력·오류·테스트/빌드 결과·다음 확인 항목을 프로젝트별로 정리해 `reports/YYYY-MM-DD-morning-report.md`에 저장합니다(같은 날짜는 덮어씀).
- "모니터링 시작"은 서버를 시작한 시점입니다. 서버를 재시작하면 기준점이 초기화됩니다.

## NightShift 자체의 테스트·빌드

```bash
npm run lint       # ESLint
npm test           # vitest 단위 테스트 (git/tmux 는 mock)
npm run build      # 타입 체크 + 프론트엔드 프로덕션 빌드 (dist/web)
```

## 보안 관련 주의사항

- 기본 바인딩은 `127.0.0.1`입니다. `host`를 `0.0.0.0` 등으로 바꾸면 **인증 없이** 같은 네트워크의 누구나 터미널 출력을 보고 테스트·빌드 명령을 실행할 수 있으니 바꾸지 마세요. 원격에서 보려면 SSH 포트 포워딩을 쓰세요: `ssh -L 4477:127.0.0.1:4477 my-mac`
- 웹 UI에는 명령을 입력하는 기능이 없습니다. 실행되는 것은 config에 미리 적어 둔 테스트·빌드 명령뿐이고, API는 프로젝트 id와 `test|build`만 받습니다.
- `testCommand` / `buildCommand`는 셸에서 실행됩니다. **config 파일을 수정할 수 있는 사람은 임의 명령을 실행할 수 있는 것**과 같으니 config 파일 권한을 관리하세요.
- git·tmux는 셸을 거치지 않고 인자 배열로만 실행됩니다(`server/exec.ts` 한 곳).
- loopback이 아닌 Host 헤더(DNS rebinding)와 다른 Origin에서 온 변경 요청(CSRF)은 거부합니다.
- 터미널 출력과 보고서에는 비밀 값이 포함될 수 있습니다. `reports/`는 git에서 제외되어 있습니다.

## 문제 해결

| 증상 | 확인할 것 |
| --- | --- |
| `포트 4477 가 이미 사용 중입니다` | config의 `port`를 바꾸거나 기존 프로세스 종료 (`lsof -i :4477`) |
| `dist/web 이 없습니다` | `npm run build` 후 `npm start`, 또는 `npm run dev` 사용 |
| `config 오류: …` | 출력된 항목을 config에서 수정. JSON 문법(쉼표, 따옴표) 확인 |
| 카드가 "저장소 경로가 존재하지 않습니다" | `repoPath` 오타, `~` 경로 확인 |
| 카드가 "Git 저장소가 아닙니다" | 해당 경로에서 `git status`가 되는지 확인 |
| "tmux 세션이 종료되었거나 없습니다" | `tmux ls`의 세션 이름과 `tmuxSession`이 정확히 같은지 확인. 세션 없는 프로젝트를 오류로 보고 싶지 않으면 `sessionExitIsError: false` |
| 터미널 출력이 비어 있음 | 세션의 활성 pane이 비어 있는지 확인 (`tmux capture-pane -p -t =세션이름:`) |
| 로그 때문에 계속 오류로 표시됨 | `errorPatterns`를 좁히거나 `[]`로 끄기. 로그 끝 200줄만 검사합니다 |
| TypeScript 문법 오류로 서버가 안 뜸 | `node -v`가 22.18 이상인지 확인 |
| 화면에 "연결 끊김" | 서버가 종료된 상태. 다시 시작하면 자동으로 재연결됩니다 |

구조와 설계 결정은 [ARCHITECTURE.md](ARCHITECTURE.md)를 참고하세요.
