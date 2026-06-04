#!/usr/bin/env node

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { chromium, type Page } from "playwright";
import { homedir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Version ──

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));
const VERSION: string = pkg.version;

// ── Config ──

const CLIENT_ID = process.env.CWS_CLIENT_ID || "";
const CLIENT_SECRET = process.env.CWS_CLIENT_SECRET || "";
const REFRESH_TOKEN = process.env.CWS_REFRESH_TOKEN || "";
const SERVICE_ACCOUNT_KEY = process.env.CWS_SERVICE_ACCOUNT_KEY || "";
const PUBLISHER_ID = process.env.CWS_PUBLISHER_ID || "me";
const DEFAULT_ITEM_ID = process.env.CWS_ITEM_ID || "";

const API_BASE = "https://chromewebstore.googleapis.com";
const UPLOAD_BASE = "https://chromewebstore.googleapis.com/upload/v2";
const V1_BASE = "https://www.googleapis.com/chromewebstore/v1.1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/chromewebstore";
/** Date after which Google removes the Chrome Web Store v1.1 API. */
const V1_SUNSET = "2026-10-15";
const DASHBOARD_PROFILE_DIR =
  process.env.CWS_DASHBOARD_PROFILE_DIR || resolve(homedir(), ".cws-mcp-profile");

// ── Auth: OAuth2 refresh token & service account (JWT bearer) ──

