import { buildContext, evaluateFilter, evaluatePreAssignment, listVariables, parseHeadersJson, renderSubscription } from "./template.js";
import { getPlanConfig, getUserTier, getWebhookByToken, invalidateAllSubscriptions, invalidatePlans, invalidateRouteConfig, invalidateSubscription, invalidateUserTier, invalidateWebhook } from "./cache.js";

// Queue messages cap at 128 KiB — keep inbound bodies well under that so the
// full event (payload + headers + query + envelope) fits in one message.
// No per-event D1 write happens on ingest; the queues carry the event.
const WEBHOOK_BODY_LIMIT = 100 * 1024;
const RATE_LIMIT = 60;
const RATE_PERIOD = 60;
const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000;
const SUBSCRIPTION_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

// Idle session timeout, configurable via env. Supports SESSION_TTL_MINUTES
// (preferred) or SESSION_TTL_MS. Defaults to 10 minutes of inactivity.
function sessionTtlMs(env) {
  const minutesRaw = env?.SESSION_TTL_MINUTES;
  if (minutesRaw !== undefined && minutesRaw !== null && String(minutesRaw).trim() !== "") {
    const minutes = Number(minutesRaw);
    if (Number.isFinite(minutes) && minutes > 0) return Math.floor(minutes * 60 * 1000);
  }
  const msRaw = env?.SESSION_TTL_MS;
  if (msRaw !== undefined && msRaw !== null && String(msRaw).trim() !== "") {
    const ms = Number(msRaw);
    if (Number.isFinite(ms) && ms > 0) return Math.floor(ms);
  }
  return DEFAULT_SESSION_TTL_MS;
}

// ---- Google SSO (OAuth 2.0 authorization code flow) ----
function googleConfigured(env) {
  return Boolean(env?.GOOGLE_CLIENT_ID && env?.GOOGLE_CLIENT_SECRET);
}
function googleRedirectUri(request) {
  return `${new URL(request.url).origin}/api/auth/google/callback`;
}
async function ensureGoogleColumn(env) {
  // Best-effort auto-migration for DBs created before google_sub existed.
  try {
    const cols = await env.DB.prepare("PRAGMA table_info(users)").all();
    const names = new Set((cols.results || []).map((c) => c.name));
    if (!names.has("google_sub")) await env.DB.prepare("ALTER TABLE users ADD COLUMN google_sub TEXT").run();
    await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub)").run();
  } catch { /* ignore — callback falls back to email-only lookup */ }
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function text(body, status = 200, headers = {}) {
  return new Response(body, { status, headers });
}

function now() { return new Date().toISOString(); }
function randomToken(bytes = 24) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlFromBytes(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function bytesFromBase64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function signSession(userId, secret, ttlMs) {
  const body = base64urlFromBytes(new TextEncoder().encode(JSON.stringify({ uid: userId, exp: Date.now() + ttlMs })));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = base64urlFromBytes(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `${body}.${sig}`;
}

async function verifySession(value, secret) {
  if (!value) return null;
  const [body, sig] = value.split(".");
  if (!body || !sig) return null;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("HMAC", key, bytesFromBase64url(sig), new TextEncoder().encode(body));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(bytesFromBase64url(body)));
    return p.exp > Date.now() ? p.uid : null;
  } catch { return null; }
}

function getCookie(request, name) {
  const cookie = request.headers.get("cookie") || "";
  const part = cookie.split(";").map(x => x.trim()).find(x => x.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : null;
}

function sessionCookie(value, ttlMs) {
  return `sid=${encodeURIComponent(value)}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}`;
}
function clearSessionCookie() {
  return "sid=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0";
}

// Sliding inactivity expiry: every authenticated API response re-issues the
// session cookie with a fresh expiry, so 10 idle minutes logs the user out.
async function refreshedSessionHeaders(user, env, ttlMs) {
  return { "set-cookie": sessionCookie(await signSession(user.id, env.APP_SECRET, ttlMs), ttlMs) };
}
async function apiJson(user, env, ttlMs, body, status = 200) {
  return json(body, status, await refreshedSessionHeaders(user, env, ttlMs));
}

function sanitizeUser(u) { return { id: u.id, name: u.name, email: u.email, created_at: u.created_at,
  plan: normalizePlan(u.plan), dedicated_queue: u.dedicated_queue ?? null,
  tps_override: u.tps_override ?? null, is_admin: Number(u.is_admin ?? 0) }; }
// Subscription-level analytics only: counts come from subscription_counters
// (maintained async by the analytics queue), never from per-event rows.
// Webhooks carry no counters of their own.
function webhookView(w, request) {
  return { id: w.id, name: w.name, token: w.token, status: w.status, created_at: w.created_at,
    filter_code: w.filter_code ?? null,
    subscription_count: Number(w.subscription_count ?? 0),
    enqueued: Number(w.enqueued ?? 0), delivered_ok: Number(w.delivered_ok ?? 0), delivered_failed: Number(w.delivered_failed ?? 0),
    url: `${new URL(request.url).origin}/webhooks/${w.token}` };
}

// Sum per-subscription counters into a webhook-level aggregate for display.
function sumSubscriptionStats(subs) {
  let enqueued = 0, ok = 0, failed = 0;
  for (const s of subs || []) {
    const st = s.stats || s;
    enqueued += Number(st.enqueued ?? 0);
    ok += Number(st.delivered_ok ?? 0);
    failed += Number(st.delivered_failed ?? 0);
  }
  return { enqueued, delivered_ok: ok, delivered_failed: failed, pending: Math.max(0, enqueued - ok - failed) };
}

function emptySampleContext() {
  const empty = buildContext(null, null, { enriched: true, userId: 123 });
  // Representative seed so the variable picker is useful pre-traffic.
  empty.body = { event: "user.created", user: { id: 123, email: "jane@example.com" } };
  empty.headers = { "content-type": "application/json", "x-api-key": "… " };
  empty.query = { token: "…" };
  return empty;
}

function normalizeFilterCode(input) {
  if (input === undefined || input === null) return null; // null = not provided
  const s = String(input);
  if (!s.trim()) return ""; // empty string = explicitly cleared (allow all)
  return s.slice(0, 20000);
}

function normalizeActions(input) {
  if (!Array.isArray(input)) return null; // null = not provided, leave unchanged
  // Single pre-action only: keep the first item with code.
  for (const item of input) {
    // Only pre-actions are supported (post phase removed).
    if (!item || !item.code || !String(item.code).trim()) continue;
    return [{
      phase: "pre",
      name: String(item.name || "Pre-action").slice(0, 100),
      code: String(item.code).slice(0, 20000),
      enabled: item.enabled === false ? 0 : 1,
    }];
  }
  return [];
}

function isValidUrlTemplate(target) {
  const t = String(target || "").trim();
  if (!t) return false;
  // Replace {{ ... }} with a placeholder token so templated URLs validate.
  // (Spaces inside {{ }} are legal — only check whitespace outside them.)
  const deTemplated = t.replace(/\{\{\s*[^}]+\s*\}\}/g, "x");
  if (!deTemplated || /\s/.test(deTemplated)) return false;
  try {
    const u = new URL(deTemplated);
    return ["http:", "https:"].includes(u.protocol);
  } catch { return false; }
}

