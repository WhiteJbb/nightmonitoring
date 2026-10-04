# NightShift

tmux에서 밤새 돌아가는 AI 코딩 에이전트와 Git 저장소의 진행 상황을 한 화면에서 확인하는 **macOS용 로컬 전용** 관제 대시보드.

- 프로젝트별 Git 상태(브랜치, 변경 파일, +/− 줄 수, 최근 커밋)와 tmux 세션 상태를 카드로 표시
- 세션의 모든 tmux pane의 최근 출력 100줄을 색상 그대로 자동 새로고침으로 표시, `tmux attach` 명령 복사
- 정상 실행 / 입력 대기 / 유휴 / 정지 의심 / 오류 자동 판정, 상태가 나빠지면 macOS 알림
- config에 등록해 둔 테스트·빌드 명령을 버튼으로 실행·취소, 실행 이력 보관
- 버튼 한 번 또는 정해진 시각에 Markdown **Morning Report** 생성 (`reports/YYYY-MM-DD-morning-report.md`)
- 서버를 재시작해도 밤샘 기록(기준점·실행 이력)이 이어지고, config 수정은 재시작 없이 반영
- 대시보드의 **설정** 화면에서 임계값·패턴·알림·프로젝트 목록을 바로 수정 (테스트·빌드 명령은 파일에서만)
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
| `--config <path>` 또는 `NIGHTSHIFT_CONFIG` | config 파일 경로 (기본 `config/nightshift.json`, 없으면 `.yaml` → `.yml`) |
| `--demo` 또는 `NIGHTSHIFT_DEMO=1` | demo mode |
| `--fresh` | 저장된 모니터링 세션을 무시하고 새로 시작 |

예: `npm start -- --config ~/my-nightshift.yaml`

- config 파일이 없으면 빈 대시보드로 시작하고, 시작할 때 형식이 잘못되었으면 문제 목록을 출력하고 종료합니다.
- **config를 저장하면 1~2초 안에 자동으로 반영됩니다** (재시작 불필요). 다시 읽다 실패하면 이전 설정으로 계속 동작하고 화면 위쪽에 오류가 표시됩니다. `host`·`port`만은 재시작해야 바뀝니다.
- **모니터링 세션은 재시작해도 이어집니다.** 기준점(최초 브랜치·커밋), 실행 결과·이력이 `.nightshift/state.json`에 저장됩니다. 새 밤을 시작하려면 대시보드의 "새 세션 시작" 버튼을 누르거나 `--fresh`로 실행하세요.

## Demo mode

tmux 세션이나 Git 저장소가 없어도 모든 화면을 볼 수 있습니다.

```bash
npm run demo
```

정상 작업 중 / 20분간 활동 없음(유휴) / 확인 프롬프트에서 입력 대기 / 테스트 실패(오류) / tmux 세션 종료(오류) / 47분간 정지(정지 의심) 프로젝트가 표시됩니다. demo에서는 실제 명령이 실행되지 않고 알림·상태 저장도 하지 않으며, 보고서는 `reports/demo/`에 저장됩니다.

## config 작성

`config/nightshift.json` 또는 `config/nightshift.yaml` (예제: [`nightshift.example.json`](config/nightshift.example.json), [`nightshift.example.yaml`](config/nightshift.example.yaml)). 확장자가 `.yaml`/`.yml`이면 YAML로 읽습니다.