let cachedToken: { access_token: string; expires_at: number } | null = null;

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/** Load a service account key from CWS_SERVICE_ACCOUNT_KEY (raw JSON or a file path). Returns null when not configured. */
function loadServiceAccount(): ServiceAccountKey | null {
  const value = SERVICE_ACCOUNT_KEY.trim();
  if (!value) return null;

  let raw = value;
  if (!raw.startsWith("{")) {
    // Treat the value as a path to a JSON key file.
    raw = readFileSync(resolve(raw), "utf-8");
  }

  let key: { client_email?: string; private_key?: string };
  try {
    key = JSON.parse(raw);
  } catch {
    throw new Error(
      "CWS_SERVICE_ACCOUNT_KEY is neither valid JSON nor a readable JSON key file path.",
    );
  }
  if (!key.client_email || !key.private_key) {
    throw new Error(
      "Invalid service account key: missing 'client_email' or 'private_key'.",
    );
  }
  return { client_email: key.client_email, private_key: key.private_key };
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** Mint an access token from a service account using the RS256 JWT-bearer grant. */
async function fetchTokenViaServiceAccount(
  sa: ServiceAccountKey,
): Promise<{ access_token: string; expires_in: number }> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(sa.private_key, "base64url");
  const assertion = `${signingInput}.${signature}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Service account token request failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as { access_token: string; expires_in: number };
}

/** Mint an access token from an OAuth2 refresh token. */
async function fetchTokenViaRefreshToken(): Promise<{ access_token: string; expires_in: number }> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
    grant_type: "refresh_token",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as { access_token: string; expires_in: number };
}

/**
 * Resolve an access token, preferring a service account when configured and
 * falling back to the OAuth2 refresh-token flow. Tokens are cached until expiry.
 */
async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expires_at - 60_000) {
    return cachedToken.access_token;
  }

  const sa = loadServiceAccount();
  let data: { access_token: string; expires_in: number };
  if (sa) {
    data = await fetchTokenViaServiceAccount(sa);
  } else if (CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN) {
    data = await fetchTokenViaRefreshToken();
  } else {
    throw new Error(
      "Missing credentials. Set CWS_SERVICE_ACCOUNT_KEY (service account), " +
        "or CWS_CLIENT_ID + CWS_CLIENT_SECRET + CWS_REFRESH_TOKEN (OAuth refresh token).",
    );
  }

  cachedToken = {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.access_token;
}

// ── Helpers ──

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function resolveItemId(itemId?: string): string {
  const id = itemId || DEFAULT_ITEM_ID;
  if (!id) {
    throw new Error("No item ID provided. Pass itemId parameter or set CWS_ITEM_ID env var.");
  }
  return id;
}

function resolvePublisherId(publisherId?: string): string {
  return publisherId || PUBLISHER_ID;
}

async function apiCall(
  url: string,
  options: RequestInit,
): Promise<{ ok: boolean; status: number; body: string }> {
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...((options.headers as Record<string, string>) || {}),
  };

  const res = await fetch(url, { ...options, headers });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError: boolean;
};

/** Format an API response with structured error info when applicable. */
function formatResponse(result: { ok: boolean; status: number; body: string }): ToolResult {
  if (result.ok) {
    return { content: [{ type: "text", text: result.body }], isError: false };
  }

  // Try to parse the error body for a more readable message.
  let errorDetail = result.body;
  try {
    const parsed = JSON.parse(result.body);
    if (parsed.error?.message) {
      errorDetail = `${parsed.error.message} (code: ${parsed.error.code || result.status})`;
    }
  } catch {
    // Keep raw body
  }

  return {
    content: [{ type: "text", text: `API Error (${result.status}): ${errorDetail}` }],
    isError: true,
  };
}

/** Append an extra note (e.g. deprecation warning) to a tool result. */
function appendNote(result: ToolResult, note: string): ToolResult {
  return { ...result, content: [...result.content, { type: "text", text: note }] };
}

const V1_NOTE =
  `⚠️ This tool uses the Chrome Web Store v1.1 API, which Google will remove after ${V1_SUNSET}. ` +
  `The v2 API has no metadata read/write endpoint — for store-listing changes, prefer the 'update-metadata-ui' tool.`;

function toolError(e: unknown): ToolResult {
  return { content: [{ type: "text", text: `Error: ${errMsg(e)}` }], isError: true };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fillTextFieldByLabel(page: Page, labels: string[], value: string) {
  const parts = labels.map(escapeRegExp).join("|");
  const regex = new RegExp(parts, "i");

  const candidates = [
    page.getByLabel(regex).first(),
    page.getByRole("textbox", { name: regex }).first(),
    page.getByPlaceholder(regex).first(),
  ];

  for (const locator of candidates) {
    if ((await locator.count()) > 0) {
      await locator.fill(value);
      return;
    }
  }

  const labelNode = page.getByText(regex).first();
  if ((await labelNode.count()) > 0) {
    const container = labelNode.locator("xpath=ancestor::*[self::div or self::section][1]");
    const field = container.locator("textarea, input[type='text'], input:not([type])").first();
    if ((await field.count()) > 0) {
      await field.fill(value);
      return;
    }
  }

  throw new Error(`Unable to locate field by labels: ${labels.join(", ")}`);
}

async function uploadFileBySectionLabel(page: Page, labels: string[], filePath: string) {
  const resolvedPath = resolve(filePath);
  const parts = labels.map(escapeRegExp).join("|");
  const regex = new RegExp(parts, "i");

  const labelNode = page.getByText(regex).first();
  if ((await labelNode.count()) > 0) {
    const container = labelNode.locator("xpath=ancestor::*[self::div or self::section][1]");
    const fileInput = container.locator("input[type='file']").first();
    if ((await fileInput.count()) > 0) {
      await fileInput.setInputFiles(resolvedPath);
      await page.waitForTimeout(1200);
      return;
    }
  }

  const anyFileInput = page.locator("input[type='file']").first();
  if ((await anyFileInput.count()) > 0) {
    await anyFileInput.setInputFiles(resolvedPath);
    await page.waitForTimeout(1200);
    return;
  }

  throw new Error(`Unable to locate file input for labels: ${labels.join(", ")}`);
}

async function clickSaveButton(page: Page) {
  const roleCandidates = [
    page.getByRole("button", { name: /save|저장|임시저장|save draft/i }).first(),
    page.getByRole("button", { name: /submit for review|검토/i }).first(),
  ];

  for (const saveBtn of roleCandidates) {
    if ((await saveBtn.count()) > 0) {
      await saveBtn.click();
      await page.waitForTimeout(2000);
      return;
    }
  }

  const textCandidates = [
    page.locator("button:has-text('저장')").first(),
    page.locator("button:has-text('임시저장')").first(),
    page.locator("button:has-text('Save')").first(),
  ];
  for (const saveBtn of textCandidates) {
    if ((await saveBtn.count()) > 0) {
      await saveBtn.click();
      await page.waitForTimeout(2000);
      return;
    }
  }

  if ((await page.getByText(/항목이 저장되었습니다|saved/i).count()) > 0) {
    return;
  }

  if ((await page.getByText(/변경사항이 저장되지 않았|unsaved/i).count()) === 0) {
    throw new Error("Save button not found on dashboard page.");
  }
}

// ── Shared tool schemas (single source of truth for main server + sandbox) ──

const itemIdSchema = z
  .string()
  .optional()
  .describe("Extension item ID (defaults to CWS_ITEM_ID env var)");
const publisherIdSchema = z
  .string()
  .optional()
  .describe("Publisher ID (defaults to CWS_PUBLISHER_ID env var or 'me')");

const schemas = {
  upload: {
    zipPath: z.string().describe("Absolute path to the ZIP file to upload"),
    itemId: itemIdSchema,
    publisherId: publisherIdSchema,
  },
  publish: {
    itemId: itemIdSchema,
    publisherId: publisherIdSchema,
    publishType: z
      .enum(["DEFAULT_PUBLISH", "STAGED_PUBLISH"])
      .optional()
      .describe(
        "DEFAULT_PUBLISH: publishes immediately after approval. STAGED_PUBLISH: stages for manual publishing after approval. Defaults to DEFAULT_PUBLISH.",
      ),
    deployPercentage: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe("Initial deploy percentage for staged rollout (0-100)."),
    skipReview: z
      .boolean()
      .optional()
      .describe("Attempt to skip review if the extension qualifies. Defaults to false."),
    blockOnWarnings: z
      .boolean()
      .optional()
      .describe("If true, the publish is blocked when the submission has warnings. Defaults to false."),
  },
  status: {
    itemId: itemIdSchema,
    publisherId: publisherIdSchema,
  },
  cancel: {
    itemId: itemIdSchema,
    publisherId: publisherIdSchema,
  },
  "deploy-percentage": {
    percentage: z
      .number()
      .min(0)
      .max(100)
      .describe("Deploy percentage (0-100). Must be larger than the current target percentage."),
    itemId: itemIdSchema,
    publisherId: publisherIdSchema,
  },
  get: {
    itemId: itemIdSchema,
    projection: z
      .enum(["DRAFT", "PUBLISHED"])
      .optional()
      .describe("Metadata projection to fetch (defaults to DRAFT)"),
  },
  "update-metadata": {
    itemId: itemIdSchema,
    title: z.string().optional().describe("Store listing title"),
    summary: z.string().optional().describe("Store listing short summary"),
    description: z.string().optional().describe("Store listing description"),
    category: z.string().optional().describe("Category (e.g. 'productivity', 'developer_tools')"),
    defaultLocale: z.string().optional().describe("Default locale (e.g. 'ko', 'en')"),
    homepageUrl: z.string().optional().describe("Homepage URL"),
    supportUrl: z.string().optional().describe("Support URL"),
    metadata: z
      .record(z.unknown())
      .optional()
      .describe(
        "Raw metadata object forwarded as-is to the v1.1 API. Useful for fields not exposed as first-class params.",
      ),
  },
  "update-metadata-ui": {
    itemId: itemIdSchema,
    title: z.string().optional().describe("Store listing title"),
    summary: z.string().optional().describe("Store listing short summary"),
    description: z.string().optional().describe("Store listing long description"),
    category: z.string().optional().describe("Category label as shown in dashboard UI"),
    homepageUrl: z.string().optional().describe("Homepage URL"),
    supportUrl: z.string().optional().describe("Support URL"),
    storeIconPath: z.string().optional().describe("Absolute path to 128x128 store icon image"),
    accountIndex: z
      .number()
      .int()
      .min(0)
      .max(9)
      .optional()
      .describe("Google account index in dashboard URL (default: 0)"),
    headless: z.boolean().optional().describe("Run browser headless (default: false)"),
  },
} as const;

const descriptions: Record<keyof typeof schemas, string> = {
  upload:
    "Upload a ZIP file to update an existing Chrome Web Store item draft. Note: Creating new items via API is not supported in v2 — use the Developer Dashboard to create new items.",
  publish:
    "Publish an extension to Chrome Web Store. Supports immediate publish, staged publish, initial deploy percentage, block-on-warnings, and skip-review.",
  status:
    "Fetch the current status of an extension on Chrome Web Store. Returns published/submitted revision status, deploy percentage, version, takedown/warning flags, and last upload state.",
  cancel:
    "Cancel a pending submission on Chrome Web Store. Can be used to cancel an item currently in review.",
  "deploy-percentage":
    "Set the published deploy percentage for staged rollout on Chrome Web Store. The new percentage must be higher than the current target. Only available for items with 10,000+ seven-day active users.",
  get:
    `Get the current metadata of a Chrome Web Store item (v1.1 API). Returns title, description, category, and other listing fields. Note: the v1.1 API is deprecated and will be removed after ${V1_SUNSET}.`,
  "update-metadata":
    `Update the store listing metadata of a Chrome Web Store item (v1.1 API). Supports common fields and a raw metadata payload. Note: the v1.1 API is deprecated and will be removed after ${V1_SUNSET}. Use 'update-metadata-ui' as the long-term alternative.`,
  "update-metadata-ui":
    "Update listing metadata via Chrome Web Store dashboard UI automation (Playwright). Use this when API metadata updates are not reflected, or as the primary metadata update method since the v1.1 API is deprecated.",
};

// ── MCP Server ──

const server = new McpServer({
  name: "cws-mcp",
  version: VERSION,
});

// ── upload ──
server.registerTool(
  "upload",
  { description: descriptions.upload, inputSchema: schemas.upload },
  async ({ zipPath, itemId, publisherId }) => {
    try {
      const id = resolveItemId(itemId);
      const pub = resolvePublisherId(publisherId);
      const zipData = readFileSync(zipPath);

      const url = `${UPLOAD_BASE}/publishers/${pub}/items/${id}:upload`;
      const result = await apiCall(url, {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: new Uint8Array(zipData),
      });

      return formatResponse(result);
    } catch (e) {
      return toolError(e);
    }
  },
);

// ── publish ──
server.registerTool(
  "publish",
  { description: descriptions.publish, inputSchema: schemas.publish },
  async ({ itemId, publisherId, publishType, deployPercentage, skipReview, blockOnWarnings }) => {
    try {
      const id = resolveItemId(itemId);
      const pub = resolvePublisherId(publisherId);

      const url = `${API_BASE}/v2/publishers/${pub}/items/${id}:publish`;

      const body: Record<string, unknown> = {};
      if (publishType) body.publishType = publishType;
      if (deployPercentage !== undefined) body.deployInfos = [{ deployPercentage }];
      if (skipReview !== undefined) body.skipReview = skipReview;
      if (blockOnWarnings !== undefined) body.blockOnWarnings = blockOnWarnings;

      const hasBody = Object.keys(body).length > 0;
      const result = await apiCall(url, {
        method: "POST",
        ...(hasBody
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
          : {}),
      });

      return formatResponse(result);
    } catch (e) {
      return toolError(e);
    }
  },
);

// ── status ──
server.registerTool(
  "status",
  { description: descriptions.status, inputSchema: schemas.status },
  async ({ itemId, publisherId }) => {
    try {
      const id = resolveItemId(itemId);
      const pub = resolvePublisherId(publisherId);

      const url = `${API_BASE}/v2/publishers/${pub}/items/${id}:fetchStatus`;
      const result = await apiCall(url, { method: "GET" });

      return formatResponse(result);
    } catch (e) {
      return toolError(e);
    }
  },
);

// ── cancel ──
server.registerTool(
  "cancel",
  { description: descriptions.cancel, inputSchema: schemas.cancel },
  async ({ itemId, publisherId }) => {
    try {
      const id = resolveItemId(itemId);
      const pub = resolvePublisherId(publisherId);

      const url = `${API_BASE}/v2/publishers/${pub}/items/${id}:cancelSubmission`;
      const result = await apiCall(url, { method: "POST" });

      return formatResponse(result);
    } catch (e) {
      return toolError(e);
    }
  },
);

// ── deploy-percentage ──
server.registerTool(
  "deploy-percentage",
  { description: descriptions["deploy-percentage"], inputSchema: schemas["deploy-percentage"] },
  async ({ percentage, itemId, publisherId }) => {
    try {
      const id = resolveItemId(itemId);
      const pub = resolvePublisherId(publisherId);

      const url = `${API_BASE}/v2/publishers/${pub}/items/${id}:setPublishedDeployPercentage`;
      const result = await apiCall(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deployPercentage: percentage }),
      });

      return formatResponse(result);
    } catch (e) {
      return toolError(e);
    }
  },
);

// ── get (v1.1 — deprecated, sunset Oct 2026) ──
server.registerTool(
  "get",
  { description: descriptions.get, inputSchema: schemas.get },
  async ({ itemId, projection }) => {
    try {
      const id = resolveItemId(itemId);
      const p = projection || "DRAFT";
      const url = `${V1_BASE}/items/${id}?projection=${encodeURIComponent(p)}`;
      const result = await apiCall(url, { method: "GET" });

      return appendNote(formatResponse(result), V1_NOTE);
    } catch (e) {
      return toolError(e);
    }
  },
);

// ── update-metadata (v1.1 — deprecated, sunset Oct 2026) ──
server.registerTool(
  "update-metadata",
  { description: descriptions["update-metadata"], inputSchema: schemas["update-metadata"] },
  async ({ itemId, title, summary, description, category, defaultLocale, homepageUrl, supportUrl, metadata }) => {
    try {
      const id = resolveItemId(itemId);
      const url = `${V1_BASE}/items/${id}`;

      const payload: Record<string, unknown> = { ...(metadata || {}) };
      if (title !== undefined) payload.title = title;
      if (summary !== undefined) payload.summary = summary;
      if (description !== undefined) payload.description = description;
      if (category !== undefined) payload.category = category;
      if (defaultLocale !== undefined) payload.defaultLocale = defaultLocale;
      if (homepageUrl !== undefined) payload.homepageUrl = homepageUrl;
      if (supportUrl !== undefined) payload.supportUrl = supportUrl;

      if (Object.keys(payload).length === 0) {
        throw new Error("No metadata fields provided.");
      }

      const result = await apiCall(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      return appendNote(formatResponse(result), V1_NOTE);
    } catch (e) {
      return toolError(e);
    }
  },
);

// ── update-metadata-ui (dashboard automation) ──
server.registerTool(
  "update-metadata-ui",
  { description: descriptions["update-metadata-ui"], inputSchema: schemas["update-metadata-ui"] },
  async ({ itemId, title, summary, description, category, homepageUrl, supportUrl, storeIconPath, accountIndex, headless }) => {
    try {
      const id = resolveItemId(itemId);
      const idx = accountIndex ?? 0;
      const dashboardUrl = `https://chromewebstore.google.com/u/${idx}/dashboard/${id}/edit`;

      const hasAnyField = [title, summary, description, category, homepageUrl, supportUrl, storeIconPath].some(
        (v) => typeof v === "string" && v.trim().length > 0,
      );
      if (!hasAnyField) {
        throw new Error("No fields provided for UI update.");
      }

      const context = await chromium.launchPersistentContext(DASHBOARD_PROFILE_DIR, {
        channel: "chrome",
        headless: headless ?? false,
      });

      try {
        const page = context.pages()[0] || (await context.newPage());
        await page.goto(dashboardUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await page.waitForTimeout(2500);

        if (page.url().includes("accounts.google.com")) {
          throw new Error(
            `Not signed in to Chrome Web Store dashboard. Open once with headless=false and sign in. Profile dir: ${DASHBOARD_PROFILE_DIR}`,
          );
        }

        if (title?.trim()) {
          await fillTextFieldByLabel(page, ["Title", "제목", "Name", "이름"], title.trim());
        }
        if (summary?.trim()) {
          await fillTextFieldByLabel(page, ["Summary", "Short description", "요약", "짧은 설명"], summary.trim());
        }
        if (description?.trim()) {
          await fillTextFieldByLabel(page, ["Description", "설명"], description.trim());
        }
        if (homepageUrl?.trim()) {
          await fillTextFieldByLabel(page, ["Homepage", "홈페이지"], homepageUrl.trim());
        }
        if (supportUrl?.trim()) {
          await fillTextFieldByLabel(page, ["Support", "지원", "Help", "도움말"], supportUrl.trim());
        }
        if (storeIconPath?.trim()) {
          await uploadFileBySectionLabel(page, ["Store icon", "스토어 아이콘", "아이콘", "Icon"], storeIconPath.trim());
        }

        if (category?.trim()) {
          const categoryCombo = page.getByRole("combobox", { name: /category|카테고리/i }).first();
          if ((await categoryCombo.count()) > 0) {
            await categoryCombo.click();
            const option = page.getByRole("option", { name: new RegExp(escapeRegExp(category), "i") }).first();
            if ((await option.count()) > 0) {
              await option.click();
            }
          }
        }

        await clickSaveButton(page);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: true, mode: "dashboard-ui", profileDir: DASHBOARD_PROFILE_DIR, url: page.url() },
                null,
                2,
              ),
            },
          ],
          isError: false,
        };
      } finally {
        await context.close();
      }
    } catch (e) {
      return toolError(e);
    }
  },
);