function normalizeSubscriptions(input) {
  if (!Array.isArray(input)) return null; // null = not provided, leave unchanged
  const out = [];
  for (const item of input) {
    const target = String(item?.target_url ?? item?.url ?? "").trim();
    if (!isValidUrlTemplate(target)) continue;
    const method = String(item?.http_method || item?.method || "POST").toUpperCase();
    const payloadMode = item?.payload_mode === "custom" ? "custom" : "passthrough";
    const payloadTemplate = item?.payload_template != null ? String(item.payload_template).slice(0, 20000) : "";
    if (payloadMode === "custom" && !payloadTemplate.trim()) continue;
    let headersObj = {};
    try {
      headersObj = parseHeadersJson(item?.headers_json ?? item?.headers ?? {});
    } catch { headersObj = {}; }
    const filterRaw = item?.filter_code ?? item?.filter ?? item?.filterCode;
    out.push({
      id: Number(item?.id) || undefined,
      name: String(item?.name || target).slice(0, 100),
      target_url: target.slice(0, 2000),
      secret: item?.secret ? String(item.secret).slice(0, 500) : null,
      enabled: item?.enabled === false ? 0 : 1,
      http_method: SUBSCRIPTION_METHODS.includes(method) ? method : "POST",
      headers_json: JSON.stringify(headersObj).slice(0, 10000),
      payload_mode: payloadMode,
      payload_template: payloadMode === "custom" ? payloadTemplate : null,
      filter_code: filterRaw === undefined || filterRaw === null ? null : String(filterRaw).slice(0, 20000),
    });
  }
  return out;
}

async function saveActions(env, ctx, wid, actions) {
  await env.DB.prepare("DELETE FROM actions WHERE webhook_id=?").bind(wid).run();
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    await env.DB.prepare("INSERT INTO actions (webhook_id,phase,name,code,sort_order,enabled) VALUES (?,?,?,?,?,?)")
      .bind(wid, a.phase, a.name, a.code, i, a.enabled).run();
  }
  invalidateRouteConfig(env, ctx, wid);
}

async function ensureWebhookFilterColumn(env) {
  try {
    const cols = await env.DB.prepare("PRAGMA table_info(webhooks)").all();
    const names = new Set((cols.results || []).map((c) => c.name));
    if (!names.has("filter_code")) await env.DB.prepare("ALTER TABLE webhooks ADD COLUMN filter_code TEXT").run();
  } catch { /* ignore — callers fall back */ }
}

async function ensureSubscriptionColumns(env) {
  // Best-effort auto-migration for DBs created before the templating fields.
  try {
    const cols = await env.DB.prepare("PRAGMA table_info(subscriptions)").all();
    const names = new Set((cols.results || []).map((c) => c.name));
    if (!names.has("http_method")) await env.DB.prepare("ALTER TABLE subscriptions ADD COLUMN http_method TEXT DEFAULT 'POST'").run();
    if (!names.has("headers_json")) await env.DB.prepare("ALTER TABLE subscriptions ADD COLUMN headers_json TEXT").run();
    if (!names.has("payload_mode")) await env.DB.prepare("ALTER TABLE subscriptions ADD COLUMN payload_mode TEXT DEFAULT 'passthrough'").run();
    if (!names.has("payload_template")) await env.DB.prepare("ALTER TABLE subscriptions ADD COLUMN payload_template TEXT").run();
    if (!names.has("filter_code")) await env.DB.prepare("ALTER TABLE subscriptions ADD COLUMN filter_code TEXT").run();
  } catch { /* D1 may disallow PRAGMA in some contexts — callers fall back */ }
}

async function ensureSubscriptionCounterTables(env) {
  // Best-effort auto-migration for DBs created before subscription counters.
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS subscription_counters (
      subscription_id INTEGER PRIMARY KEY,
      webhook_id INTEGER NOT NULL,
      enqueued INTEGER NOT NULL DEFAULT 0,
      delivered_ok INTEGER NOT NULL DEFAULT 0,
      delivered_failed INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
      FOREIGN KEY(webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
    )`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS subscription_daily_counters (
      subscription_id INTEGER NOT NULL,
      day TEXT NOT NULL,
      enqueued INTEGER NOT NULL DEFAULT 0,
      delivered_ok INTEGER NOT NULL DEFAULT 0,
      delivered_failed INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (subscription_id, day),
      FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
    )`).run();
  } catch { /* ignore — readers fall back to zeros */ }
}

