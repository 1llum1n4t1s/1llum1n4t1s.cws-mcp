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

/**
 * 既知の Chrome Web Store エラーを「次に何をすればよいか」が分かる助言に翻訳する。
 * 該当しなければ null を返す（呼び出し側は生エラーのみを見せる）。
 */
function interpretCwsError(status: number, body: string): string | null {
  const b = body.toLowerCase();

  // itemId が空・不正・未作成（今回の ReplaceTranslator 404 ブロッカーの正体）。
  if (b.includes("could not find handler")) {
    return (
      "Hint: the item ID looks empty or malformed (the request URL had no valid item ID). " +
      "For a brand-new extension, create the item first with the 'create-item-ui' tool (or the Developer Dashboard), " +
      "then set CWS_ITEM_ID / pass itemId."
    );
  }
  // publisher が見つからない（generic 404 より先に判定）。
  if (b.includes("publisher") && (b.includes("not found") || b.includes("no publisher"))) {
    return "Hint: publisher not found. Check CWS_PUBLISHER_ID (or pass publisherId). 'me' targets the authenticated publisher.";
  }
  // 認証・権限。
  if (
    status === 401 ||
    status === 403 ||
    b.includes("invalid_grant") ||
    b.includes("unauthorized") ||
    b.includes("invalid credentials") ||
    b.includes("insufficient permission")
  ) {
    return (
      "Hint: authentication/authorization failed. Check CWS_SERVICE_ACCOUNT_KEY (service account) " +
      "or CWS_CLIENT_ID / CWS_CLIENT_SECRET / CWS_REFRESH_TOKEN, confirm the account owns this item/publisher, " +
      "and that the OAuth scope includes chromewebstore."
    );
  }
  // 審査中で更新不可。
  if (
    b.includes("in review") ||
    b.includes("pending review") ||
    b.includes("being reviewed") ||
    b.includes("not updatable") ||
    b.includes("item_not_updatable") ||
    b.includes("review in progress")
  ) {
    return (
      "Hint: the item is currently in review and cannot be updated. " +
      "Wait for the review to finish, or cancel the pending submission with the 'cancel' tool, then re-upload."
    );
  }
  // version 重複。
  if (
    b.includes("version already exists") ||
    b.includes("already been uploaded") ||
    b.includes("duplicate version") ||
    (b.includes("version") && b.includes("conflict"))
  ) {
    return (
      "Hint: this version already exists on the store. " +
      "Bump the 'version' field in the extension's manifest.json, rebuild the ZIP, and retry."
    );
  }
  // レート制限 / quota。
  if (status === 429 || b.includes("quota") || b.includes("rate limit") || b.includes("too many requests")) {
    return "Hint: rate limit / quota exceeded. Wait a bit and retry.";
  }
  // 上記に当てはまらない 404 / not found は item 不在として案内。
  if (status === 404 || b.includes("not found")) {
    return (
      "Hint: the item ID does not exist or you lack access to it. " +
      "Double-check the 32-char item ID (CWS_ITEM_ID / itemId); for a new extension create it first with 'create-item-ui'."
    );
  }
  return null;
}

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

  const hint = interpretCwsError(result.status, result.body);
  const text = `API Error (${result.status}): ${errorDetail}` + (hint ? `\n\n${hint}` : "");

  return {
    content: [{ type: "text", text }],
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

/** Chrome Web Store の item ID は a–p の 32 文字。ダッシュボード URL から 1 つ抜き出す。 */
function extractItemIdFromUrl(url: string): string | null {
  // ダッシュボード/アイテム URL のパスに現れる ID を優先（/dashboard/<id>/edit, /items/<id>, /detail/<id> 等）。
  const path = url.match(/\/(?:dashboard|items|detail)\/([a-p]{32})(?![a-p])/);
  if (path) return path[1];
  // フォールバック: 前後を [a-p] で囲まれていない 32 文字 [a-p] 列。
  const generic = url.match(/(?<![a-p])([a-p]{32})(?![a-p])/);
  return generic ? generic[1] : null;
}

/** developer console の「新しいアイテムを追加 / Add new item」ボタンを押す。押せたら true。 */
async function clickAddNewItemButton(page: Page): Promise<boolean> {
  const candidates = [
    page
      .getByRole("button", {
        name: /new item|add new item|add item|새 항목|항목 추가|新しいアイテム|アイテムを追加|新しい項目/i,
      })
      .first(),
    page.getByRole("link", { name: /new item|add new item|새 항목|新しいアイテム/i }).first(),
    page.locator("button:has-text('New item')").first(),
    page.locator("button:has-text('新しいアイテム')").first(),
    page.locator("button:has-text('アイテムを追加')").first(),
  ];
  for (const btn of candidates) {
    if ((await btn.count()) > 0) {
      await btn.click();
      return true;
    }
  }
  return false;
}

/**
 * v2 fetchStatus の JSON から人間向けの短いサマリを作る。
 * V2 のフィールド名に幅があるため防御的に拾い、拒否理由・違反・警告も再帰収集する。
 * 解釈不能なら null。
 */
function summarizeStatus(raw: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v) return v;
      if (typeof v === "number") return String(v);
    }
    return undefined;
  };

  const lines: string[] = [];
  const state = pick("status", "state", "reviewStatus", "itemStatus");
  if (state) lines.push(`State: ${state}`);
  const version = pick("crxVersion", "version", "publishedVersion");
  if (version) lines.push(`Version: ${version}`);
  const deploy = pick("deployPercentage", "publishedDeployPercentage");
  if (deploy !== undefined) lines.push(`Deploy: ${deploy}%`);

  // 拒否理由・違反・警告・詳細メッセージを再帰的に集める。
  const reasons: string[] = [];
  const collect = (node: unknown, depth: number): void => {
    if (depth > 6 || node == null) return;
    if (Array.isArray(node)) {
      for (const x of node) collect(x, depth + 1);
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const lk = k.toLowerCase();
        const looksLikeIssue =
          lk.includes("reason") ||
          lk.includes("violation") ||
          lk.includes("rejection") ||
          lk.includes("warning") ||
          lk.includes("detail") ||
          lk.includes("message");
        if (looksLikeIssue && typeof v === "string" && v.trim()) {
          reasons.push(`${k}: ${v.trim()}`);
        } else if (looksLikeIssue && Array.isArray(v)) {
          for (const item of v) {
            if (typeof item === "string" && item.trim()) reasons.push(`${k}: ${item.trim()}`);
            else collect(item, depth + 1);
          }
        } else {
          collect(v, depth + 1);
        }
      }
    }
  };
  collect(obj, 0);

  const uniqReasons = [...new Set(reasons)];
  if (uniqReasons.length > 0) {
    lines.push("Issues:");
    for (const r of uniqReasons.slice(0, 20)) lines.push(`  - ${r}`);
  }

  if (lines.length === 0) return null;
  return ["── Summary ──", ...lines].join("\n");
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
  submit: {
    zipPath: z.string().describe("Absolute path to the ZIP file to upload and submit"),
    itemId: itemIdSchema,
    publisherId: publisherIdSchema,
    publishType: z
      .enum(["DEFAULT_PUBLISH", "STAGED_PUBLISH"])
      .optional()
      .describe(
        "DEFAULT_PUBLISH (default): publish immediately after approval. STAGED_PUBLISH: stage for manual publishing.",
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
      .describe("If true, block the publish when the submission has warnings. Defaults to false."),
    preflight: z
      .boolean()
      .optional()
      .describe("Verify the item exists before uploading (default: true). Set false to skip the pre-check."),
  },
  "create-item-ui": {
    zipPath: z.string().describe("Absolute path to the extension ZIP to create the new item from"),
    accountIndex: z
      .number()
      .int()
      .min(0)
      .max(9)
      .optional()
      .describe("Google account index in dashboard URL (default: 0)"),
    headless: z
      .boolean()
      .optional()
      .describe("Run browser headless (default: false; use false on the first run to sign in)"),
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
  submit:
    "One-shot submission: (optional preflight existence check) → upload the ZIP → verify the upload succeeded → publish for review → return the final status with a readable summary. Combines upload + publish + status and surfaces actionable errors at each step.",
  "create-item-ui":
    "Create a brand-new Chrome Web Store item via dashboard UI automation (Playwright) and return its new 32-char item ID. The v2 API cannot create items, so this drives the Developer Dashboard 'Add new item' → upload-ZIP flow. Use headless=false on the first run to sign in (the profile is reused afterward).",
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

      const formatted = formatResponse(result);
      if (result.ok) {
        const summary = summarizeStatus(result.body);
        if (summary) return appendNote(formatted, summary);
      }
      return formatted;
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
          await fillTextFieldByLabel(page, ["Title", "제목", "Name", "이름", "タイトル", "名前", "拡張機能の名前"], title.trim());
        }
        if (summary?.trim()) {
          await fillTextFieldByLabel(page, ["Summary", "Short description", "요약", "짧은 설명", "概要", "要約", "短い説明", "簡単な説明"], summary.trim());
        }
        if (description?.trim()) {
          await fillTextFieldByLabel(page, ["Description", "설명", "詳細な説明", "説明"], description.trim());
        }
        if (homepageUrl?.trim()) {
          await fillTextFieldByLabel(page, ["Homepage", "홈페이지", "ホームページ", "ウェブサイト", "公式サイト"], homepageUrl.trim());
        }
        if (supportUrl?.trim()) {
          await fillTextFieldByLabel(page, ["Support", "지원", "Help", "도움말", "サポート", "ヘルプ", "サポート URL", "問い合わせ"], supportUrl.trim());
        }
        if (storeIconPath?.trim()) {
          await uploadFileBySectionLabel(page, ["Store icon", "스토어 아이콘", "아이콘", "Icon", "ストア アイコン", "ストアアイコン", "アイコン"], storeIconPath.trim());
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

// ── submit (one-shot: preflight → upload → publish → status) ──
server.registerTool(
  "submit",
  { description: descriptions.submit, inputSchema: schemas.submit },
  async ({ zipPath, itemId, publisherId, publishType, deployPercentage, skipReview, blockOnWarnings, preflight }) => {
    try {
      const id = resolveItemId(itemId);
      const pub = resolvePublisherId(publisherId);
      const steps: { step: string; ok: boolean; detail?: string }[] = [];

      // ZIP を先に読む（パス不正ならここで分かりやすく失敗）。
      let zipData: Buffer;
      try {
        zipData = readFileSync(zipPath);
      } catch (e) {
        return toolError(new Error(`Cannot read ZIP at '${zipPath}': ${errMsg(e)}`));
      }

      // 1) Preflight: アイテム存在確認（アップロード前に 404 を検出する）。
      if (preflight !== false) {
        const pre = await apiCall(`${API_BASE}/v2/publishers/${pub}/items/${id}:fetchStatus`, {
          method: "GET",
        });
        const preMissing =
          !pre.ok && (pre.status === 404 || pre.body.toLowerCase().includes("could not find handler"));
        if (preMissing) {
          const hint = interpretCwsError(pre.status, pre.body);
          return {
            content: [
              {
                type: "text",
                text:
                  `Preflight failed: item '${id}' was not found (HTTP ${pre.status}).` +
                  (hint ? `\n\n${hint}` : ""),
              },
            ],
            isError: true,
          };
        }
        steps.push({ step: "preflight", ok: pre.ok, detail: pre.ok ? "item exists" : `status ${pre.status} (proceeding)` });
      }

      // 2) Upload
      const uploadRes = await apiCall(`${UPLOAD_BASE}/publishers/${pub}/items/${id}:upload`, {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: new Uint8Array(zipData),
      });
      let uploadState: string | undefined;
      let uploadItemError: unknown;
      try {
        const j = JSON.parse(uploadRes.body) as Record<string, unknown>;
        uploadState = typeof j.uploadState === "string" ? j.uploadState : undefined;
        uploadItemError = j.itemError;
      } catch {
        // non-JSON body — leave undefined
      }
      // upload は HTTP 200 でも uploadState=FAILURE / itemError で失敗していることがある。
      // 一方 IN_PROGRESS / PROCESSING など SUCCESS 以外でも失敗とは限らないので、
      // 明確な FAILURE か itemError のときだけ失敗扱いにする（誤って中断しない）。
      const uploadFailed =
        !uploadRes.ok ||
        uploadState === "FAILURE" ||
        (Array.isArray(uploadItemError) && uploadItemError.length > 0);
      steps.push({
        step: "upload",
        ok: !uploadFailed,
        detail: `HTTP ${uploadRes.status}${uploadState ? `, uploadState=${uploadState}` : ""}`,
      });
      if (uploadFailed) {
        const hint = interpretCwsError(uploadRes.status, uploadRes.body);
        return {
          content: [
            {
              type: "text",
              text:
                `Upload failed (HTTP ${uploadRes.status}${uploadState ? `, uploadState=${uploadState}` : ""}): ${uploadRes.body}` +
                (hint ? `\n\n${hint}` : ""),
            },
          ],
          isError: true,
        };
      }

      // 3) Publish
      const publishBody: Record<string, unknown> = {};
      if (publishType) publishBody.publishType = publishType;
      if (deployPercentage !== undefined) publishBody.deployInfos = [{ deployPercentage }];
      if (skipReview !== undefined) publishBody.skipReview = skipReview;
      if (blockOnWarnings !== undefined) publishBody.blockOnWarnings = blockOnWarnings;
      const hasBody = Object.keys(publishBody).length > 0;
      const publishRes = await apiCall(`${API_BASE}/v2/publishers/${pub}/items/${id}:publish`, {
        method: "POST",
        ...(hasBody
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(publishBody) }
          : {}),
      });
      steps.push({ step: "publish", ok: publishRes.ok, detail: `HTTP ${publishRes.status}` });
      if (!publishRes.ok) {
        const hint = interpretCwsError(publishRes.status, publishRes.body);
        return {
          content: [
            {
              type: "text",
              text:
                `Upload succeeded, but publish failed (HTTP ${publishRes.status}): ${publishRes.body}` +
                (hint ? `\n\n${hint}` : ""),
            },
          ],
          isError: true,
        };
      }

      // 4) Final status
      const statusRes = await apiCall(`${API_BASE}/v2/publishers/${pub}/items/${id}:fetchStatus`, {
        method: "GET",
      });
      steps.push({ step: "status", ok: statusRes.ok, detail: `HTTP ${statusRes.status}` });
      const summary = statusRes.ok ? summarizeStatus(statusRes.body) : null;

      const out = [
        `✅ Submitted '${id}' for review.`,
        "",
        "Steps:",
        ...steps.map((s) => `  ${s.ok ? "✓" : "✗"} ${s.step}${s.detail ? ` — ${s.detail}` : ""}`),
      ];
      if (summary) out.push("", summary);
      out.push("", "Publish response:", publishRes.body);
      return { content: [{ type: "text", text: out.join("\n") }], isError: false };
    } catch (e) {
      return toolError(e);
    }
  },
);

// ── create-item-ui (dashboard automation: create a brand-new item) ──
server.registerTool(
  "create-item-ui",
  { description: descriptions["create-item-ui"], inputSchema: schemas["create-item-ui"] },
  async ({ zipPath, accountIndex, headless }) => {
    try {
      const zip = resolve(zipPath);
      readFileSync(zip); // 存在確認（読めなければ throw）
      const idx = accountIndex ?? 0;
      const consoleUrl = `https://chromewebstore.google.com/u/${idx}/devconsole`;

      const context = await chromium.launchPersistentContext(DASHBOARD_PROFILE_DIR, {
        channel: "chrome",
        headless: headless ?? false,
      });

      try {
        const page = context.pages()[0] || (await context.newPage());
        await page.goto(consoleUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await page.waitForTimeout(2500);

        if (page.url().includes("accounts.google.com")) {
          throw new Error(
            `Not signed in to the Chrome Web Store developer console. Run once with headless=false and sign in. Profile dir: ${DASHBOARD_PROFILE_DIR}`,
          );
        }

        // クリックで file chooser を出す UI と、hidden <input type=file> を出す UI の
        // 両方に対応するため、両方の経路を click 前から待ち受けて先に現れた方で ZIP を渡す。
        // どちらも同じ timeout を張るので、実際に現れた経路が先に解決し、
        // 何も起きないときだけ両方 null になって明示エラーになる（無音ハングを防ぐ）。
        const fileChooserPromise = page
          .waitForEvent("filechooser", { timeout: 30_000 })
          .then((fc) => ({ kind: "chooser" as const, fc }))
          .catch(() => null);
        const fileInputPromise = page
          .locator("input[type='file']")
          .first()
          .waitFor({ state: "attached", timeout: 30_000 })
          .then(() => ({ kind: "input" as const }))
          .catch(() => null);

        const clicked = await clickAddNewItemButton(page);
        if (!clicked) {
          throw new Error(
            "Could not find an 'Add new item / New item' button on the developer console. The dashboard UI may have changed.",
          );
        }

        const target = await Promise.race([fileChooserPromise, fileInputPromise]);
        if (target?.kind === "chooser") {
          await target.fc.setFiles(zip);
        } else if (target?.kind === "input") {
          await page.locator("input[type='file']").first().setInputFiles(zip);
        } else {
          throw new Error(
            "Clicked 'Add new item' but no file chooser or file input appeared within 30s. The dashboard UI may have changed.",
          );
        }

        // アップロード完了 → 新規アイテムの編集画面へ遷移して URL に itemId が現れるのを待つ。
        let newItemId: string | null = null;
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          newItemId = extractItemIdFromUrl(page.url());
          if (newItemId) break;
          await page.waitForTimeout(2000);
        }

        if (!newItemId) {
          throw new Error(
            `Uploaded the ZIP but could not detect the new item ID from the URL (${page.url()}). ` +
              "Open the developer console to confirm the item was created and copy its ID.",
          );
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  itemId: newItemId,
                  url: page.url(),
                  next: `Set CWS_ITEM_ID=${newItemId} (or pass itemId), then 'update-metadata-ui' for the listing and 'submit' to publish.`,
                },
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

Tip: for a one-shot flow, the \`submit\` tool runs preflight → upload → publish → status in a single call. For a brand-new extension that has no item ID yet, use \`create-item-ui\` first to create the item and obtain its ID. The step-by-step flow below is the manual equivalent:

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
