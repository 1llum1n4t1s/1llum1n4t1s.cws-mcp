# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP (Model Context Protocol) server that manages Chrome Web Store extensions (upload, publish, status, staged rollout, listing metadata). It runs over **stdio** and is consumed by MCP clients (Claude Code, Smithery, etc.). It is a fork of `mikusnuz/cws-mcp` rewritten for the Chrome Web Store **API v2**.

## Commands

Package manager is **pnpm** (pinned via Volta; `package-lock.json` is not used). Node **>=20**.

```bash
pnpm install              # install deps (CI/Docker use --frozen-lockfile)
pnpm build                # tsc -> dist/ (the published/runnable output)
pnpm dev                  # run from source via tsx (src/index.ts), no build step
pnpm start                # run the built server (node dist/index.js)
pnpm exec tsc --noEmit    # type-check only — the de-facto test gate (see "Testing")
```

To exercise the server manually it needs credentials in env (`CWS_SERVICE_ACCOUNT_KEY`, **or** `CWS_CLIENT_ID`/`CWS_CLIENT_SECRET`/`CWS_REFRESH_TOKEN`) plus optionally `CWS_PUBLISHER_ID` / `CWS_ITEM_ID`. See README "Environment Variables".

### Testing

There is **no test suite and no test runner**. `tsc --noEmit` is the only automated check. After changing `src/index.ts`, run it before considering the change done. When adding tests, the highest-value targets are the pure functions (`interpretCwsError`, `summarizeStatus`, `loadServiceAccount`, `base64url`) — they carry the non-trivial, regression-prone logic and need no network.

## Architecture

Everything lives in a single file: **`src/index.ts`** (~1000 lines). The logical layers, top to bottom:

1. **Config** — credentials and API base URLs are read from `process.env` into module constants at import time. `V1_SUNSET` (2026-10-15) is the date Google removes the v1.1 API.
2. **Auth** — two credential paths: a **service account** (RS256 JWT-bearer grant, signed locally with `node:crypto`) or an **OAuth2 refresh token**. `getAccessToken()` prefers the service account, caches the token in a module-level `cachedToken`, and uses a **single-flight `tokenInflight` promise** so concurrent requests don't mint duplicate tokens.
3. **`apiCall(url, options, timeoutMs)`** — the single chokepoint for every authenticated HTTP call. It attaches the Bearer token, enforces a timeout (via `AbortSignal.timeout`), and **invalidates `cachedToken` on 401/403** so auth self-recovers. **All new HTTP must go through `apiCall`** — do not add raw `fetch` calls in tool/resource handlers, or they bypass token/timeout/401 handling.
4. **Error/response helpers** — `interpretCwsError` maps CWS responses to actionable hints by **string-matching the response body** (fragile to Google wording/key changes — keep HTTP status as the primary signal). `summarizeStatus` recursively pulls a human summary out of the v2 status JSON. `formatResponse` / `appendNote` shape `ToolResult`.
5. **`schemas` + `descriptions`** — zod input schemas and tool descriptions, declared once as the **single source of truth** and reused by both the main server and the Smithery sandbox.
6. **Tool / resource / prompt registration** — 8 tools, 1 resource (`cws://extensions/{id}`), 2 prompts. `submit` is an **orchestrator** that runs preflight → upload → publish → status in sequence (it deliberately reuses `buildPublishBody` / `itemUrl` rather than re-implementing the individual tools' logic).
7. **`createSandboxServer()`** — an exported, no-op server for Smithery tool discovery. It registers every key in `schemas` with a noop handler.

### Two API surfaces

- **v2** (`chromewebstoregoogleapis.com`): upload, publish, fetchStatus, cancelSubmission, setPublishedDeployPercentage. The canonical, supported surface.
- **v1.1** (`googleapis.com/chromewebstore/v1.1`, **deprecated, sunset 2026-10-15**): the only way to read/write listing **metadata** (`get`, `update-metadata`) — v2 has no metadata endpoint. These two tools call `v1SunsetGuard()` first, which short-circuits with a clear error once the sunset date has passed.

## Conventions and constraints specific to this repo

- **The CWS API cannot create items**, and there is **no "list all items" endpoint** — every operation targets a single `itemId`. The `extension-status` resource intentionally has `list: undefined` for this reason.
- **`itemId` / `publisherId` are URL path segments.** `resolveItemId` / `resolvePublisherId` `encodeURIComponent` them; keep new URL building going through `itemUrl()` so this safety holds.
- **Version is duplicated across files and must stay in sync**: `package.json` `version`, and `server.json` (two `version` fields). The publish workflow fails if the `release/x.y.z` branch name doesn't match `package.json`. Bump versions only on explicit request (use the user's `/vava` flow); do not bump as a side effect of other edits.
- **Adding a tool** = add to `schemas` + `descriptions` + a `registerTool(...)` call. Because the sandbox auto-registers from `schemas` while the main server registers tools individually, keep the `schemas` keys and the main-server registrations in sync.
- **`templates/CLAUDE.md` and `templates/AGENTS.md` are NOT instructions for this repo** — they are consumer-facing templates shipped to *users'* extension projects to teach their agent how to drive the `mcp__cws-mcp__*` tools. Edit them only to reflect changes in the tool surface.

## Distribution

- **npm** via GitHub Actions Trusted Publishing (OIDC, no token) in `.github/workflows/npm-publish.yml`, triggered by pushing a `release/**` branch (matches the convention used across the user's other projects).
- **Docker** (`Dockerfile`, multi-stage, `node:22-alpine`), **Smithery** (`smithery.yaml`), and the **MCP Registry** (`server.json`). `llms.txt` is the machine-readable summary. When the tool surface or auth options change, update README.md, README.ko.md, llms.txt, smithery.yaml, and server.json together.