async function saveSubscriptions(env, ctx, wid, subs) {
  await ensureSubscriptionColumns(env);
  await ensureSubscriptionCounterTables(env);
  // Remove counters for subscriptions about to be replaced (FK cascade may
  // be off if PRAGMA foreign_keys was never enabled on this connection).
  try {
    await env.DB.prepare(`DELETE FROM subscription_counters WHERE webhook_id=?`).bind(wid).run();
    await env.DB.prepare(`DELETE FROM subscription_daily_counters WHERE subscription_id NOT IN (SELECT id FROM subscriptions)`).run();
  } catch { /* counters table may not exist on very old DBs — created above */ }
  await env.DB.prepare("DELETE FROM subscriptions WHERE webhook_id=?").bind(wid).run();
  const created = now();
  for (const s of subs) {
    let subId = 0;
    try {
      const r = await env.DB.prepare("INSERT INTO subscriptions (webhook_id,name,target_url,secret,enabled,http_method,headers_json,payload_mode,payload_template,filter_code,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(wid, s.name, s.target_url, s.secret, s.enabled, s.http_method || "POST", s.headers_json || null, s.payload_mode || "passthrough", s.payload_template || null, s.filter_code || null, created).run();
      subId = Number(r.meta.last_row_id) || 0;
    } catch {
      try {
        const r = await env.DB.prepare("INSERT INTO subscriptions (webhook_id,name,target_url,secret,enabled,http_method,headers_json,payload_mode,payload_template,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .bind(wid, s.name, s.target_url, s.secret, s.enabled, s.http_method || "POST", s.headers_json || null, s.payload_mode || "passthrough", s.payload_template || null, created).run();
        subId = Number(r.meta.last_row_id) || 0;
      } catch {
        const r = await env.DB.prepare("INSERT INTO subscriptions (webhook_id,name,target_url,secret,enabled,created_at) VALUES (?,?,?,?,?,?)")
          .bind(wid, s.name, s.target_url, s.secret, s.enabled, created).run();
        subId = Number(r.meta.last_row_id) || 0;
      }
    }
    if (subId) {
      try {
        await env.DB.prepare("INSERT OR IGNORE INTO subscription_counters (subscription_id, webhook_id, enqueued, delivered_ok, delivered_failed, updated_at) VALUES (?,?,?,?,?,?)")
          .bind(subId, wid, 0, 0, 0, now()).run();
      } catch { /* ignore */ }
    }
  }
  invalidateAllSubscriptions(env, ctx, wid);
}

function subscriptionView(s) {
  let headers = {};
  try { headers = parseHeadersJson(s.headers_json ?? s.headers ?? {}); } catch { headers = {}; }
  const enqueued = Number(s.enqueued ?? 0);
  const deliveredOk = Number(s.delivered_ok ?? 0);
  const deliveredFailed = Number(s.delivered_failed ?? 0);
  return {
    id: s.id, name: s.name, target_url: s.target_url, enabled: s.enabled, created_at: s.created_at,
    has_secret: s.has_secret ?? (s.secret ? 1 : 0),
    http_method: s.http_method || "POST",
    headers,
    headers_json: s.headers_json ?? null,
    payload_mode: s.payload_mode || "passthrough",
    payload_template: s.payload_template ?? null,
    filter_code: s.filter_code ?? null,
    stats: { enqueued, delivered_ok: deliveredOk, delivered_failed: deliveredFailed,
      pending: Math.max(0, enqueued - deliveredOk - deliveredFailed) },
    enqueued, delivered_ok: deliveredOk, delivered_failed: deliveredFailed,
  };
}

async function webhookRelations(env, wid) {
  const actions = await env.DB.prepare("SELECT id,phase,name,code,sort_order,enabled FROM actions WHERE webhook_id=? AND phase='pre' ORDER BY sort_order,id").bind(wid).all();
  await ensureSubscriptionCounterTables(env);
  await ensureSubscriptionColumns(env);
  let subscriptions;
  try {
    subscriptions = await env.DB.prepare(`SELECT s.id,s.name,s.target_url,s.enabled,s.created_at,s.http_method,s.headers_json,s.payload_mode,s.payload_template,s.filter_code,
      CASE WHEN s.secret IS NOT NULL AND s.secret != '' THEN 1 ELSE 0 END AS has_secret,
      COALESCE(c.enqueued,0) enqueued, COALESCE(c.delivered_ok,0) delivered_ok, COALESCE(c.delivered_failed,0) delivered_failed
      FROM subscriptions s LEFT JOIN subscription_counters c ON c.subscription_id=s.id
      WHERE s.webhook_id=? ORDER BY s.id`).bind(wid).all();
  } catch {
    try {
      subscriptions = await env.DB.prepare(`SELECT s.id,s.name,s.target_url,s.enabled,s.created_at,s.http_method,s.headers_json,s.payload_mode,s.payload_template,
      CASE WHEN s.secret IS NOT NULL AND s.secret != '' THEN 1 ELSE 0 END AS has_secret,
      COALESCE(c.enqueued,0) enqueued, COALESCE(c.delivered_ok,0) delivered_ok, COALESCE(c.delivered_failed,0) delivered_failed
      FROM subscriptions s LEFT JOIN subscription_counters c ON c.subscription_id=s.id
      WHERE s.webhook_id=? ORDER BY s.id`).bind(wid).all();
    } catch {
    try {
      subscriptions = await env.DB.prepare(`SELECT id,name,target_url,enabled,created_at,http_method,headers_json,payload_mode,payload_template,
        CASE WHEN secret IS NOT NULL AND secret != '' THEN 1 ELSE 0 END AS has_secret
        FROM subscriptions WHERE webhook_id=? ORDER BY id`).bind(wid).all();
    } catch {
      subscriptions = await env.DB.prepare(`SELECT id,name,target_url,enabled,created_at,
        CASE WHEN secret IS NOT NULL AND secret != '' THEN 1 ELSE 0 END AS has_secret
        FROM subscriptions WHERE webhook_id=? ORDER BY id`).bind(wid).all();
    }
    }
  }
  return { actions: actions.results, subscriptions: (subscriptions.results || []).map(subscriptionView) };
}

async function mergeSubscriptions(env, ctx, wid, input) {
  // Update in place when an id matches (preserves the signing secret when
  // the client leaves it blank); insert new rows; delete removed rows.
  // Per-subscription counters are preserved on update, seeded on insert,
  // and removed with the subscription on delete.
  await ensureSubscriptionColumns(env);
  await ensureSubscriptionCounterTables(env);
  const current = await env.DB.prepare("SELECT * FROM subscriptions WHERE webhook_id=?").bind(wid).all();
  const byId = new Map(current.results.map((s) => [s.id, s]));
  const seen = new Set();
  for (const item of input) {
    const id = Number(item.id);
    if (id && byId.has(id)) {
      seen.add(id);
      const prev = byId.get(id);
      const nextFilter = item.filter_code !== undefined && item.filter_code !== null ? item.filter_code : (prev.filter_code ?? null);
      try {
        await env.DB.prepare("UPDATE subscriptions SET name=?, target_url=?, secret=?, enabled=?, http_method=?, headers_json=?, payload_mode=?, payload_template=?, filter_code=? WHERE id=?")
          .bind(item.name, item.target_url, item.secret ? item.secret : prev.secret, item.enabled,
            item.http_method || prev.http_method || "POST",
            item.headers_json ?? prev.headers_json,
            item.payload_mode || prev.payload_mode || "passthrough",
            item.payload_mode === "custom" ? (item.payload_template || null) : null,
            nextFilter || null, id).run();
      } catch {
        try {
          await env.DB.prepare("UPDATE subscriptions SET name=?, target_url=?, secret=?, enabled=?, http_method=?, headers_json=?, payload_mode=?, payload_template=? WHERE id=?")
            .bind(item.name, item.target_url, item.secret ? item.secret : prev.secret, item.enabled,
              item.http_method || prev.http_method || "POST",
              item.headers_json ?? prev.headers_json,
              item.payload_mode || prev.payload_mode || "passthrough",
              item.payload_mode === "custom" ? (item.payload_template || null) : null, id).run();
        } catch {
          await env.DB.prepare("UPDATE subscriptions SET name=?, target_url=?, secret=?, enabled=? WHERE id=?")
            .bind(item.name, item.target_url, item.secret ? item.secret : prev.secret, item.enabled, id).run();
        }
      }
    } else {
      let newId = 0;
      try {
        const r = await env.DB.prepare("INSERT INTO subscriptions (webhook_id,name,target_url,secret,enabled,http_method,headers_json,payload_mode,payload_template,filter_code,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
          .bind(wid, item.name, item.target_url, item.secret || null, item.enabled,
            item.http_method || "POST", item.headers_json || null, item.payload_mode || "passthrough",
            item.payload_mode === "custom" ? (item.payload_template || null) : null,
            item.filter_code || null, now()).run();
        newId = Number(r.meta.last_row_id) || 0;
      } catch {
      try {
        const r = await env.DB.prepare("INSERT INTO subscriptions (webhook_id,name,target_url,secret,enabled,http_method,headers_json,payload_mode,payload_template,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .bind(wid, item.name, item.target_url, item.secret || null, item.enabled,
            item.http_method || "POST", item.headers_json || null, item.payload_mode || "passthrough",
            item.payload_mode === "custom" ? (item.payload_template || null) : null, now()).run();
        newId = Number(r.meta.last_row_id) || 0;
      } catch {
        const r = await env.DB.prepare("INSERT INTO subscriptions (webhook_id,name,target_url,secret,enabled,created_at) VALUES (?,?,?,?,?,?)")
          .bind(wid, item.name, item.target_url, item.secret || null, item.enabled, now()).run();
        newId = Number(r.meta.last_row_id) || 0;
      }
      }
      if (newId) {
        try {
          await env.DB.prepare("INSERT OR IGNORE INTO subscription_counters (subscription_id, webhook_id, enqueued, delivered_ok, delivered_failed, updated_at) VALUES (?,?,?,?,?,?)")
            .bind(newId, wid, 0, 0, 0, now()).run();
        } catch { /* ignore */ }
      }
    }
  }
  for (const s of current.results) {
    if (!seen.has(s.id)) {
      await env.DB.prepare("DELETE FROM subscriptions WHERE id=?").bind(s.id).run();
      try {
        await env.DB.prepare("DELETE FROM subscription_counters WHERE subscription_id=?").bind(s.id).run();
        await env.DB.prepare("DELETE FROM subscription_daily_counters WHERE subscription_id=?").bind(s.id).run();
      } catch { /* ignore */ }
      invalidateSubscription(env, ctx, s.id);
    }
  }
  invalidateAllSubscriptions(env, ctx, wid);
}

async function sampleContextForWebhook(env, wid) {
  // Per-event rows are no longer stored — always return the seeded sample.
  // (Preview/probe rendering uses this; live traffic renders per message.)
  const webhook = await env.DB.prepare("SELECT id,name FROM webhooks WHERE id=?").bind(wid).first().catch(() => null);
  const ctx = emptySampleContext();
  if (webhook) ctx.webhook = { id: webhook.id, name: webhook.name || "" };
  return { context: ctx, hasSample: false };
}
function parsePayload(request, raw) {
  if (!raw) return null;
  const ct = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (ct === "application/json" || ct.endsWith("+json")) {
    try { return JSON.parse(raw); } catch { return { _raw: raw }; }
  }
  return { _raw: raw };
}

async function readBody(request, limit = WEBHOOK_BODY_LIMIT) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > limit) throw Object.assign(new Error("Payload too large"), { status: 413 });
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > limit) throw Object.assign(new Error("Payload too large"), { status: 413 });
  return text;
}

