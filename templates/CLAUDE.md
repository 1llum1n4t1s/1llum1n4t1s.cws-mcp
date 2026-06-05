# Chrome Web Store Extension Management

This project uses **cws-mcp** to manage Chrome Web Store extensions via MCP tools.

## Available Tools

Use `mcp__cws-mcp__<tool>` for all Chrome Web Store operations:

| Tool | When to Use |
|---|---|
| `upload` | Upload a new ZIP build to Chrome Web Store as a draft |
| `publish` | Publish the current draft to users (supports staged rollout) |
| `status` | Check review state, published version, deploy percentage |
| `cancel` | Cancel a pending review submission |
| `deploy-percentage` | Increase staged rollout percentage (10 -> 50 -> 100) |
| `get` | Read current listing metadata (title, description, etc.) |
| `update-metadata` | Update listing metadata via API |
| `submit` | One-shot: run upload -> publish -> status in a single call (with existence preflight and readable errors) |

## Common Workflows

### Build and publish a new version
1. Build the extension ZIP
2. `upload` with the ZIP path
3. `status` to confirm upload succeeded
4. `publish` to submit for review

### Staged rollout
1. `publish` with `publishType="STAGED_PUBLISH"` and `deployPercentage=10`
2. Monitor with `status`
3. Increase with `deploy-percentage` (10 -> 50 -> 100)

### Update store listing
1. Use `update-metadata` for title, description, category changes
2. `publish` if changes need to go live

> After the v1.1 API is retired, make listing changes manually in the Chrome Web Store Developer Dashboard: the v2 API has no metadata write endpoint, and this MCP does not automate the browser.

### Create a new item
The Chrome Web Store API cannot create items. Create new items manually in the Developer Dashboard, then use `upload`/`publish` to manage them.

## Important Notes

- Always `status` before `publish` to check current state
- `deploy-percentage` only works for extensions with 10,000+ weekly active users
- Rollout percentage can only increase, never decrease
- v1.1 API tools (`get`, `update-metadata`) deprecated after Oct 2026
