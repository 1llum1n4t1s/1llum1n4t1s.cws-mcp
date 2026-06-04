# @1llum1n4t1/cws-mcp

[![npm version](https://img.shields.io/npm/v/@1llum1n4t1/cws-mcp)](https://www.npmjs.com/package/@1llum1n4t1/cws-mcp)

[English](README.md)

Chrome Web Store 확장 프로그램 관리를 위한 MCP 서버. Claude Code 또는 MCP 클라이언트에서 직접 크롬 확장 프로그램을 업로드, 퍼블리시, 관리할 수 있습니다.

> [mikusnuz/cws-mcp](https://github.com/mikusnuz/cws-mcp)의 포크. Chrome Web Store **API V2**에 맞춰 서비스 계정 인증, 동작하는 OAuth 플로우(Google이 기존 `oob` 플로우를 제거함), 최신 MCP SDK로 갱신했습니다.

## 이런 경우에 사용하세요

- **"크롬 확장 프로그램 새 버전 업로드해줘"** — ZIP을 빌드하고 `upload` 도구로 초안 업데이트
- **"확장 프로그램 Chrome Web Store에 퍼블리시해줘"** — `publish`로 리뷰 제출 및 배포
- **"확장 프로그램 리뷰 상태 확인해줘"** — `status`로 리뷰 상태, 버전, 배포 비율 확인
- **"확장 프로그램 메타데이터(설명, 스크린샷) 업데이트해줘"** — `update-metadata-ui`로 스토어 리스팅 수정
- **"제출 대기 중인 거 취소해줘"** — `cancel`로 리뷰 중인 제출 철회
- **"확장 프로그램 단계적 배포 설정해줘"** — `publish`로 단계적 배포 후 `deploy-percentage`로 비율 증가

## 도구

| 도구 | 설명 |
|---|---|
| `upload` | ZIP 파일을 Chrome Web Store에 업로드 (기존 항목 초안 업데이트) |
| `publish` | 단계적 배포, 퍼블리시 유형, 리뷰 건너뛰기 옵션으로 확장 프로그램 퍼블리시 |
| `status` | 리뷰 상태, 배포 비율, 버전 등 현재 상태 확인 |
| `cancel` | 제출 대기 중인 항목 취소 |
| `deploy-percentage` | 단계적 배포 비율 설정 (0-100, 현재 목표보다 높아야 함) |
| `get` | DRAFT/PUBLISHED 리스팅 메타데이터 조회 (v1.1 API, 2026년 10월 지원 종료) |
| `update-metadata` | v1.1 API로 리스팅 메타데이터 업데이트 (2026년 10월 지원 종료) |
| `update-metadata-ui` | 대시보드 UI 자동화(Playwright)로 리스팅 메타데이터 업데이트 |

## API 커버리지

이 MCP 서버는 **모든 Chrome Web Store API v2 엔드포인트**를 지원합니다:

| v2 엔드포인트 | MCP 도구 |
|---|---|
| `media.upload` | `upload` |
| `publishers.items.publish` | `publish` |
| `publishers.items.fetchStatus` | `status` |
| `publishers.items.cancelSubmission` | `cancel` |
| `publishers.items.setPublishedDeployPercentage` | `deploy-percentage` |

추가로, 메타데이터 조작을 위한 v1.1 API 엔드포인트(`get`, `update-metadata`)가 제공되며, v1 지원 종료에 대비하여 대시보드 UI 자동화(`update-metadata-ui`)를 권장합니다.

## 설정

**서비스 계정**(권장, CI/CD에 적합) 또는 **OAuth2 refresh token** 중 하나로 인증합니다.

### 방법 A — 서비스 계정 (권장)

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트를 생성/선택하고 **Chrome Web Store API**를 활성화합니다.
2. **서비스 계정**을 만들고 **JSON 키**를 추가합니다 (키 → 키 추가 → 새 키 만들기 → JSON).
3. [개발자 대시보드](https://chrome.google.com/webstore/devconsole) → **계정**에서 서비스 계정 이메일을 추가해 퍼블리셔 계정에 대한 API 접근 권한을 부여합니다.
4. `CWS_SERVICE_ACCOUNT_KEY`에 JSON 키 **파일 경로**(또는 JSON 원문)를 설정합니다.

자세한 내용은 [서비스 계정으로 Chrome Web Store API 사용하기](https://developer.chrome.com/docs/webstore/service-accounts)를 참고하세요.

### 방법 B — OAuth2 Refresh Token

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트를 생성/선택하고 **Chrome Web Store API**를 활성화합니다.
2. **데스크톱 앱** 유형의 **OAuth2 자격 증명**을 생성하고 **Client ID**와 **Client Secret**을 기록합니다.
3. **loopback 리디렉션**으로 refresh token을 발급받습니다. (기존 `urn:ietf:wg:oauth:2.0:oob` 플로우는 2022년에 Google이 제거하여 더 이상 동작하지 않습니다 — 데스크톱 클라이언트는 이제 `http://localhost`를 사용합니다.)

   ```bash
   # 1. 브라우저에서 아래 URL을 열고 접근을 허용합니다:
   #    https://accounts.google.com/o/oauth2/v2/auth?response_type=code&access_type=offline&prompt=consent&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fchromewebstore&client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost:8080
   #
   # 2. 브라우저가 http://localhost:8080/?code=AUTH_CODE&... 로 리디렉션됩니다.
   #    (서버 불필요 — 주소창에서 `code` 값을 복사하세요).
   #
   # 3. 코드를 refresh token으로 교환:
   curl -X POST https://oauth2.googleapis.com/token \
     -d "client_id=YOUR_CLIENT_ID" \
     -d "client_secret=YOUR_CLIENT_SECRET" \
     -d "code=YOUR_AUTH_CODE" \
     -d "grant_type=authorization_code" \
     -d "redirect_uri=http://localhost:8080"
   ```

   응답에 `refresh_token`이 포함됩니다. 데스크톱 앱 클라이언트는 `http://localhost[:PORT]` 또는 `http://127.0.0.1[:PORT]` 리디렉션을 허용합니다.

### 3. MCP 설정

Claude Code MCP 설정 (`~/.claude/settings.local.json`)에 추가합니다.

**npm + 서비스 계정 (권장):**

```json
{
  "mcpServers": {
    "cws-mcp": {
      "command": "npx",
      "args": ["-y", "@1llum1n4t1/cws-mcp"],
      "env": {
        "CWS_SERVICE_ACCOUNT_KEY": "/path/to/service-account.json",
        "CWS_PUBLISHER_ID": "me",
        "CWS_ITEM_ID": "확장프로그램ID"
      }
    }
  }
}
```

**로컬 클론 + OAuth refresh token:**

```json
{
  "mcpServers": {
    "cws-mcp": {
      "command": "node",
      "args": ["/path/to/cws-mcp/dist/index.js"],
      "env": {
        "CWS_CLIENT_ID": "xxxxx.apps.googleusercontent.com",
        "CWS_CLIENT_SECRET": "GOCSPX-xxxxx",
        "CWS_REFRESH_TOKEN": "1//xxxxx",
        "CWS_PUBLISHER_ID": "me",
        "CWS_ITEM_ID": "확장프로그램ID"
      }
    }
  }
}
```

## 환경 변수

**서비스 계정 키(인증 A)** 또는 **OAuth2 refresh token 3종(인증 B)** 중 하나를 제공하세요.

| 변수 | 필수 | 설명 |
|---|---|---|
| `CWS_SERVICE_ACCOUNT_KEY` | 인증 A | 서비스 계정 JSON 키 파일 경로 또는 JSON 원문. 설정 시 OAuth보다 우선합니다. |
| `CWS_CLIENT_ID` | 인증 B | Google OAuth2 Client ID |
| `CWS_CLIENT_SECRET` | 인증 B | Google OAuth2 Client Secret |
| `CWS_REFRESH_TOKEN` | 인증 B | OAuth2 Refresh Token |
| `CWS_PUBLISHER_ID` | 아니오 | 퍼블리셔 ID (기본값: `me`) |
| `CWS_ITEM_ID` | 아니오 | 기본 확장 프로그램 Item ID |
| `CWS_DASHBOARD_PROFILE_DIR` | 아니오 | `update-metadata-ui`용 브라우저 프로필 경로 (기본값: `~/.cws-mcp-profile`) |

## 사용 예시

### 확장 프로그램 상태 확인
```
cws-mcp status 도구 사용
```

### 업로드 후 퍼블리시
```
1. cws-mcp upload (zipPath="/path/to/extension.zip")
2. cws-mcp publish
```

### 단계적 배포로 퍼블리시
```
cws-mcp publish 사용:
- publishType="STAGED_PUBLISH"
- deployPercentage=10
```

### 리뷰 건너뛰기로 퍼블리시
```
cws-mcp publish에서 skipReview=true 사용
```

### 퍼블리시 없이 제목/설명 업데이트
```
cws-mcp update-metadata 사용:
- title="Pexus"
- summary="Official wallet for Plumise"
- description="..."
- category="productivity"
- defaultLocale="en"
```

### 고급 메타데이터 업데이트
```
cws-mcp update-metadata에서 metadata 객체 전달:
{
  "homepageUrl": "https://plumise.com",
  "supportUrl": "https://plug.plumise.com/docs"
}
```

### API 반영이 안 되는 경우(UI 자동화)
```
cws-mcp update-metadata-ui 사용:
- title
- summary
- description
- category
- homepageUrl
- supportUrl
```

참고:
- 이 도구는 Chrome Web Store 대시보드 UI를 자동 조작합니다.
- 로그인 필요 시 `headless=false`로 1회 실행해 로그인하세요.
- 브라우저 프로필 기본 경로: `~/.cws-mcp-profile` (`CWS_DASHBOARD_PROFILE_DIR`로 변경 가능)

### 단계적 배포
```
1. cws-mcp publish
2. cws-mcp deploy-percentage (percentage=10)
3. cws-mcp deploy-percentage (percentage=50)
4. cws-mcp deploy-percentage (percentage=100)
```

참고: `deploy-percentage`는 7일 활성 사용자 10,000명 이상인 확장 프로그램에서만 사용 가능합니다. 새 비율은 항상 현재 목표보다 높아야 합니다.

## V1 API 지원 종료 안내

`get`과 `update-metadata` 도구는 Chrome Web Store v1.1 API를 사용하며, **2026년 10월 15일 이후 지원이 종료**됩니다. v2 API에는 메타데이터 읽기/쓰기 엔드포인트가 없어 이 도구들이 브릿지 역할을 합니다. 장기적으로는 `update-metadata-ui` (Playwright 대시보드 자동화)를 대안으로 사용하세요.

## 라이선스

MIT
