# NightShift

tmux에서 밤새 돌아가는 AI 코딩 에이전트와 Git 저장소의 진행 상황을 한 화면에서 확인하는 **macOS용 로컬 전용** 관제 대시보드.

- 프로젝트별 Git 상태(브랜치, 변경 파일, +/− 줄 수, 최근 커밋)와 tmux 세션 상태를 카드로 표시
- 세션의 모든 tmux pane의 최근 출력 100줄을 색상 그대로 자동 새로고침으로 표시, `tmux attach` 명령 복사
- 정상 실행 / 입력 대기 / 유휴 / 정지 의심 / 오류 자동 판정, 상태가 나빠지면 macOS 알림
- config에 등록해 둔 테스트·빌드 명령을 버튼으로 실행·취소, 실행 이력 보관
- 버튼 한 번 또는 정해진 시각에 Markdown **Morning Report** 생성 (`reports/YYYY-MM-DD-morning-report.md`)
- 서버를 재시작해도 밤샘 기록(기준점·실행 이력)이 이어지고, config 수정은 재시작 없이 반영
- 터미널 탭은 보고 있는 pane을 1초 이내 주기로 갱신하고, 허용한 프로젝트에는 브라우저에서 키 입력을 보낼 수 있음 (기본 꺼짐)
- 대시보드에서 새 tmux 세션을 만들어 바로 프로젝트로 등록, 꺼진 세션 다시 시작
- 대시보드의 **설정** 화면에서 임계값·패턴·알림·프로젝트 목록을 바로 수정 (테스트·빌드 명령은 파일에서만)
- 상태가 나빠지면 휴대폰으로 푸시 (ntfy, 선택 기능)
- 외부 DB·API 키 없음. 휴대폰 알림을 켜지 않으면 외부로 나가는 요청도 없음. 서버는 `127.0.0.1`에만 바인딩

## 요구 사항

- macOS
- Node.js **22.18 이상** (서버를 TypeScript 그대로 실행합니다)
- `git`, `tmux` (demo mode에는 필요 없음)

## 빠른 시작

```bash
git clone <this-repo> nightshift
cd nightshift
npm install
npm run build
npm start
```

브라우저에서 <http://127.0.0.1:4477> 을 엽니다. 설정 파일은 아직 필요 없습니다.

1. 돌고 있는 tmux 세션이 **미등록** 카드로 보입니다. **등록**을 누르면 프로젝트가 되고, 그때 `config/nightshift.json`이 만들어집니다.
2. 아직 세션이 없으면 **+ tmux 세션 만들기**로 새 세션을 띄우고(Git 주소를 주면 복제까지), `tmux attach`로 들어가 에이전트를 시작하세요.
3. 임계값·알림·휴대폰 푸시는 상단 **설정**에서 바꿉니다.