// ── Resources ──

server.registerResource(
  "extension-status",
  new ResourceTemplate("cws://extensions/{extensionId}", { list: undefined }),
  {
    title: "Chrome Web Store extension status",
    description:
      "Get the current status (v2) and store-listing metadata (v1.1, while available) of a Chrome Web Store extension by its item ID.",
    mimeType: "application/json",
  },
  async (uri, variables) => {
    const extensionId = String(variables.extensionId);
    try {
      const pub = resolvePublisherId();
      const token = await getAccessToken();

      // v2 status — the canonical source, must succeed.
      const statusRes = await fetch(`${API_BASE}/v2/publishers/${pub}/items/${extensionId}:fetchStatus`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const statusText = await statusRes.text();
      let statusData: unknown;
      try {
        statusData = JSON.parse(statusText);
      } catch {
        statusData = { raw: statusText };
      }

      // v1.1 metadata — optional, gracefully degrades once the v1.1 API is sunset.
      let metaData: unknown;
      try {
        const metaRes = await fetch(`${V1_BASE}/items/${extensionId}?projection=PUBLISHED`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const metaText = await metaRes.text();
        try {
          metaData = JSON.parse(metaText);
        } catch {
          metaData = { raw: metaText };
        }
      } catch (e) {
        metaData = {
          unavailable: `v1.1 metadata fetch failed (the v1.1 API is deprecated after ${V1_SUNSET}): ${errMsg(e)}`,
        };
      }

      const result = { extensionId, status: statusData, metadata: metaData };
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (e) {
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify({ extensionId, error: errMsg(e) }) },
        ],
      };
    }
  },
);