async function readJson(request) {
  try { return await request.json(); }
  catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
}

async function auth(request, env) {
  const sid = getCookie(request, "sid");
  const uid = await verifySession(sid, env.APP_SECRET);
  if (!uid) return null;
  try {
    return await env.DB.prepare("SELECT id,email,name,created_at,plan,dedicated_queue,tps_override,is_admin FROM users WHERE id=?").bind(uid).first();
  } catch {
    return await env.DB.prepare("SELECT id,email,name,created_at FROM users WHERE id=?").bind(uid).first();
  }
}

// API + producer worker: serves HTTP and enqueues webhook events.
// Queue consumption lives in src/router.js (webhooks-router) and
// src/delivery.js (webhooks-delivery).

async function rateLimit(request, env, userId) {
  // Rate-limit binding may be unavailable on some plans — fail open.
  // This is only the coarse global guardrail; per-tier TPS is enforced by
  // tierRateLimit() below (runtime-configurable via the plans table).
  try {
    if (!env.USER_RATE_LIMITER) return { success: true };
    return await env.USER_RATE_LIMITER.limit({ key: String(userId) });
  } catch {
    return { success: true };
  }
}

// ---- Tiered queues: plan resolution + configurable per-tier TPS ----
// Plans live in D1 (editable via Admin API, cached ~15s). The Workers
// Rate-Limit binding can't vary per tier (limit is fixed in wrangler.jsonc),
// so tier TPS is enforced here with a best-effort fixed-window counter in
// KV (cross-isolate) with an in-memory per-isolate fallback. Over-admission
// under races is possible; the binding above stays as the hard guardrail.
const VALID_PLANS = new Set(["free", "pro", "dedicated"]);
const FALLBACK_PLAN_LIMITS = {
  free: { tps_limit: 10, burst_limit: 20, window_seconds: 60 },
  pro: { tps_limit: 100, burst_limit: 200, window_seconds: 60 },
  dedicated: { tps_limit: 1000, burst_limit: 2000, window_seconds: 60 },
};
const DEDICATED_QUEUE_RE = /^hooklane-deliveries-ded-[a-z0-9][a-z0-9-]{0,59}$/;
const MEMORY_RL_KEY = "__hooklane_tier_rl";

function normalizePlan(v) {
  const s = String(v || "").trim().toLowerCase();
  return VALID_PLANS.has(s) ? s : "free";
}

function memoryRl() {
  if (!globalThis[MEMORY_RL_KEY]) globalThis[MEMORY_RL_KEY] = new Map();
  return globalThis[MEMORY_RL_KEY];
}

async function ensureUserTierColumns(env) {
  try {
    const cols = await env.DB.prepare("PRAGMA table_info(users)").all();
    const names = new Set((cols.results || []).map((c) => c.name));
    if (!names.has("plan")) await env.DB.prepare("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'").run();
    if (!names.has("dedicated_queue")) await env.DB.prepare("ALTER TABLE users ADD COLUMN dedicated_queue TEXT").run();
    if (!names.has("tps_override")) await env.DB.prepare("ALTER TABLE users ADD COLUMN tps_override INTEGER").run();
    if (!names.has("is_admin")) await env.DB.prepare("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0").run();
  } catch { /* ignore — callers fall back to free tier */ }
}