설정 파일을 직접 쓰고 싶으면 `cp config/nightshift.example.json config/nightshift.json` 뒤 [config 작성](#config-작성)을 보세요. 서버를 켜 둔 채 저장해도 바로 반영됩니다.

## 실행

```bash
npm run build && npm start   # 프로덕션 모드
npm run dev                  # 개발 모드 (프론트엔드 HMR 포함, 빌드 불필요)
```


| 옵션 | 설명 |
| --- | --- |
| `--config <path>` 또는 `NIGHTSHIFT_CONFIG` | config 파일 경로 (기본 `config/nightshift.json`, 없으면 `.yaml` → `.yml`) |
| `--demo` 또는 `NIGHTSHIFT_DEMO=1` | demo mode |
| `--fresh` | 저장된 모니터링 세션을 무시하고 새로 시작 |

예: `npm start -- --config ~/my-nightshift.yaml`

- config 파일이 없으면 빈 대시보드로 시작하고, 시작할 때 형식이 잘못되었으면 문제 목록을 출력하고 종료합니다.
- **config를 저장하면 1~2초 안에 자동으로 반영됩니다** (재시작 불필요). 다시 읽다 실패하면 이전 설정으로 계속 동작하고 화면 위쪽에 오류가 표시됩니다. `host`·`port`만은 재시작해야 바뀝니다.
- **모니터링 세션은 재시작해도 이어집니다.** 기준점(최초 브랜치·커밋), 실행 결과·이력이 `.nightshift/state.json`에 저장됩니다. 새 밤을 시작하려면 대시보드의 "모니터링 새로 시작" 버튼을 누르거나 `--fresh`로 실행하세요.

### 백그라운드로 실행 (로그인하면 자동 시작)

터미널을 닫아도 돌게 하려면 launchd에 등록합니다. `~/Library/LaunchAgents/com.nightshift.plist`를 만들고 경로 두 곳(`node`, NightShift 디렉터리)을 내 환경에 맞게 고칩니다. `node` 경로는 `which node`로 확인합니다.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.nightshift</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>server/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/me/nightshift</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- launchd 는 셸의 PATH 를 모르므로 Homebrew 의 git·tmux 위치를 알려 준다 -->
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/me/nightshift/.nightshift/server.log</string>
  <key>StandardErrorPath</key><string>/Users/me/nightshift/.nightshift/server.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nightshift.plist   # 등록하고 바로 시작
launchctl kickstart -k gui/$(id -u)/com.nightshift                             # 재시작 (코드를 바꿔 npm run build 한 뒤)
launchctl bootout gui/$(id -u)/com.nightshift                                  # 중지하고 등록 해제
tail -f .nightshift/server.log                                                 # 로그
```

서버가 죽으면 launchd가 다시 띄우고(`KeepAlive`), 모니터링 세션은 `.nightshift/state.json`에서 이어집니다. 같은 사용자로 로그인해 있는 동안만 돌고, tmux 세션도 그 사용자의 것을 봅니다.

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
  "errorIgnorePatterns": ["/\\b0 errors\\b/", "no errors", "/\\b0 failed\\b/"],
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
| `errorIgnorePatterns` | 이 패턴에 걸리는 줄은 오류로 보지 않음. 기본값은 `/\b0 errors\b/` 처럼 정규식이라 `10 errors` 는 제외되지 않음 |
| `promptPatterns` | 터미널 마지막 15줄에서 찾을 확인 프롬프트 패턴. 걸리면 **입력 대기**. `[]`이면 끔 |
| `ignoreSpinnerChanges` | 숫자·스피너 문자만 바뀌는 출력은 활동으로 보지 않음 (멈춘 채 스피너만 도는 에이전트를 잡기 위함) |
| `sessionExitIsError` | 등록된 tmux 세션이 없을 때 오류로 표시할지 |
| `notifications` | 상태가 입력 대기·정지 의심·오류로 바뀔 때 macOS 알림 |
| `ntfyUrl` | 휴대폰 푸시를 보낼 ntfy 주소 (예: `https://ntfy.sh/내-주제`). 기본 꺼짐. 아래 "휴대폰 알림" 참고 |
| `ntfyStates` | 휴대폰 푸시를 보낼 상태. 기본 `["waiting", "stalled", "error"]`, `"idle"`도 넣을 수 있음 (파일에서만) |
| `hiddenSessions` | 대시보드에서 숨길 미등록 tmux 세션 이름. 카드의 "숨김" 버튼이 여기에 추가하고, 설정 화면의 "숨긴 미등록 세션"에서 지우면 다시 보임 |
| `autoReportTime` | Morning Report를 자동 생성할 시각 `"HH:MM"`. 그 시각 이전부터 서버가 켜져 있던 날에만 생성 |
| `commandTimeoutSec` | 테스트·빌드 명령 실행 시간 제한(초) |
| `reportsDir` | 보고서 저장 디렉터리 |

패턴은 세 설정 모두 같은 문법입니다. 일반 문자열은 대소문자를 무시한 부분 일치, `/…/플래그` 형태는 정규식입니다 (예: `"/^Error:/"`, `"/panic/i"`).

### 휴대폰 알림 (ntfy)

상태가 입력 대기·정지 의심·오류로 바뀌는 순간 휴대폰으로 푸시를 보냅니다. [ntfy](https://ntfy.sh)를 쓰며 계정이나 키는 필요 없습니다.

1. 휴대폰에 ntfy 앱을 설치합니다 (App Store / Google Play).
2. 남이 추측하기 어려운 주제 이름을 정합니다. 예: `nightshift-` 뒤에 무작위 글자 (`openssl rand -hex 8`).
3. 앱에서 그 주제를 구독합니다 (Subscribe to topic).
4. 설정 화면의 "휴대폰 알림"에 `https://ntfy.sh/주제이름`을 적고 저장한 뒤 **시험 알림 보내기**를 누릅니다.

- 알림을 누르면 그 프로젝트의 대시보드 화면이 열립니다 (서버가 Tailscale 주소 등 휴대폰에서 닿는 주소에 열려 있을 때).
- 서버 시작 직후의 상태는 보내지 않고 이후의 **변화**만 보냅니다. Mac 알림(`notifications`)과는 별개로 동작합니다.
- 같은 프로젝트가 같은 상태로 되돌아온 것은 그 사이에 실제 활동(출력이 세 번 이상 바뀜, 또는 Git 변화)이 있었을 때만 다시 알립니다. 멈춘 세션의 화면이 한 번 갱신돼 잠깐 "정상"이 됐다가 다시 "정지 의심"이 되는 경우는 조용합니다. Mac 알림도 같습니다.
- **주제 이름이 곧 비밀번호입니다.** ntfy.sh의 주제는 이름을 아는 사람이면 누구나 구독할 수 있습니다. 알림에는 프로젝트 이름과 판정 사유(예: "30분 동안 출력·Git 변화 없음")가 담겨 ntfy.sh 서버를 거칩니다. 터미널 출력이나 코드는 보내지 않습니다. 이것이 걸리면 ntfy를 직접 운영하고 그 주소를 적으세요.
- 전송에 실패해도 감시는 계속되고, 서버 로그에 사유가 남습니다.

### UI에서 설정 수정

상단의 **설정** 메뉴에서 config 파일을 직접 열지 않고 수정할 수 있습니다. 저장하면 파일에 기록되고 바로 적용됩니다. 값이 잘못되면 파일은 건드리지 않고 문제 목록을 보여 줍니다.

| UI에서 수정 가능 | 파일에서만 수정 가능 |
| --- | --- |
| 갱신 주기, 임계값, 오류·제외·프롬프트 패턴, 스피너 무시, 세션 종료 처리, 알림, 휴대폰 알림 주소, 자동 보고서 시각, 명령 시간 제한 | `host`, `port`, `reportsDir`, `allowedHosts` |
| 프로젝트 추가·삭제, 이름, tmux 세션, 로그 파일, 터미널 입력 허용 | 프로젝트의 `testCommand`, `buildCommand` |
| 명령이 없는 프로젝트의 저장소 경로 | 명령이 등록된 프로젝트의 `repoPath` |

- 명령과 그 명령이 실행되는 경로를 파일에서만 바꾸게 한 것은 "웹 화면에서 임의 명령을 실행할 수 없다"는 원칙을 지키기 위해서입니다. UI에서 추가한 프로젝트에 테스트·빌드 명령을 붙이려면 파일에 `testCommand`/`buildCommand`를 적으세요.
- 프로젝트 이름을 바꾸면 id가 바뀌어 그 프로젝트의 기준점과 실행 이력이 초기화됩니다.
- JSON 파일은 저장 시 전체가 다시 쓰이고(주석 없음), YAML 파일은 바뀐 항목만 갈아 끼워 다른 곳의 주석이 유지됩니다. 프로젝트 목록을 바꾸면 `projects` 안의 주석은 사라집니다.
- 설정 화면을 열어 둔 사이 파일이 다른 곳에서(에디터, 다른 탭) 바뀌었으면 저장을 거부하고 "다시 불러오기"를 안내합니다. 파일 쪽 수정이 덮어써지지 않습니다.
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
| `allowInput` | | `true`면 대시보드에서 이 프로젝트의 tmux 세션으로 키 입력을 보낼 수 있음. 기본 `false`. 설정 화면의 "터미널 입력 허용"으로도 켤 수 있음 |

### tmux 세션 연결

설정에 없는 tmux 세션도 떠 있는 동안은 **미등록** 표시와 함께 카드로 나타납니다(이름은 세션 이름, 경로는 활성 pane의 현재 디렉터리). 세션이 닫히면 카드도 사라지고, 터미널 입력·테스트·빌드 명령은 쓸 수 없습니다. 카드의 **등록**을 누르면 그 경로로 프로젝트에 등록되고, **숨김**을 누르면 `hiddenSessions`에 들어가 보이지 않습니다(설정 화면에서 되돌릴 수 있습니다).

1. 에이전트를 이름 있는 세션에서 실행합니다.

   ```bash
   tmux new -s webapp-agent -c ~/code/my-web-app
   # 세션 안에서 에이전트 실행 후 Ctrl-b d 로 분리
   ```

2. 그 이름을 프로젝트의 `tmuxSession`에 적습니다. 현재 세션 목록은 `tmux ls`로 확인합니다.
3. 대시보드의 프로젝트 → **터미널** 탭에 최근 출력과 `tmux attach -t webapp-agent` 명령(복사 버튼)이 표시됩니다.

세션의 모든 윈도우·pane(최대 8개)을 캡처하며, pane이 여러 개면 탭에서 골라 볼 수 있습니다(기본은 활성 pane). 어느 pane이든 출력이 바뀌면 활동으로 봅니다. 세션 이름에는 공백, `:`, `.`을 쓸 수 없고 `-` `$` `=` `@` `%`로 시작할 수 없습니다.

### 대시보드에서 tmux 세션 만들기

대시보드의 **+ tmux 세션 만들기**에서 프로젝트 이름, 저장소 경로, 세션 이름을 적으면(경로는 등록된 프로젝트들이 가장 많이 모여 있는 상위 폴더까지 미리 채워집니다) 그 경로에서 셸만 띄운 새 tmux 세션을 만들고 바로 프로젝트로 등록한 뒤 터미널 화면으로 이동합니다. 터미널 입력 허용을 함께 켜면 그 자리에서 에이전트를 실행할 수 있습니다.

- 세션은 만드는 순간 보고 있던 화면의 폭에 맞는 크기로 만들어져, 터미널 탭에서 가로 스크롤이 생기지 않습니다. 이미 있는 세션이 화면보다 넓으면 터미널 위에 **화면에 맞추기** 버튼이 나옵니다(터미널이 붙어 있지 않은 세션에서만. 붙어 있으면 그 터미널 화면까지 바뀌기 때문입니다).
- **Git 저장소 주소**를 적으면 저장소 경로에 먼저 `git clone` 한 뒤 세션을 만듭니다. 주소를 붙여 넣으면 프로젝트 이름과 경로가 저장소 이름으로 채워집니다. `https://`, `ssh://`, `git@host:path` 형식만 받고, 경로에 이미 저장소가 있으면 clone 을 건너뜁니다. 자격 증명을 묻는 상황이면 멈추지 않고 실패합니다(비공개 저장소는 이 Mac에 SSH 키나 자격 증명이 있어야 합니다). 시간 제한은 `commandTimeoutSec`과 같습니다.
- 실행할 명령은 받지 않습니다. 항상 기본 셸만 뜨고, 무엇을 실행할지는 터미널 입력이나 `tmux attach`로 정합니다.
- 같은 이름의 세션이 이미 있으면 새로 만들지 않고 그 세션을 등록합니다. 이미 프로젝트로 등록된 세션 이름은 거부합니다.
- 등록된 세션이 꺼져 있으면 프로젝트의 터미널 탭에 **세션 시작** 버튼이 나타나 같은 이름으로 다시 만들 수 있습니다.
- 터미널 입력과 같은 조건에서만 동작합니다: 서버가 loopback 또는 Tailscale 주소에 바인딩되어 있어야 하고, demo mode에서는 쓸 수 없습니다.
- 여기서 만든 프로젝트에는 테스트·빌드 명령이 없습니다. 필요하면 config 파일에 적으세요.

### 터미널 입력 (선택 기능)

터미널 탭은 보고 있는 pane을 약 0.7초마다 다시 읽어 실제 화면에 가깝게 보여 줍니다. 여기에 더해 설정 화면에서 프로젝트의 **터미널 입력 허용**을 켜면(또는 파일에 `allowInput: true`를 적으면) 터미널 아래에 입력 줄이 생깁니다.

```json
{ "name": "My Web App", "repoPath": "~/code/my-web-app", "tmuxSession": "webapp-agent", "allowInput": true }
```

- 입력 줄에 글을 쓰고 Enter(또는 "보내기")를 누르면 선택한 pane에 그대로 입력되고, 잠시(0.2초) 뒤 Enter가 눌립니다. pane에서 AI 에이전트가 돌고 있으면 프롬프트로 전달됩니다. 이 짧은 간격은 Codex처럼 빠르게 들어온 글자를 붙여넣기로 보고 바로 뒤의 Enter를 줄바꿈으로 처리하는 프로그램을 위한 것입니다.
- 여러 줄을 붙여넣거나 Shift+Enter로 줄을 나누면 tmux의 붙여넣기(bracketed paste)로 들어갑니다. 줄바꿈마다 Enter가 눌리지 않고, Claude Code·Codex는 긴 글을 한 덩어리로 접어서 받습니다. 한 번에 보낼 수 있는 길이는 20,000자입니다.
- Esc, Tab, Shift+Tab, 방향키, PgUp/PgDn, Backspace, Ctrl+C/D/U/L은 버튼으로 보냅니다. 입력 줄이 비어 있을 때는 키보드의 방향키·Esc·Tab·Backspace도 그대로 전달됩니다.
- 화면은 tmux pane의 크기를 따르고, 마우스 클릭은 전달되지 않습니다.
- **위로 올려 보기**: 터미널 탭은 최근 500줄을 가져오고, "이전 출력 더 보기"로 5000줄까지 늘릴 수 있습니다(tmux의 스크롤백 한도 `history-limit`, 기본 2000줄까지). 위로 올려 읽는 동안에는 화면이 밀리지 않게 갱신이 멈추고, "맨 아래로"를 누르면 다시 이어집니다. 멈춘 동안에도 키나 글을 보내면 그 직후의 화면은 한 번 읽어 옵니다.
- **휴대폰에서 보기**: 좁은 화면에서는 긴 줄을 화면 폭에 맞춰 접어 보여 줍니다("줄바꿈" 버튼으로 끄고 켬). 접을 때 긴 가로줄과 정렬용 공백은 줄입니다. 세션 정보는 접혀 있고 "세션 정보"로 펼칩니다.
- **전체 화면으로 도는 프로그램**(Claude Code의 전체 화면 모드, `less`, `vim` 등)은 tmux에 스크롤백이 남지 않아 보이는 화면 한 장만 가져올 수 있습니다. 이 경우 PgUp/PgDn 키를 보내 프로그램 안에서 직접 넘겨야 합니다.
- 보낸 입력은 모두 `.nightshift/input.log`에 한 줄씩 기록됩니다.

**이 기능은 "웹 화면에서 임의 명령 실행"과 같습니다.** 켜 둔 프로젝트에 대해서는 대시보드에 접속할 수 있는 사람이 곧 이 Mac 계정으로 명령을 실행할 수 있는 사람입니다. 그래서 기본은 꺼져 있고 다음 조건을 모두 만족할 때만 동작합니다.

- 그 프로젝트의 터미널 입력 허용이 켜져 있을 것
- 서버가 loopback(`127.0.0.1`) 또는 Tailscale 주소(`100.64.0.0/10`)에 바인딩되어 있을 것 — `0.0.0.0`이나 LAN 주소에 열면 입력은 거부됩니다
- 대상이 그 프로젝트의 tmux 세션에 속한 pane일 것
- 같은 출처의 요청일 것 (다른 웹사이트에서 보낸 요청은 거부)

설정 화면에서도 켤 수 있으므로, **대시보드에 접속할 수 있는 범위가 곧 보안 경계**입니다. 아래 방법 중 하나로만 노출하세요.

### 다른 기기에서 접속 (Tailscale)

서버를 `0.0.0.0`에 여는 대신 Tailscale을 거치면 tailnet에 속한 내 기기에서만 접속됩니다.

**방법 1 — `tailscale serve` (권장)**: 서버는 `127.0.0.1`에 그대로 두고 Tailscale이 HTTPS로 중계합니다.

```bash
tailscale serve --bg 4477          # https://<기기이름>.<tailnet>.ts.net 으로 노출
```

중계를 거치면 Host 헤더가 그 이름으로 들어오므로 config **파일**에 허용할 이름을 적어야 합니다(적지 않으면 "허용되지 않은 Host"로 거부).

```json
{ "allowedHosts": ["my-mac.tailnet-name.ts.net"] }
```

**방법 2 — Tailscale 주소에 직접 바인딩**: config 파일의 `host`를 이 Mac의 Tailscale 주소로 바꿉니다(`tailscale ip -4`로 확인). 이 경우 로컬에서는 `127.0.0.1`이 아니라 그 주소로 접속해야 하고, HTTPS가 아닙니다.

```json
{ "host": "100.101.102.103" }
```

이때 접속은 그 주소(`http://100.101.102.103:4477`)나 MagicDNS 이름(`*.ts.net`)으로만 받습니다. 다른 이름으로 들어오는 요청은 DNS rebinding 방어를 위해 거부하므로, 다른 이름을 쓰려면 `allowedHosts`에 적으세요.

`host`와 `allowedHosts`는 파일에서만 바꿀 수 있고 재시작해야 적용됩니다. `tailscale funnel`(인터넷 공개)로는 절대 노출하지 마세요.

## 상태 판정

| 상태 | 조건 |
| --- | --- |
| 오류 | 저장소 경로 없음, 등록된 tmux 세션 없음, 로그에서 오류 패턴 발견, 마지막 테스트·빌드 실패 |
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
- "모니터링 시작"은 현재 세션을 시작한 시점입니다. 서버를 재시작해도 유지되고, "모니터링 새로 시작" 또는 `--fresh`로 초기화됩니다.

## NightShift 자체의 테스트·빌드

```bash
npm run lint       # ESLint
npm test           # vitest 단위 테스트 (서버 모듈 + UI 컴포넌트, git/tmux 는 mock)
npm run build      # 타입 체크 + 프론트엔드 프로덕션 빌드 (dist/web)
```

## 보안 관련 주의사항

- 기본 바인딩은 `127.0.0.1`입니다. `host`를 `0.0.0.0` 등으로 바꾸면 **인증 없이** 같은 네트워크의 누구나 터미널 출력을 보고 테스트·빌드 명령을 실행할 수 있으니 바꾸지 마세요. 원격에서 보려면 SSH 포트 포워딩을 쓰세요: `ssh -L 4477:127.0.0.1:4477 my-mac`
- **기본 상태에서는** 웹 UI에 명령을 입력하는 기능이 없습니다. 실행되는 것은 config 파일에 미리 적어 둔 테스트·빌드 명령뿐이고, 실행 API는 프로젝트 id와 `test|build`만 받습니다.
- 프로젝트의 터미널 입력 허용(`allowInput`)을 켜면 그 프로젝트의 tmux 세션에 브라우저에서 키 입력을 보낼 수 있고, 이는 **그 계정으로 무엇이든 실행할 수 있는 것**과 같습니다. 이 설정은 설정 화면에서도 켤 수 있으므로 **대시보드에 접속할 수 있는 사람은 누구나 스스로 입력을 켜고 명령을 실행할 수 있다**고 보아야 합니다. 대시보드는 loopback이나 Tailscale로만 노출하세요. 대시보드를 여는 브라우저의 확장 프로그램이나 같은 Mac의 다른 사용자도 loopback에 접근할 수 있다는 점도 고려하세요.
- 설정 화면(`PUT /api/config`)은 편집 가능한 필드만 반영합니다. 요청에 명령·`host`·`port`·`reportsDir`가 들어 있어도 읽지 않고, 명령이 등록된 프로젝트의 저장소 경로 변경은 거부합니다. 다만 **로그 파일 경로와 패턴은 UI에서 바꿀 수 있으므로, 대시보드에 접근할 수 있는 사람은 이 서버가 읽을 수 있는 텍스트 파일의 내용 일부를 화면에서 볼 수 있습니다.** 이 서버를 loopback 밖에 노출하면 안 되는 이유가 하나 더 늘었습니다.
- `testCommand` / `buildCommand`는 셸에서 실행됩니다. **config 파일을 수정할 수 있는 사람은 임의 명령을 실행할 수 있는 것**과 같으니 config 파일 권한을 관리하세요.
- git·tmux·osascript(알림)는 셸을 거치지 않고 인자 배열로만 실행됩니다(`server/exec.ts` 한 곳). 알림 문구도 스크립트에 끼워 넣지 않고 인자로 전달합니다.
- config 파일을 쓰는 경로는 설정 화면의 저장 하나뿐이고, Origin 검사를 통과한 같은 출처의 요청만 받습니다.
- 바인딩한 주소와 맞지 않는 Host 헤더(DNS rebinding)와 다른 Origin에서 온 변경 요청(CSRF)은 거부합니다. loopback이면 loopback 이름만, Tailscale 주소면 그 주소와 `*.ts.net`만 받습니다.
- 터미널 출력, 보고서, `.nightshift/`(실행 로그·세션 상태)에는 비밀 값이 포함될 수 있습니다. `reports/`와 `.nightshift/`는 git에서 제외되어 있습니다.

## 문제 해결

| 증상 | 확인할 것 |
| --- | --- |
| `포트 4477 가 이미 사용 중입니다` | config의 `port`를 바꾸거나 기존 프로세스 종료 (`lsof -i :4477`) |
| `dist/web 이 없습니다` | `npm run build` 후 `npm start`, 또는 `npm run dev` 사용 |
| `config 오류: …` | 출력된 항목을 config에서 수정. JSON 문법(쉼표, 따옴표) 확인 |
| 카드가 "저장소 경로가 존재하지 않습니다" | `repoPath` 오타, `~` 경로 확인 |
| 카드가 "Git 저장소가 아닙니다" | 오류로 치지는 않음. Git 정보도 보려면 해당 경로에서 `git status`가 되는지 확인 |
| "tmux 세션이 종료되었거나 없습니다" | `tmux ls`의 세션 이름과 `tmuxSession`이 정확히 같은지 확인. 세션 없는 프로젝트를 오류로 보고 싶지 않으면 `sessionExitIsError: false` |
| launchd로 띄웠더니 tmux 세션이 안 보임 | plist의 `PATH`에 `tmux`가 있는 디렉터리(Homebrew는 `/opt/homebrew/bin`)가 있는지 확인. `.nightshift/server.log` 확인 |
| 터미널 출력이 비어 있음 | 세션의 활성 pane이 비어 있는지 확인 (`tmux capture-pane -p -t =세션이름:`) |
| 로그 때문에 계속 오류로 표시됨 | Git 탭에서 "확인 처리", 또는 `errorIgnorePatterns`에 제외할 문구 추가, `errorPatterns`를 정규식으로 좁히기 |
| 입력 대기가 잘못 뜨거나 안 뜸 | `promptPatterns`를 에이전트의 프롬프트 문구에 맞게 수정 |
| 일하는 중인데 유휴·정지 의심으로 표시됨 | 화면에서 숫자만 바뀌는 작업(진행률 등)일 수 있음. `ignoreSpinnerChanges: false` |
| config를 고쳤는데 반영이 안 됨 | 화면 위쪽의 config 오류 배너와 서버 로그 확인. `host`·`port`는 재시작 필요 |
| 재시작했더니 어젯밤 기록이 그대로 남아 있음 | 정상 동작. "모니터링 새로 시작" 버튼 또는 `--fresh` |
| 터미널 아래에 입력 줄이 안 보임 | 설정 화면에서 그 프로젝트의 "터미널 입력 허용"을 켜기. demo mode, 그리고 loopback·Tailscale이 아닌 `host`에서는 동작하지 않음 |
| Tailscale 주소로 열면 `허용되지 않은 Host` | `tailscale serve`를 쓰는 경우 config 파일의 `allowedHosts`에 `<기기>.<tailnet>.ts.net`을 추가하고 재시작 |
| 입력했는데 반응이 없음 | 올바른 pane을 선택했는지 확인. `.nightshift/input.log`에 기록이 남는지 확인 |
| 휴대폰 알림이 오지 않음 | 설정 화면의 "시험 알림 보내기"로 확인. 앱에서 구독한 주제와 주소의 주제가 같은지, 휴대폰의 ntfy 알림 권한이 켜져 있는지 확인 |
| 알림이 오지 않음 | 시스템 설정 → 알림에서 "스크립트 편집기" 허용 여부 확인. 서버 시작 직후의 상태는 알리지 않고 이후의 **변화**만 알립니다 |
| TypeScript 문법 오류로 서버가 안 뜸 | `node -v`가 22.18 이상인지 확인 |
| 화면에 "연결 끊김" | 서버가 종료된 상태. 다시 시작하면 자동으로 재연결됩니다 |

구조와 설계 결정은 [ARCHITECTURE.md](ARCHITECTURE.md)를 참고하세요.