// ── Prompts ──

server.registerPrompt(
  "publish_extension",
  {
    description:
      "Step-by-step guide for publishing or updating a Chrome extension on the Chrome Web Store. Walks through upload, metadata update, and publish steps.",
    argsSchema: {
      extensionId: z.string().describe("The Chrome Web Store extension item ID"),
      zipPath: z.string().describe("Absolute path to the built extension ZIP file"),
      version: z.string().optional().describe("New version string (e.g. '1.2.0') for context"),
    },
  },
  ({ extensionId, zipPath, version }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Please help me publish my Chrome extension to the Chrome Web Store.

Extension ID: ${extensionId}
ZIP file: ${zipPath}${version ? `\nNew version: ${version}` : ""}

Follow these steps using the available cws-mcp tools:

1. **Upload the ZIP** — Use the \`upload\` tool with zipPath="${zipPath}" and itemId="${extensionId}" to upload the new build as a draft.
2. **Verify upload** — Use the \`status\` tool to confirm the upload succeeded and the item is in DRAFT state.
3. **Check/update metadata** — Use the \`get\` tool (projection=DRAFT) to review current listing metadata. If anything needs updating (title, description, category), prefer \`update-metadata-ui\` (the v1.1-based \`update-metadata\` is deprecated and sunset ${V1_SUNSET}).
4. **Publish** — Use the \`publish\` tool to submit the draft for review. Optionally use publishType="STAGED_PUBLISH" for staged rollout, or skipReview=true if eligible.
5. **Confirm submission** — Use the \`status\` tool again to confirm the item entered the review queue.
6. **Optional staged rollout** — After approval, use \`deploy-percentage\` to gradually roll out (e.g., 10%, 50%, 100%).

Please start with step 1 now.`,
        },
      },
    ],
  }),
);