async function ensurePlansTable(env) {
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS plans (
      plan TEXT PRIMARY KEY CHECK(plan IN ('free','pro','dedicated')),
      tps_limit INTEGER NOT NULL,
      burst_limit INTEGER NOT NULL,
      window_seconds INTEGER NOT NULL DEFAULT 60,
      updated_at TEXT NOT NULL
    )`).run();
    const ts = now();
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO plans (plan,tps_limit,burst_limit,window_seconds,updated_at) VALUES ('free',10,20,60,?)").bind(ts),
      env.DB.prepare("INSERT OR IGNORE INTO plans (plan,tps_limit,burst_limit,window_seconds,updated_at) VALUES ('pro',100,200,60,?)").bind(ts),
      env.DB.prepare("INSERT OR IGNORE INTO plans (plan,tps_limit,burst_limit,window_seconds,updated_at) VALUES ('dedicated',1000,2000,60,?)").bind(ts),
    ]);
  } catch { /* ignore — callers fall back to defaults */ }
}

async function loadPlanConfig(env) {
  await ensurePlansTable(env);
  try {
    const rows = await env.DB.prepare("SELECT plan,tps_limit,burst_limit,window_seconds FROM plans").all();
    const out = {};
    for (const r of rows.results || []) {
      const plan = normalizePlan(r.plan);
      out[plan] = {
        tps_limit: Math.max(1, Number(r.tps_limit) || FALLBACK_PLAN_LIMITS[plan].tps_limit),
        burst_limit: Math.max(1, Number(r.burst_limit) || FALLBACK_PLAN_LIMITS[plan].burst_limit),
        window_seconds: Math.min(3600, Math.max(10, Number(r.window_seconds) || 60)),
      };
    }
    return { ...structuredFallbackPlans(), ...out };
  } catch {
    return structuredFallbackPlans();
  }
}

function structuredFallbackPlans() {
  return JSON.parse(JSON.stringify(FALLBACK_PLAN_LIMITS));
}

function effectiveTierLimit(planCfg, tierRow) {
  const cfg = planCfg?.[tierRow.plan] || FALLBACK_PLAN_LIMITS[tierRow.plan] || FALLBACK_PLAN_LIMITS.free;
  const override = tierRow.tps_override != null && Number(tierRow.tps_override) > 0
    ? Math.floor(Number(tierRow.tps_override))
    : null;
  return {
    tps_limit: override || cfg.tps_limit,
    burst_limit: Math.max(override || cfg.tps_limit, cfg.burst_limit),
    window_seconds: cfg.window_seconds,
    overridden: override != null,
  };
}

async function loadUserTier(env, userId) {
  await ensureUserTierColumns(env);
  try {
    const row = await env.DB.prepare("SELECT plan,dedicated_queue,tps_override FROM users WHERE id=?").bind(userId).first();
    if (!row) return { plan: "free", dedicated_queue: null, tps_override: null };
    return {
      plan: normalizePlan(row.plan),
      dedicated_queue: row.dedicated_queue || null,
      tps_override: row.tps_override != null && Number(row.tps_override) > 0 ? Math.floor(Number(row.tps_override)) : null,
    };
  } catch {
    return { plan: "free", dedicated_queue: null, tps_override: null };
  }
}

async function kvRlIncrement(env, key, windowSeconds) {
  // Returns the new count, or null when KV is unavailable (caller falls back
  // to memory). Read-modify-write races can over-admit slightly — accepted
  // for a gateway TPS gate; the Workers binding is the hard ceiling.
  try {
    const kv = env?.WEBHOOK_CACHE;
    if (!kv || typeof kv.get !== "function" || typeof kv.put !== "function") return null;
    const raw = await kv.get(key, "text");
    const count = (raw ? parseInt(raw, 10) || 0 : 0) + 1;
    await kv.put(key, String(count), { expirationTtl: Math.max(1, Math.ceil(windowSeconds * 2)) });
    return count;
  } catch {
    return null;
  }
}

function memoryRlIncrement(key, windowSeconds) {
  const m = memoryRl();
  const nowMs = Date.now();
  const entry = m.get(key);
  if (!entry || entry.exp <= nowMs) {
    const fresh = { count: 1, exp: nowMs + windowSeconds * 1000 };
    m.set(key, fresh);
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

async function tierRateLimit(env, ctx, userId, tierRow, planCfg) {
  const limits = effectiveTierLimit(planCfg, tierRow);
  const win = limits.window_seconds;
  const windowStart = Math.floor(Date.now() / 1000 / win);
  const sustainedKey = `rl:tier:${userId}:${limits.tps_limit}:${win}:${windowStart}`;
  let count = await kvRlIncrement(env, sustainedKey, win);
  if (count == null) count = memoryRlIncrement(sustainedKey, win);
  if (count > limits.tps_limit) {
    return { allowed: false, limits, count, retryAfter: win, reason: "tps" };
  }
  // Burst gate: 10s sub-window capped at burst_limit scaled to 10s.
  const burstWindow = 10;
  const burstCap = Math.max(1, Math.ceil(limits.burst_limit * burstWindow / Math.max(1, win)));
  const burstStart = Math.floor(Date.now() / 1000 / burstWindow);
  const burstKey = `rl:burst:${userId}:${burstCap}:${burstWindow}:${burstStart}`;
  let bcount = await kvRlIncrement(env, burstKey, burstWindow);
  if (bcount == null) bcount = memoryRlIncrement(burstKey, burstWindow);
  if (bcount > burstCap) {
    return { allowed: false, limits, count: bcount, retryAfter: burstWindow, reason: "burst" };
  }
  return { allowed: true, limits, count, remaining: Math.max(0, limits.tps_limit - count) };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const ttlMs = sessionTtlMs(env);

    if (p === "/" && request.method === "GET") return env.ASSETS.fetch(request);
    if (p.endsWith(".js") || p.endsWith(".css") || p.endsWith(".html")) return env.ASSETS.fetch(request);

    try {
      if (request.method === "GET" && p === "/api/auth/config") {
        return json({ googleEnabled: googleConfigured(env) });
      }

      if (request.method === "GET" && p === "/api/auth/google/start") {
        if (!googleConfigured(env)) return text("Google SSO is not configured", 500);
        const state = randomToken(32);
        const redirectUri = googleRedirectUri(request);
        const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: "openid email profile",
          state,
          prompt: "select_account",
        }).toString();
        return new Response(null, {
          status: 302,
          headers: {
            location: authUrl,
            "set-cookie": `oauth_state=${encodeURIComponent(state)}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`,
            "cache-control": "no-store",
          },
        });
      }

      if (request.method === "GET" && p === "/api/auth/google/callback") {
        if (!googleConfigured(env)) return text("Google SSO is not configured", 500);
        const fail = (msg) => Response.redirect(`${new URL(request.url).origin}/?sso_error=${encodeURIComponent(msg)}`, 302);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const stateCookie = getCookie(request, "oauth_state");
        if (!code || !state || !stateCookie || state !== stateCookie) return fail("Invalid login state. Please try again.");
        const redirectUri = googleRedirectUri(request);
        // Exchange code for tokens.
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            code,
            grant_type: "authorization_code",
            redirect_uri: redirectUri,
          }).toString(),
        });
        if (!tokenRes.ok) return fail("Google login failed. Please try again.");
        const tokens = await tokenRes.json().catch(() => null);
        if (!tokens?.access_token) return fail("Google login failed. Please try again.");
        // Fetch profile.
        const meRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        });
        if (!meRes.ok) return fail("Could not read Google profile.");
        const profile = await meRes.json().catch(() => null);
        const sub = String(profile?.sub || "");
        const email = String(profile?.email || "").trim().toLowerCase();
        if (!sub || !email || !email.includes("@")) return fail("Google account has no verified email.");
        if (profile?.email_verified === false) return fail("Google email is not verified.");
        const name = String(profile?.name || profile?.given_name || email.split("@")[0]).slice(0, 200);
        await ensureGoogleColumn(env);
        let user = null;
        try {
          user = await env.DB.prepare("SELECT id,email,name,created_at FROM users WHERE google_sub=?").bind(sub).first();
        } catch { user = null; }
        if (!user) {
          const byEmail = await env.DB.prepare("SELECT id,email,name,created_at FROM users WHERE email=?").bind(email).first();
          if (byEmail) {
            try {
              await env.DB.prepare("UPDATE users SET google_sub=? WHERE id=?").bind(sub, byEmail.id).run();
            } catch {
              return fail("This email is already registered with a different Google account.");
            }
            user = byEmail;
          } else {
            const created = now();
            const result = await env.DB.prepare(
              "INSERT INTO users (email,name,created_at,google_sub) VALUES (?,?,?,?)"
            ).bind(email, name, created, sub).run();
            user = await env.DB.prepare("SELECT id,email,name,created_at FROM users WHERE id=?").bind(result.meta.last_row_id).first();
          }
        }
        if (!user) return fail("Could not create account.");
        const hdrs = new Headers();
        hdrs.set("location", new URL(request.url).origin + "/");
        hdrs.set("cache-control", "no-store");
        hdrs.append("set-cookie", await sessionCookie(await signSession(user.id, env.APP_SECRET, ttlMs), ttlMs));
        // Clear the one-time OAuth state cookie.
        hdrs.append("set-cookie", "oauth_state=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0");
        return new Response(null, { status: 302, headers: hdrs });
      }

      // Password auth removed — Google SSO only. Existing password users
      // re-enter via Google (same email auto-links to their account).
      if (request.method === "POST" && (p === "/api/auth/signup" || p === "/api/auth/login")) {
        return json({ error: "Password sign-in is disabled. Please continue with Google." }, 403);
      }

      if (request.method === "POST" && p === "/api/auth/logout") return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });

      if (p.startsWith("/api/")) {
        const user = await auth(request, env);
        if (!user) return json({ error: "Authentication required" }, 401);

        if (request.method === "GET" && p === "/api/me") {
          const plan = normalizePlan(user.plan);
          const planCfg = await getPlanConfig(env, ctx, () => loadPlanConfig(env)).catch(() => structuredFallbackPlans());
          const limits = effectiveTierLimit(planCfg, { plan, tps_override: user.tps_override != null ? Number(user.tps_override) : null });
          return apiJson(user, env, ttlMs, { user: sanitizeUser(user), plan,
            rateLimit: { perMinute: RATE_LIMIT, period: RATE_PERIOD },
            tierRateLimit: { tps: limits.tps_limit, burst: limits.burst_limit, windowSeconds: limits.window_seconds, overridden: limits.overridden } });
        }

        if (request.method === "GET" && p === "/api/dashboard") {
          // Subscription-level analytics only: totals are summed across the
          // user's subscription_counters. Per-event history lives in worker
          // logs (observability), not in D1.
          await ensureSubscriptionCounterTables(env);
          const sums = await env.DB.prepare(`SELECT
            COALESCE(SUM(c.enqueued),0) enqueued,
            COALESCE(SUM(c.delivered_ok),0) delivered_ok,
            COALESCE(SUM(c.delivered_failed),0) delivered_failed
            FROM subscriptions s JOIN webhooks w ON w.id=s.webhook_id
            LEFT JOIN subscription_counters c ON c.subscription_id=s.id
            WHERE w.user_id=?`).bind(user.id).first().catch(() => null);
          const hooks = await env.DB.prepare(`SELECT w.*,
            COUNT(DISTINCT s.id) subscription_count,
            COALESCE(SUM(c.enqueued),0) enqueued,
            COALESCE(SUM(c.delivered_ok),0) delivered_ok,
            COALESCE(SUM(c.delivered_failed),0) delivered_failed
            FROM webhooks w LEFT JOIN subscriptions s ON s.webhook_id=w.id
            LEFT JOIN subscription_counters c ON c.subscription_id=s.id
            WHERE w.user_id=? GROUP BY w.id ORDER BY w.id DESC`).bind(user.id).all();
          const enqueued = Number(sums?.enqueued || 0), ok = Number(sums?.delivered_ok || 0), failed = Number(sums?.delivered_failed || 0);
          return apiJson(user, env, ttlMs, { stats: { enqueued, delivered_ok: ok, delivered_failed: failed, pending: Math.max(0, enqueued - ok - failed) },
            webhooks: hooks.results.map(w => webhookView(w, request)) });
        }

        if (request.method === "GET" && p === "/api/webhooks") {
          await ensureSubscriptionCounterTables(env);
          const rows = await env.DB.prepare(`SELECT w.*,
            COUNT(DISTINCT s.id) subscription_count,
            COALESCE(SUM(c.enqueued),0) enqueued,
            COALESCE(SUM(c.delivered_ok),0) delivered_ok,
            COALESCE(SUM(c.delivered_failed),0) delivered_failed
            FROM webhooks w LEFT JOIN subscriptions s ON s.webhook_id=w.id
            LEFT JOIN subscription_counters c ON c.subscription_id=s.id
            WHERE w.user_id=? GROUP BY w.id ORDER BY w.id DESC`).bind(user.id).all();
          return apiJson(user, env, ttlMs, { webhooks: rows.results.map(w => webhookView(w, request)) });
        }

        if (request.method === "POST" && p === "/api/webhooks") {
          const b = await readJson(request);
          const name = String(b.name || "Untitled webhook").trim() || "Untitled webhook";
          const token = randomToken();
          const created = now();
          await ensureWebhookFilterColumn(env);
          const filterCode = normalizeFilterCode(b.filter_code ?? b.filter ?? null);
          let hook;
          try {
            hook = await env.DB.prepare("INSERT INTO webhooks (user_id,name,token,filter_code,created_at) VALUES (?,?,?,?,?)")
              .bind(user.id, name, token, filterCode || null, created).run();
          } catch {
            hook = await env.DB.prepare("INSERT INTO webhooks (user_id,name,token,created_at) VALUES (?,?,?,?)")
              .bind(user.id, name, token, created).run();
          }
          const wid = hook.meta.last_row_id;
          const actions = normalizeActions(b.actions) || [];
          await saveActions(env, ctx, wid, actions);
          const subs = normalizeSubscriptions(b.subscriptions) || [];
          await saveSubscriptions(env, ctx, wid, subs);
          const w = await env.DB.prepare("SELECT * FROM webhooks WHERE id=? AND user_id=?").bind(wid, user.id).first();
          const rel = await webhookRelations(env, wid);
          return apiJson(user, env, ttlMs, { webhook: webhookView(w, request), actions: rel.actions, subscriptions: rel.subscriptions }, 201);
        }

        const hookIdMatch = p.match(/^\/api\/webhooks\/(\d+)$/);
        if ((request.method === "PUT" || request.method === "PATCH") && hookIdMatch) {
          const wid = Number(hookIdMatch[1]);
          const existing = await env.DB.prepare("SELECT * FROM webhooks WHERE id=? AND user_id=?").bind(wid, user.id).first();
          if (!existing) return apiJson(user, env, ttlMs, { error: "Not found" }, 404);
          const b = await readJson(request);
          if (b.name !== undefined) {
            const name = String(b.name || "").trim();
            if (!name) return apiJson(user, env, ttlMs, { error: "Name is required" }, 400);
            await env.DB.prepare("UPDATE webhooks SET name=? WHERE id=?").bind(name.slice(0, 200), wid).run();
            invalidateWebhook(env, ctx, { id: wid, token: existing.token });
          }
          if (b.status !== undefined) {
            if (!["active", "disabled"].includes(b.status)) return apiJson(user, env, ttlMs, { error: "Status must be active or disabled" }, 400);
            await env.DB.prepare("UPDATE webhooks SET status=? WHERE id=?").bind(b.status, wid).run();
            invalidateWebhook(env, ctx, { id: wid, token: existing.token });
          }
          if (b.filter_code !== undefined || b.filter !== undefined) {
            await ensureWebhookFilterColumn(env);
            const fc = normalizeFilterCode(b.filter_code ?? b.filter);
            // fc === null means key present but null — treat as clear.
            const val = fc === null ? null : (fc || null);
            try {
              await env.DB.prepare("UPDATE webhooks SET filter_code=? WHERE id=?").bind(val, wid).run();
            } catch { /* old DB without column — ignore */ }
            invalidateWebhook(env, ctx, { id: wid, token: existing.token });
          }
          const actions = normalizeActions(b.actions);
          if (actions) await saveActions(env, ctx, wid, actions);
          const subs = normalizeSubscriptions(b.subscriptions);
          if (subs) await mergeSubscriptions(env, ctx, wid, subs);
          const w = await env.DB.prepare("SELECT * FROM webhooks WHERE id=? AND user_id=?").bind(wid, user.id).first();
          const rel = await webhookRelations(env, wid);
          return apiJson(user, env, ttlMs, { webhook: webhookView(w, request), actions: rel.actions, subscriptions: rel.subscriptions });
        }
        if (request.method === "GET" && hookIdMatch) {
          const wid = Number(hookIdMatch[1]);
          const w = await env.DB.prepare("SELECT * FROM webhooks WHERE id=? AND user_id=?").bind(wid, user.id).first();
          if (!w) return apiJson(user, env, ttlMs, { error: "Not found" }, 404);
          const rel = await webhookRelations(env, wid);
          const stats = sumSubscriptionStats(rel.subscriptions);
          return apiJson(user, env, ttlMs, { webhook: webhookView({ ...w, subscription_count: rel.subscriptions.length, ...stats }, request),
            stats,
            actions: rel.actions, subscriptions: rel.subscriptions, rateLimit: { perMinute: RATE_LIMIT, period: RATE_PERIOD } });
        }

        const subIdMatch = p.match(/^\/api\/subscriptions\/(\d+)$/);
        if (request.method === "GET" && subIdMatch) {
          // Single subscription with its own counters + per-day breakdown.
          const sid = Number(subIdMatch[1]);
          await ensureSubscriptionCounterTables(env);
          const sub = await env.DB.prepare(`SELECT s.*,
            CASE WHEN s.secret IS NOT NULL AND s.secret != '' THEN 1 ELSE 0 END AS has_secret,
            COALESCE(c.enqueued,0) enqueued, COALESCE(c.delivered_ok,0) delivered_ok, COALESCE(c.delivered_failed,0) delivered_failed
            FROM subscriptions s LEFT JOIN subscription_counters c ON c.subscription_id=s.id
            WHERE s.id=?`).bind(sid).first().catch(() => null);
          if (!sub) return apiJson(user, env, ttlMs, { error: "Not found" }, 404);
          const owns = await env.DB.prepare("SELECT id,name,token,status FROM webhooks WHERE id=? AND user_id=?").bind(sub.webhook_id, user.id).first();
          if (!owns) return apiJson(user, env, ttlMs, { error: "Not found" }, 404);
          const daily = await env.DB.prepare(`SELECT day,enqueued,delivered_ok,delivered_failed,updated_at
            FROM subscription_daily_counters WHERE subscription_id=? ORDER BY day DESC LIMIT 30`).bind(sid).all().catch(() => ({ results: [] }));
          return apiJson(user, env, ttlMs, { subscription: subscriptionView(sub),
            webhook: webhookView({ ...owns, subscription_count: 0 }, request),
            daily: daily.results || [] });
        }

        const contextMatch = p.match(/^\/api\/webhooks\/(\d+)\/context$/);
        if (request.method === "GET" && contextMatch) {
          const wid = Number(contextMatch[1]);
          const owns = await env.DB.prepare("SELECT id FROM webhooks WHERE id=? AND user_id=?").bind(wid, user.id).first();
          if (!owns) return apiJson(user, env, ttlMs, { error: "Not found" }, 404);
          const { context, hasSample, eventId } = await sampleContextForWebhook(env, wid);
          return apiJson(user, env, ttlMs, { context, variables: listVariables(context), hasSample, eventId: eventId ?? null });
        }

        const previewMatch = p.match(/^\/api\/webhooks\/(\d+)\/subscriptions\/preview$/);
        if (request.method === "POST" && previewMatch) {
          const wid = Number(previewMatch[1]);
          const owns = await env.DB.prepare("SELECT id,name FROM webhooks WHERE id=? AND user_id=?").bind(wid, user.id).first();
          if (!owns) return apiJson(user, env, ttlMs, { error: "Not found" }, 404);
          const b = await readJson(request);
          const normalized = normalizeSubscriptions([b.subscription || b]);
          if (!normalized || !normalized.length) return apiJson(user, env, ttlMs, { error: "Provide a valid target_url template" }, 400);
          const sub = normalized[0];
          // No stored events in aggregate-only mode — preview renders
          // against the seeded sample context plus the live pre-action.
          const { context: sampleCtx } = await sampleContextForWebhook(env, wid);
          const baseCtx = { ...sampleCtx, webhook: { id: owns.id, name: owns.name || "" } };
          let ctx = baseCtx;
          let preError = null;
          try {
            const action = await env.DB.prepare("SELECT code FROM actions WHERE webhook_id=? AND enabled=1 AND phase='pre' ORDER BY sort_order,id LIMIT 1").bind(wid).first();
            if (action && action.code && String(action.code).trim()) {
              const r = evaluatePreAssignment(action.code, baseCtx);
              if (r.error) {
                preError = r.error;
              } else {
                ctx = { ...baseCtx, pre: r.pre };
              }
            }
          } catch { /* fall back to ctx above */ }
          // Evaluate webhook-level filter (stored or draft override) and the
          // subscription-level filter draft against the same context.
          let webhookFilterCode = null;
          try {
            const wrow = await env.DB.prepare("SELECT filter_code FROM webhooks WHERE id=?").bind(wid).first().catch(() => null);
            webhookFilterCode = wrow?.filter_code ?? null;
          } catch { webhookFilterCode = null; }
          if (b.webhook_filter_code !== undefined || b.filter_code !== undefined) {
            const draft = normalizeFilterCode(b.webhook_filter_code ?? b.filter_code);
            if (draft !== null) webhookFilterCode = draft || null;
          }
          const webhookFilter = evaluateFilter(webhookFilterCode, ctx);
          const subscriptionFilter = evaluateFilter(sub.filter_code, ctx);
          const rendered = renderSubscription({ ...sub, secret: undefined }, ctx);
          return apiJson(user, env, ttlMs, { rendered, context: ctx, variables: listVariables(ctx), pre: ctx.pre, preError,
            webhookFilter: { allow: webhookFilter.allow, error: webhookFilter.error },
            subscriptionFilter: { allow: subscriptionFilter.allow, error: subscriptionFilter.error } });
        }

        const filterPreviewMatch = p.match(/^\/api\/webhooks\/(\d+)\/filter\/preview$/);
        if (request.method === "POST" && filterPreviewMatch) {
          const wid = Number(filterPreviewMatch[1]);
          const owns = await env.DB.prepare("SELECT id,name FROM webhooks WHERE id=? AND user_id=?").bind(wid, user.id).first();
          if (!owns) return apiJson(user, env, ttlMs, { error: "Not found" }, 404);
          const b = await readJson(request);
          const { context: sampleCtx } = await sampleContextForWebhook(env, wid);
          const baseCtx = { ...sampleCtx, webhook: { id: owns.id, name: owns.name || "" } };
          let ctx = baseCtx;
          try {
            const action = await env.DB.prepare("SELECT code FROM actions WHERE webhook_id=? AND enabled=1 AND phase='pre' ORDER BY sort_order,id LIMIT 1").bind(wid).first();
            if (action && action.code && String(action.code).trim()) {
              const r = evaluatePreAssignment(action.code, baseCtx);
              if (!r.error) ctx = { ...baseCtx, pre: r.pre };
            }
          } catch { /* ignore */ }
          const code = b.code ?? b.filter_code ?? b.filter ?? "";
          const r = evaluateFilter(code, ctx);
          return apiJson(user, env, ttlMs, { allow: r.allow, error: r.error, value: typeof r.value === "object" ? JSON.stringify(r.value) : r.value, context: ctx });
        }

        // ---- Admin: tier + TPS management (is_admin only) ----
        if (p.startsWith("/api/admin/")) {
          const isAdmin = Number(user.is_admin ?? 0) === 1 ||
            (env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).includes(String(user.email || "").toLowerCase());
          if (!isAdmin) return apiJson(user, env, ttlMs, { error: "Forbidden" }, 403);

          if (request.method === "GET" && p === "/api/admin/plans") {
            await ensurePlansTable(env);
            const cfg = await getPlanConfig(env, ctx, () => loadPlanConfig(env)).catch(() => structuredFallbackPlans());
            return apiJson(user, env, ttlMs, { plans: ["free", "pro", "dedicated"].map((plan) => ({ plan, ...cfg[plan] })) });
          }

          const planMatch = p.match(/^\/api\/admin\/plans\/(free|pro|dedicated)$/);
          if ((request.method === "PUT" || request.method === "PATCH") && planMatch) {
            const plan = planMatch[1];
            const b = await readJson(request);
            const tps = b.tps_limit ?? b.tps;
            const burst = b.burst_limit ?? b.burst;
            const win = b.window_seconds ?? b.windowSeconds ?? b.window;
            if (tps !== undefined && (!Number.isInteger(Number(tps)) || Number(tps) < 1 || Number(tps) > 100000)) {
              return apiJson(user, env, ttlMs, { error: "tps_limit must be an integer 1..100000" }, 400);
            }
            if (burst !== undefined && (!Number.isInteger(Number(burst)) || Number(burst) < 1 || Number(burst) > 200000)) {
              return apiJson(user, env, ttlMs, { error: "burst_limit must be an integer 1..200000" }, 400);
            }
            if (win !== undefined && (!Number.isInteger(Number(win)) || Number(win) < 10 || Number(win) > 3600)) {
              return apiJson(user, env, ttlMs, { error: "window_seconds must be an integer 10..3600" }, 400);
            }
            await ensurePlansTable(env);
            const current = await env.DB.prepare("SELECT tps_limit,burst_limit,window_seconds FROM plans WHERE plan=?").bind(plan).first()
              .catch(() => null) || FALLBACK_PLAN_LIMITS[plan];
            const next = {
              tps_limit: tps !== undefined ? Math.floor(Number(tps)) : Number(current.tps_limit),
              burst_limit: burst !== undefined ? Math.floor(Number(burst)) : Number(current.burst_limit),
              window_seconds: win !== undefined ? Math.floor(Number(win)) : Number(current.window_seconds),
            };
            await env.DB.prepare("UPDATE plans SET tps_limit=?, burst_limit=?, window_seconds=?, updated_at=? WHERE plan=?")
              .bind(next.tps_limit, next.burst_limit, next.window_seconds, now(), plan).run();
            invalidatePlans(env, ctx);
            console.log(JSON.stringify({ level: "info", msg: "plan TPS updated", plan, ...next, by: user.id }));
            return apiJson(user, env, ttlMs, { plan, ...next });
          }

          const userPlanMatch = p.match(/^\/api\/admin\/users\/(\d+)\/plan$/);
          if ((request.method === "PUT" || request.method === "PATCH") && userPlanMatch) {
            const targetId = Number(userPlanMatch[1]);
            const b = await readJson(request);
            if (b.plan === undefined) return apiJson(user, env, ttlMs, { error: "plan is required" }, 400);
            const plan = normalizePlan(b.plan);
            if (b.plan != null && !VALID_PLANS.has(String(b.plan).trim().toLowerCase())) {
              return apiJson(user, env, ttlMs, { error: "plan must be free, pro or dedicated" }, 400);
            }
            let dedicatedQueue = b.dedicated_queue ?? b.dedicatedQueue ?? null;
            if (dedicatedQueue != null && String(dedicatedQueue).trim() !== "") {
              dedicatedQueue = String(dedicatedQueue).trim();
              if (!DEDICATED_QUEUE_RE.test(dedicatedQueue)) {
                return apiJson(user, env, ttlMs, { error: "dedicated_queue must match hooklane-deliveries-ded-<slug>" }, 400);
              }
            } else {
              dedicatedQueue = null;
            }
            if (plan === "dedicated" && !dedicatedQueue) {
              return apiJson(user, env, ttlMs, { error: "dedicated_queue is required for the dedicated plan" }, 400);
            }
            let override = b.tps_override ?? b.tpsOverride ?? null;
            if (override === "" || override === 0) override = null;
            if (override != null && (!Number.isInteger(Number(override)) || Number(override) < 1 || Number(override) > 100000)) {
              return apiJson(user, env, ttlMs, { error: "tps_override must be an integer 1..100000 or null" }, 400);
            }
            await ensureUserTierColumns(env);
            const exists = await env.DB.prepare("SELECT id FROM users WHERE id=?").bind(targetId).first().catch(() => null);
            if (!exists) return apiJson(user, env, ttlMs, { error: "Not found" }, 404);
            await env.DB.prepare("UPDATE users SET plan=?, dedicated_queue=?, tps_override=? WHERE id=?")
              .bind(plan, dedicatedQueue, override != null ? Math.floor(Number(override)) : null, targetId).run();
            invalidateUserTier(env, ctx, targetId);
            console.log(JSON.stringify({ level: "info", msg: "user plan updated", userId: targetId, plan, dedicatedQueue, by: user.id }));
            const updated = await env.DB.prepare("SELECT id,email,name,created_at,plan,dedicated_queue,tps_override,is_admin FROM users WHERE id=?").bind(targetId).first().catch(() => null);
            return apiJson(user, env, ttlMs, { user: updated ? sanitizeUser(updated) : { id: targetId, plan } });
          }

          if (request.method === "POST" && p === "/api/admin/dedicated/provision") {
            const b = await readJson(request);
            const slug = String(b.slug || "").trim().toLowerCase();
            if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(slug)) {
              return apiJson(user, env, ttlMs, { error: "slug must be lowercase letters, numbers, hyphens" }, 400);
            }
            const queue = `hooklane-deliveries-ded-${slug}`;
            const worker = `webhooks-delivery-ded-${slug}`;
            const config = `wrangler.delivery-dedicated.${slug}.jsonc`;
            return apiJson(user, env, ttlMs, {
              slug, queue, worker, config,
              steps: [
                `npx wrangler queues create ${queue}`,
                `npm run provision:dedicated -- ${slug}`,
                `npx wrangler deploy --config ${config}`,
                `PUT /api/admin/users/<id>/plan {"plan":"dedicated","dedicated_queue":"${queue}"}`,
              ],
            });
          }

          return apiJson(user, env, ttlMs, { error: "Not found" }, 404);
        }
      }

      const publicMatch = p.match(/^\/webhooks\/([^/]+)$/);
      if (publicMatch && ["POST", "PUT", "PATCH"].includes(request.method)) {
        const token = publicMatch[1];
        // Hot path: webhook lookup is cached (memory + optional KV) so
        // repeat traffic skips D1. Body read runs concurrently with the
        // lookup so neither blocks the other — whichever is slower sets the
        // latency, not the sum.
        const hookPromise = getWebhookByToken(env, ctx, token, async () =>
          env.DB.prepare("SELECT id, user_id, name, token, status FROM webhooks WHERE token=?")
            .bind(token).first().catch(() => null)
        );
        const rawPromise = readBody(request);
        let hook;
        let raw;
        try {
          [hook, raw] = await Promise.all([hookPromise, rawPromise]);
        } catch (error) {
          // readBody throws 413 on oversize; make sure the cached lookup
          // still resolves (and reuses single-flight) before responding.
          if (error?.status === 413) throw error;
          hook = await hookPromise;
          raw = await rawPromise;
        }
        if (!hook || hook.status !== "active") return json({ error: "Webhook not found" }, 404);
        // Tier resolution (cached ~30s): drives per-plan TPS + stamps the
        // tier onto the event so fan-out routes to the right delivery queue
        // even if the plan changes mid-flight.
        const [tierRow, planCfg] = await Promise.all([
          getUserTier(env, ctx, hook.user_id, () => loadUserTier(env, hook.user_id)).catch(() => ({ plan: "free", dedicated_queue: null, tps_override: null })),
          getPlanConfig(env, ctx, () => loadPlanConfig(env)).catch(() => structuredFallbackPlans()),
        ]);
        const tier = normalizePlan(tierRow?.plan);
        const tierCheck = await tierRateLimit(env, ctx, hook.user_id, { ...tierRow, plan: tier }, planCfg);
        if (!tierCheck.allowed) {
          return json({ error: "Rate limit exceeded", plan: tier }, 429, {
            "retry-after": String(tierCheck.retryAfter || 60),
            "x-plan": tier,
            "x-tps-limit": String(tierCheck.limits.tps_limit),
          });
        }
        const rl = await rateLimit(request, env, hook.user_id);
        if (!rl.success) return json({ error: "Rate limit exceeded", plan: tier }, 429, { "retry-after": "60", "x-plan": tier });
        const payload = parsePayload(request, raw);
        const received = now();
        // No D1 write on ingest — the event travels in the queue message.
        // Delivery stats are subscription-level and accumulate async through
        // the analytics queue (off the hot path).
        const eventId = crypto.randomUUID();
        const eventMessage = {
          eventId,
          webhookId: hook.id,
          tier,
          dedicatedQueue: tier === "dedicated" ? (tierRow?.dedicated_queue || null) : null,
          method: request.method,
          headers: Object.fromEntries(request.headers.entries()),
          query: Object.fromEntries(url.searchParams.entries()),
          payload,
          rawBody: raw,
          ip: request.headers.get("cf-connecting-ip") || "",
          receivedAt: received,
        };
        const eventsQueue = env.EVENT_QUEUE || env.WEBHOOK_QUEUE;
        await eventsQueue.send(eventMessage);
        return json({ accepted: true, eventId, status: "queued", tier }, 202);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ error: error?.message || "Internal server error" }, error?.status || 500);
    }
  },
};