```json
{
  "host": "127.0.0.1",
  "port": 4477,
  "refreshIntervalSec": 5,
  "thresholds": { "idleMinutes": 15, "stalledMinutes": 30, "noCommitMinutes": 30 },
  "errorPatterns": ["error", "failed", "exception"],
  "errorIgnorePatterns": ["0 errors", "no errors", "0 failed"],
  "promptPatterns": ["Do you want to", "(y/n)", "/❯\\s*1\\.\\s*Yes/"],
  "ignoreSpinnerChanges": true,
  "sessionExitIsError": true,
  "notifications": true,
  "autoReportTime": "07:00",
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

`projects` 외에는 모두 생략 가능합니다. 생략했을 때의 기본값은 위와 같고, `autoReportTime`만 기본이 꺼짐(`null`)입니다. `promptPatterns`의 전체 기본 목록은 예제 파일에 있습니다.

| 키 | 설명 |
| --- | --- |
| `refreshIntervalSec` | 상태 갱신 주기(초) |
| `thresholds.idleMinutes` | 터미널 출력이 이 시간 동안 안 바뀌면 **유휴** |
| `thresholds.stalledMinutes` | 터미널 출력이 이 시간 동안 안 바뀌고… |
| `thresholds.noCommitMinutes` | …Git 변화(커밋·working tree)도 이 시간 동안 없으면 **정지 의심** |
| `errorPatterns` | 로그 파일에서 찾을 패턴. `[]`이면 로그 검사 끔 |
| `errorIgnorePatterns` | 이 패턴에 걸리는 줄은 오류로 보지 않음 (예: `0 errors`) |
| `promptPatterns` | 터미널 마지막 15줄에서 찾을 확인 프롬프트 패턴. 걸리면 **입력 대기**. `[]`이면 끔 |
| `ignoreSpinnerChanges` | 숫자·스피너 문자만 바뀌는 출력은 활동으로 보지 않음 (멈춘 채 스피너만 도는 에이전트를 잡기 위함) |
| `sessionExitIsError` | 등록된 tmux 세션이 없을 때 오류로 표시할지 |
| `notifications` | 상태가 입력 대기·정지 의심·오류로 바뀔 때 macOS 알림 |
| `autoReportTime` | Morning Report를 자동 생성할 시각 `"HH:MM"`. 그 시각 이전부터 서버가 켜져 있던 날에만 생성 |
| `commandTimeoutSec` | 테스트·빌드 명령 실행 시간 제한(초) |
| `reportsDir` | 보고서 저장 디렉터리 |

패턴은 세 설정 모두 같은 문법입니다. 일반 문자열은 대소문자를 무시한 부분 일치, `/…/플래그` 형태는 정규식입니다 (예: `"/^Error:/"`, `"/panic/i"`).

### UI에서 설정 수정

상단의 **설정** 메뉴에서 config 파일을 직접 열지 않고 수정할 수 있습니다. 저장하면 파일에 기록되고 바로 적용됩니다. 값이 잘못되면 파일은 건드리지 않고 문제 목록을 보여 줍니다.

| UI에서 수정 가능 | 파일에서만 수정 가능 |
| --- | --- |
| 갱신 주기, 임계값, 오류·제외·프롬프트 패턴, 스피너 무시, 세션 종료 처리, 알림, 자동 보고서 시각, 명령 시간 제한 | `host`, `port`, `reportsDir` |
| 프로젝트 추가·삭제, 이름, tmux 세션, 로그 파일 | 프로젝트의 `testCommand`, `buildCommand` |
| 명령이 없는 프로젝트의 저장소 경로 | 명령이 등록된 프로젝트의 `repoPath` |

- 명령과 그 명령이 실행되는 경로를 파일에서만 바꾸게 한 것은 "웹 화면에서 임의 명령을 실행할 수 없다"는 원칙을 지키기 위해서입니다. UI에서 추가한 프로젝트에 테스트·빌드 명령을 붙이려면 파일에 `testCommand`/`buildCommand`를 적으세요.
- 프로젝트 이름을 바꾸면 id가 바뀌어 그 프로젝트의 기준점과 실행 이력이 초기화됩니다.
- JSON 파일은 저장 시 전체가 다시 쓰이고(주석 없음), YAML 파일은 바뀐 항목만 갈아 끼워 다른 곳의 주석이 유지됩니다. 프로젝트 목록을 바꾸면 `projects` 안의 주석은 사라집니다.
- demo mode에서는 읽기 전용입니다.

### 프로젝트 등록

설정 화면의 "프로젝트 추가"를 쓰거나, 파일의 `projects` 배열에 항목을 추가하고 저장하면 바로 반영됩니다.

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

세션의 모든 윈도우·pane(최대 8개)을 캡처하며, pane이 여러 개면 탭에서 골라 볼 수 있습니다(기본은 활성 pane). 어느 pane이든 출력이 바뀌면 활동으로 봅니다. 세션 이름에는 공백, `:`, `.`을 쓸 수 없고 `-` `$` `=` `@` `%`로 시작할 수 없습니다.

## 상태 판정

| 상태 | 조건 |
| --- | --- |
| 오류 | 저장소 경로 없음 / Git 저장소 아님, 등록된 tmux 세션 없음, 로그에서 오류 패턴 발견, 마지막 테스트·빌드 실패 |
| 입력 대기 | 터미널 마지막 줄들에 확인 프롬프트(`promptPatterns`)가 떠 있음 |
| 정지 의심 | 출력 변화 없음 ≥ `stalledMinutes` 그리고 Git 변화 없음 ≥ `noCommitMinutes` |
| 유휴 | 출력 변화 없음 ≥ `idleMinutes` |
| 정상 실행 | 그 외 |

위에서부터 먼저 해당하는 상태가 됩니다. tmux 세션을 등록하지 않은 프로젝트는 Git 활동만으로 판정합니다.

- **Git 변화**는 새 커밋, 변경 파일 목록의 변화, 변경된 파일의 크기·수정 시각 변화를 뜻합니다.
- **로그 오류**는 모니터링을 시작한 뒤 추가된 줄만 검사합니다. Git 탭의 "확인 처리"를 누르면 그때까지의 오류는 지워지고 이후에 추가되는 줄만 다시 검사합니다.
- 취소한 테스트·빌드는 실패로 보지 않습니다.

## 테스트·빌드 실행과 Morning Report

- 프로젝트 상세 → **테스트·빌드** 탭의 실행 버튼은 config의 `testCommand` / `buildCommand`를 그대로 실행합니다. 종료 코드, 소요 시간, stdout, stderr가 따로 표시되고 마지막 실행 로그는 `.nightshift/runs/<id>-<test|build>.{stdout,stderr}.log`에 남습니다.
- 실행 중에는 **취소** 버튼으로 중단할 수 있고(프로세스 그룹째 종료), 종류별 최근 20건의 실행 이력이 표로 남습니다.
- **보고서** 화면의 "Morning Report 생성" 버튼은 모니터링 시작 이후의 커밋·변경 파일·터미널 출력·오류·테스트/빌드 결과·다음 확인 항목을 프로젝트별로 정리해 `reports/YYYY-MM-DD-morning-report.md`에 저장합니다(같은 날짜는 덮어씀).
- 보고서 화면에서는 렌더링된 보기와 Markdown 원문을 전환할 수 있습니다.
- `autoReportTime`을 설정하면 그 시각에 자동으로 생성됩니다.
- "모니터링 시작"은 현재 세션을 시작한 시점입니다. 서버를 재시작해도 유지되고, "새 세션 시작" 또는 `--fresh`로 초기화됩니다.

## NightShift 자체의 테스트·빌드

```bash
npm run lint       # ESLint
npm test           # vitest 단위 테스트 (서버 모듈 + UI 컴포넌트, git/tmux 는 mock)
npm run build      # 타입 체크 + 프론트엔드 프로덕션 빌드 (dist/web)
```

## 보안 관련 주의사항

- 기본 바인딩은 `127.0.0.1`입니다. `host`를 `0.0.0.0` 등으로 바꾸면 **인증 없이** 같은 네트워크의 누구나 터미널 출력을 보고 테스트·빌드 명령을 실행할 수 있으니 바꾸지 마세요. 원격에서 보려면 SSH 포트 포워딩을 쓰세요: `ssh -L 4477:127.0.0.1:4477 my-mac`
- 웹 UI에는 명령을 입력하는 기능이 없습니다. 실행되는 것은 config 파일에 미리 적어 둔 테스트·빌드 명령뿐이고, 실행 API는 프로젝트 id와 `test|build`만 받습니다.
- 설정 화면(`PUT /api/config`)은 편집 가능한 필드만 반영합니다. 요청에 명령·`host`·`port`·`reportsDir`가 들어 있어도 읽지 않고, 명령이 등록된 프로젝트의 저장소 경로 변경은 거부합니다. 다만 **로그 파일 경로와 패턴은 UI에서 바꿀 수 있으므로, 대시보드에 접근할 수 있는 사람은 이 서버가 읽을 수 있는 텍스트 파일의 내용 일부를 화면에서 볼 수 있습니다.** 이 서버를 loopback 밖에 노출하면 안 되는 이유가 하나 더 늘었습니다.
- `testCommand` / `buildCommand`는 셸에서 실행됩니다. **config 파일을 수정할 수 있는 사람은 임의 명령을 실행할 수 있는 것**과 같으니 config 파일 권한을 관리하세요.
- git·tmux·osascript(알림)는 셸을 거치지 않고 인자 배열로만 실행됩니다(`server/exec.ts` 한 곳). 알림 문구도 스크립트에 끼워 넣지 않고 인자로 전달합니다.
- config 파일을 쓰는 경로는 설정 화면의 저장 하나뿐이고, Origin 검사를 통과한 같은 출처의 요청만 받습니다.
- loopback이 아닌 Host 헤더(DNS rebinding)와 다른 Origin에서 온 변경 요청(CSRF)은 거부합니다.
- 터미널 출력, 보고서, `.nightshift/`(실행 로그·세션 상태)에는 비밀 값이 포함될 수 있습니다. `reports/`와 `.nightshift/`는 git에서 제외되어 있습니다.

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
| 로그 때문에 계속 오류로 표시됨 | Git 탭에서 "확인 처리", 또는 `errorIgnorePatterns`에 제외할 문구 추가, `errorPatterns`를 정규식으로 좁히기 |
| 입력 대기가 잘못 뜨거나 안 뜸 | `promptPatterns`를 에이전트의 프롬프트 문구에 맞게 수정 |
| 일하는 중인데 유휴·정지 의심으로 표시됨 | 화면에서 숫자만 바뀌는 작업(진행률 등)일 수 있음. `ignoreSpinnerChanges: false` |
| config를 고쳤는데 반영이 안 됨 | 화면 위쪽의 config 오류 배너와 서버 로그 확인. `host`·`port`는 재시작 필요 |
| 재시작했더니 어젯밤 기록이 그대로 남아 있음 | 정상 동작. "새 세션 시작" 버튼 또는 `--fresh` |
| 알림이 오지 않음 | 시스템 설정 → 알림에서 "스크립트 편집기" 허용 여부 확인. 서버 시작 직후의 상태는 알리지 않고 이후의 **변화**만 알립니다 |
| TypeScript 문법 오류로 서버가 안 뜸 | `node -v`가 22.18 이상인지 확인 |
| 화면에 "연결 끊김" | 서버가 종료된 상태. 다시 시작하면 자동으로 재연결됩니다 |

구조와 설계 결정은 [ARCHITECTURE.md](ARCHITECTURE.md)를 참고하세요.