server.registerPrompt(
  "check_status",
  {
    description:
      "Check the review status and deployment percentage of a Chrome extension, and surface any actionable next steps.",
    argsSchema: {
      extensionId: z.string().describe("The Chrome Web Store extension item ID"),
    },
  },
  ({ extensionId }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Please check the current status of my Chrome extension.

Extension ID: ${extensionId}

Use the following cws-mcp tools to gather a full picture:

1. **Fetch status** — Use the \`status\` tool with itemId="${extensionId}" to get the review status and any rejection reasons.
2. **Fetch metadata** — Use the \`get\` tool with itemId="${extensionId}" and projection=PUBLISHED to see what is currently live (v1.1 API, sunset ${V1_SUNSET}).
3. **Summarize** — Report:
   - Current review state (e.g., IN_REVIEW, PUBLISHED, REJECTED, DRAFT)
   - Deployed version and deploy percentage if in staged rollout
   - Any rejection reason or action required
   - Recommended next steps (e.g., fix policy violations, increase deploy-percentage, or no action needed)

Please start with step 1 now.`,
        },
      },
    ],
  }),
);

// ── Start ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${errMsg(err)}\n`);
  process.exit(1);
});

// ── Smithery Sandbox ──
// Reuses the shared schemas/descriptions so tool definitions stay in one place.

export function createSandboxServer() {
  const sandbox = new McpServer({
    name: "cws-mcp",
    version: VERSION,
  });

  const noop = async (): Promise<ToolResult> => ({
    content: [{ type: "text", text: "sandbox" }],
    isError: false,
  });

  for (const name of Object.keys(schemas) as (keyof typeof schemas)[]) {
    sandbox.registerTool(name, { description: descriptions[name], inputSchema: schemas[name] }, noop);
  }

  return sandbox;
}
