# Chrome Web Store Extension Management

This project uses **cws-mcp** to manage Chrome Web Store extensions via MCP tools.

## Available Tools

Use `mcp__cws-mcp__<tool>` for all Chrome Web Store operations:

- `upload` — Upload a ZIP file to Chrome Web Store (updates existing item draft)
- `publish` — Publish an extension with optional staged rollout and skip-review
- `status` — Fetch current status: review state, deploy percentage, version
- `cancel` — Cancel a pending submission
- `deploy-percentage` — Set staged rollout percentage (0-100, must exceed current)
- `get` — Read draft/published listing metadata (v1.1 API)
- `update-metadata` — Update listing metadata via v1.1 API
- `submit` — One-shot: run `upload` -> `publish` -> `status` in a single call (with existence-check preflight and readable errors)

## Common Workflows

### Build and publish a new version
1. Build the extension ZIP
2. Call `upload` with the ZIP path
3. Call `status` to confirm upload succeeded
4. Call `publish` to submit for review

### Staged rollout
1. Call `publish` with `publishType="STAGED_PUBLISH"` and `deployPercentage=10`
2. Monitor with `status`
3. Increase with `deploy-percentage` (10 -> 50 -> 100)

### Update store listing
1. Use `update-metadata` for title, description, category (v1.1 API)
2. Call `publish` if changes need to go live

Note: The v1.1 API is deprecated and shuts down on 2026-10-15. After that, edit
listing metadata manually in the Chrome Web Store Developer Dashboard — the v2 API
has no metadata-write endpoint, and this MCP does not automate the browser.

### Create a new item
The Chrome Web Store API cannot create items. Create a new item manually in the
Chrome Web Store Developer Dashboard, then use `upload`/`publish` to manage it.

## Rules

- Always check `status` before `publish` to verify current state
- `deploy-percentage` only works for extensions with 10,000+ weekly active users
- Rollout percentage can only increase, never decrease
- v1.1 API tools (`get`, `update-metadata`) are deprecated and shut down on 2026-10-15
