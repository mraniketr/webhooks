import { buildContext, evaluateFilter, evaluatePreAssignment, listVariables, parseHeadersJson, renderSubscription } from "./template.js";
import { createRepositories } from "./repositories/index.js";

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
  // Delegates to UserRepository (owns the users table via IDbAccessor).
  const { users } = createRepositories(env, null);
  await users.ensureGoogleColumn();
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
  const { actions: actionRepo, webhooks: actionWebhooks } = createRepositories(env, ctx);
  await actionRepo.saveAll(wid, actions);
  actionWebhooks.invalidateRoute(wid);
}

async function saveSubscriptions(env, ctx, wid, subs) {
  const { subscriptions, counters, webhooks } = createRepositories(env, ctx);
  await subscriptions.ensureColumns();
  await counters.ensureTables();
  // Remove counters for subscriptions about to be replaced (FK cascade may
  // be off if PRAGMA foreign_keys was never enabled on this connection).
  await counters.deleteForWebhook(wid);
  await subscriptions.replaceAll(wid, subs, { seedCounters: (sid) => counters.seed(sid, wid) });
  webhooks.invalidateRoute(wid);
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
  const { actions, counters } = createRepositories(env, null);
  const actionRows = await actions.listPreAll(wid);
  const subRows = await counters.listByWebhookWithCounters(wid);
  return { actions: actionRows, subscriptions: (subRows || []).map(subscriptionView) };
}

async function mergeSubscriptions(env, ctx, wid, input) {
  // Update in place when an id matches (preserves the signing secret when
  // the client leaves it blank); insert new rows; delete removed rows.
  // Per-subscription counters are preserved on update, seeded on insert,
  // and removed with the subscription on delete.
  const { subscriptions, counters, webhooks } = createRepositories(env, ctx);
  await subscriptions.merge(wid, input, {
    seedCounters: (sid) => counters.seed(sid, wid),
    deleteCounters: (sid) => counters.deleteForSubscription(sid),
  });
  webhooks.invalidateRoute(wid);
}

async function sampleContextForWebhook(env, wid) {
  // Per-event rows are no longer stored — always return the seeded sample.
  // (Preview/probe rendering uses this; live traffic renders per message.)
  const { webhooks } = createRepositories(env, null);
  const webhook = await webhooks.findBasicById(wid);
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
  const { users } = createRepositories(env, null);
  return users.findById(uid);
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

// ---- Tiered plans: free / pro / dedicated (plan resolution + limits) ----
// Plans live in D1 (editable via Admin API, cached ~15s). The Workers
// Rate-Limit binding can't vary per tier (limit is fixed in wrangler.jsonc),
// so tier TPS is enforced here with a best-effort fixed-window counter in
// KV (cross-isolate, KV-only — no in-memory state on serverless).
// Over-admission under races is possible; the binding above stays as the
// hard guardrail.
//
// Canonical plans: free, pro, dedicated. 'shared' is a legacy alias for
// 'pro' (DB rows / API callers from the brief rename) — normalizePlan maps it.
// NULL limit = unlimited (dedicated). All values are DB-configurable; the
// FALLBACK below only applies pre-migration / when D1 is unreachable.
// "1 TPS" is stored as tps_limit=60 per window_seconds=60 (≈1/sec sustained);
// "100 TPS" as tps_limit=6000 per window_seconds=60.
const VALID_PLANS = new Set(["free", "pro", "dedicated"]);
const LEGACY_PLAN_ALIASES = { shared: "pro" };
const FALLBACK_PLAN_LIMITS = {
  free: { tps_limit: 60, burst_limit: 120, window_seconds: 60, daily_limit: 1000, max_webhooks: 2, max_subs_per_webhook: 3, price_cents: 0, price_display: "$0", infra: "shared", description: "Shared infra · for trying things out" },
  pro: { tps_limit: 6000, burst_limit: 12000, window_seconds: 60, daily_limit: 10000, max_webhooks: 10, max_subs_per_webhook: 10, price_cents: 1900, price_display: "$19/mo", infra: "shared", description: "Shared infra · higher throughput" },
  dedicated: { tps_limit: 100000, burst_limit: 200000, window_seconds: 60, daily_limit: null, max_webhooks: null, max_subs_per_webhook: null, price_cents: 0, price_display: "Custom", infra: "dedicated", description: "Dedicated queue + database · custom limits" },
};
const DEDICATED_QUEUE_RE = /^hooklane-deliveries-ded-[a-z0-9][a-z0-9-]{0,59}$/;
// Serverless: NO in-memory Maps. Rate-limit windows live in KV only
// (via ICacheAccessor). When KV is unbound we fail open — the Workers
// Rate-Limit binding above stays the hard guardrail.

function normalizePlan(v) {
  const s = String(v || "").trim().toLowerCase();
  if (LEGACY_PLAN_ALIASES[s]) return LEGACY_PLAN_ALIASES[s];
  return VALID_PLANS.has(s) ? s : "free";
}

// (memoryRl removed — serverless uses KV cache accessor only)

// NOTE: schema auto-migrations (users.plan columns, plans table, webhook
// filter_code, subscription columns/counters) live in the repositories —
// every write path ensures its own tables. No ensure* wrappers here.

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
    daily_limit: cfg.daily_limit ?? null,
    max_webhooks: cfg.max_webhooks ?? null,
    max_subs_per_webhook: cfg.max_subs_per_webhook ?? null,
    price_cents: cfg.price_cents ?? 0,
    price_display: cfg.price_display ?? "$0",
    infra: cfg.infra || "shared",
    description: cfg.description ?? null,
    overridden: override != null,
  };
}

// Serialize a plan row for API responses (null = unlimited).
function planView(plan, cfg) {
  return { plan, ...(cfg || FALLBACK_PLAN_LIMITS[plan] || FALLBACK_PLAN_LIMITS.free) };
}

function utcDayString(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

async function kvRead(env, key) {
  // KV-only counter read via ICacheAccessor. Returns null when KV is
  // unbound (caller treats as 0 / fail-open).
  try {
    const { createAccessors } = await import("./accessors/index.js");
    const { cache } = createAccessors(env);
    return await cache.getCounter(key);
  } catch {
    return null;
  }
}

async function getUserDailyUsage(env, userId) {
  const count = await kvRead(env, `rl:daily:${userId}:${utcDayString()}`);
  return count ?? 0;
}

async function kvRlIncrement(env, key, windowSeconds) {
  // KV-only fixed-window increment via ICacheAccessor. Returns null when KV
  // is unavailable — callers fail open (the Workers binding is the hard
  // ceiling). Read-modify-write races can over-admit slightly; accepted.
  try {
    const { createAccessors } = await import("./accessors/index.js");
    const { cache } = createAccessors(env);
    return await cache.incrCounter(key, windowSeconds);
  } catch {
    return null;
  }
}

// (memoryRlIncrement removed — serverless uses KV cache accessor only)

async function tierRateLimit(env, ctx, userId, tierRow, planCfg) {
  const limits = effectiveTierLimit(planCfg, tierRow);
  const win = limits.window_seconds;
  const windowStart = Math.floor(Date.now() / 1000 / win);
  const sustainedKey = `rl:tier:${userId}:${limits.tps_limit}:${win}:${windowStart}`;
  let count = await kvRlIncrement(env, sustainedKey, win);
  if (count == null) count = 1; // KV unbound → fail open (binding above is the hard ceiling)
  if (count > limits.tps_limit) {
    return { allowed: false, limits, count, retryAfter: win, reason: "tps" };
  }
  // Burst gate: 10s sub-window capped at burst_limit scaled to 10s.
  const burstWindow = 10;
  const burstCap = Math.max(1, Math.ceil(limits.burst_limit * burstWindow / Math.max(1, win)));
  const burstStart = Math.floor(Date.now() / 1000 / burstWindow);
  const burstKey = `rl:burst:${userId}:${burstCap}:${burstWindow}:${burstStart}`;
  let bcount = await kvRlIncrement(env, burstKey, burstWindow);
  if (bcount == null) bcount = 1; // KV unbound → fail open
  if (bcount > burstCap) {
    return { allowed: false, limits, count: bcount, retryAfter: burstWindow, reason: "burst" };
  }
  // Daily gate: calendar-day (UTC) cap per user. NULL = unlimited.
  // Counted only for events that passed the TPS/burst gates, so rejected
  // bursts don't burn the daily quota.
  let dailyCount = 0;
  if (limits.daily_limit != null) {
    const day = utcDayString();
    const dailyKey = `rl:daily:${userId}:${day}`;
    let d = await kvRlIncrement(env, dailyKey, 86400);
    if (d == null) d = 1; // KV unbound → fail open
    dailyCount = d;
    if (d > limits.daily_limit) {
      const secsLeft = Math.max(1, Math.ceil((new Date(`${day}T24:00:00Z`).getTime() - Date.now()) / 1000));
      return { allowed: false, limits, count: d, dailyCount: d, retryAfter: Math.min(secsLeft, 86400), reason: "daily" };
    }
  } else {
    dailyCount = await getUserDailyUsage(env, userId).catch(() => 0);
  }
  return { allowed: true, limits, count, dailyCount, remaining: Math.max(0, limits.tps_limit - count) };
}

async function countUserWebhooks(env, userId) {
  const { webhooks } = createRepositories(env, null);
  return webhooks.countByUser(userId);
}

async function countWebhookSubscriptions(env, webhookId) {
  const { subscriptions } = createRepositories(env, null);
  return subscriptions.countByWebhook(webhookId);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const ttlMs = sessionTtlMs(env);
    // Shared repository set for this request (all D1/KV access flows through
    // IDbAccessor / ICacheAccessor — no raw env.DB / env.WEBHOOK_CACHE below).
    const repos = createRepositories(env, ctx);

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
        const { users: ssoUsers } = createRepositories(env, null);
        let user = null;
        try {
          user = await ssoUsers.findByGoogleSub(sub);
        } catch { user = null; }
        if (!user) {
          const byEmail = await ssoUsers.findByEmail(email);
          if (byEmail) {
            try {
              await ssoUsers.linkGoogleSub(byEmail.id, sub);
            } catch {
              return fail("This email is already registered with a different Google account.");
            }
            user = byEmail;
          } else {
            const created = now();
            const newId = await ssoUsers.create({ email, name, createdAt: created, googleSub: sub });
            user = await ssoUsers.findById(newId);
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
          const planCfg = await repos.plans.getAllCached().catch(() => structuredFallbackPlans());
          const limits = effectiveTierLimit(planCfg, { plan, tps_override: user.tps_override != null ? Number(user.tps_override) : null });
          return apiJson(user, env, ttlMs, { user: sanitizeUser(user), plan,
            rateLimit: { perMinute: RATE_LIMIT, period: RATE_PERIOD },
            tierRateLimit: { tps: limits.tps_limit, burst: limits.burst_limit, windowSeconds: limits.window_seconds, overridden: limits.overridden },
            limits });
        }

        // ---- Self-serve plans: list + select (no payment — dummy pricing) ----
        if (request.method === "GET" && p === "/api/plans") {
          const plan = normalizePlan(user.plan);
          const planCfg = await repos.plans.getAllCached().catch(() => structuredFallbackPlans());
          return apiJson(user, env, ttlMs, {
            currentPlan: plan,
            plans: ["free", "pro", "dedicated"].map((name) => planView(name, planCfg[name])),
          });
        }

        if ((request.method === "PUT" || request.method === "POST") && (p === "/api/plan" || p === "/api/me/plan")) {
          const b = await readJson(request);
          if (b.plan === undefined || b.plan === null || String(b.plan).trim() === "") {
            return apiJson(user, env, ttlMs, { error: "plan is required (free, pro or dedicated)" }, 400);
          }
          const raw = String(b.plan).trim().toLowerCase();
          if (!VALID_PLANS.has(raw) && !LEGACY_PLAN_ALIASES[raw]) {
              return apiJson(user, env, ttlMs, { error: "plan must be free, pro or dedicated" }, 400);
          }
          const plan = normalizePlan(raw);
          const current = normalizePlan(user.plan);
          if (plan === current) {
            const planCfg = await repos.plans.getAllCached().catch(() => structuredFallbackPlans());
            return apiJson(user, env, ttlMs, { user: sanitizeUser({ ...user, plan }), plan, limits: effectiveTierLimit(planCfg, { plan, tps_override: null }), unchanged: true });
          }
          // updatePlanOnly() ensures tier columns itself.
          if (plan === "dedicated") {
            // Dedicated is sales-provisioned (Plans page shows Contact sales).
            // Self-serve selection is disabled; admins assign it via
            // PUT /api/admin/users/:id/plan with a dedicated_queue.
            return apiJson(user, env, ttlMs, { error: "Dedicated is provisioned by our team — contact im.aniket.rai@gmail.com to move to Dedicated." }, 403);
          }
          // Downgrade guard: dropping to a plan with lower quotas must not
          // strand the user over quota — block with counts, don't auto-delete.
          const planCfg = await repos.plans.getAllCached().catch(() => structuredFallbackPlans());
          const next = effectiveTierLimit(planCfg, { plan, tps_override: null });
          if (next.max_webhooks != null) {
            const n = await countUserWebhooks(env, user.id);
            if (n > next.max_webhooks) {
              return apiJson(user, env, ttlMs, { error: `This plan allows ${next.max_webhooks} webhooks, but you have ${n}. Delete ${n - next.max_webhooks} webhook(s) first.` }, 403);
            }
          }
          if (next.max_subs_per_webhook != null) {
            const { webhooks: planWebhooks } = createRepositories(env, null);
            const rows = await planWebhooks.listIdsByUser(user.id).catch(() => []);
            for (const w of rows || []) {
              const n = await countWebhookSubscriptions(env, w.id);
              if (n > next.max_subs_per_webhook) {
                return apiJson(user, env, ttlMs, { error: `This plan allows ${next.max_subs_per_webhook} subscriptions per webhook (webhook ${w.id} has ${n}). Remove ${n - next.max_subs_per_webhook} subscription(s) first.` }, 403);
              }
            }
          }
          const { users: planUsers } = createRepositories(env, ctx);
          await planUsers.updatePlanOnly(user.id, plan);
          console.log(JSON.stringify({ level: "info", msg: "user plan self-selected", userId: user.id, plan }));
          const updated = await planUsers.findById(user.id).catch(() => null);
          return apiJson(user, env, ttlMs, { user: updated ? sanitizeUser(updated) : { id: user.id, plan }, plan,
            limits: effectiveTierLimit(planCfg, { plan, tps_override: null }) });
        }

        if (request.method === "GET" && p === "/api/webhooks") {
          // List page shows name, endpoint, subscription count and status
          // only — no delivery counters, so skip the counters join entirely.
          const { webhooks: listWebhooks } = createRepositories(env, null);
          const rows = await listWebhooks.listByUserWithCounts(user.id);
          return apiJson(user, env, ttlMs, { webhooks: rows.map(w => webhookView(w, request)) });
        }

        if (request.method === "POST" && p === "/api/webhooks") {
          const b = await readJson(request);
          // Plan quota: max webhooks per user (NULL = unlimited).
          const planCfgForCreate = await repos.plans.getAllCached().catch(() => structuredFallbackPlans());
          const createLimits = effectiveTierLimit(planCfgForCreate, { plan: normalizePlan(user.plan), tps_override: user.tps_override != null ? Number(user.tps_override) : null });
          if (createLimits.max_webhooks != null) {
            const n = await countUserWebhooks(env, user.id);
            if (n >= createLimits.max_webhooks) {
              return apiJson(user, env, ttlMs, { error: `Plan limit reached: ${createLimits.max_webhooks} webhooks on the ${normalizePlan(user.plan)} plan. Upgrade on the Plans page for more.`, plan: normalizePlan(user.plan), limit: createLimits.max_webhooks }, 403);
            }
          }
          const subsPre = normalizeSubscriptions(b.subscriptions);
          if (createLimits.max_subs_per_webhook != null && subsPre && subsPre.length > createLimits.max_subs_per_webhook) {
            return apiJson(user, env, ttlMs, { error: `Plan limit reached: ${createLimits.max_subs_per_webhook} subscriptions per webhook on the ${normalizePlan(user.plan)} plan.`, plan: normalizePlan(user.plan), limit: createLimits.max_subs_per_webhook }, 403);
          }
          const name = String(b.name || "Untitled webhook").trim() || "Untitled webhook";
          const token = randomToken();
          const created = now();
          const filterCode = normalizeFilterCode(b.filter_code ?? b.filter ?? null);
          const { webhooks: createWebhooks } = createRepositories(env, null);
          const wid = await createWebhooks.create({ userId: user.id, name, token, filterCode, createdAt: created });
          const actions = normalizeActions(b.actions) || [];
          await saveActions(env, ctx, wid, actions);
          const subs = subsPre || [];
          await saveSubscriptions(env, ctx, wid, subs);
          const w = await createWebhooks.findByIdAndUser(wid, user.id);
          const rel = await webhookRelations(env, wid);
          return apiJson(user, env, ttlMs, { webhook: webhookView(w, request), actions: rel.actions, subscriptions: rel.subscriptions }, 201);
        }

        const hookIdMatch = p.match(/^\/api\/webhooks\/(\d+)$/);
        if ((request.method === "PUT" || request.method === "PATCH") && hookIdMatch) {
          const wid = Number(hookIdMatch[1]);
          const { webhooks: editWebhooks } = createRepositories(env, ctx);
          const existing = await editWebhooks.findByIdAndUser(wid, user.id);
          if (!existing) return apiJson(user, env, ttlMs, { error: "Not found" }, 404);
          const b = await readJson(request);
          if (b.name !== undefined) {
            const name = String(b.name || "").trim();
            if (!name) return apiJson(user, env, ttlMs, { error: "Name is required" }, 400);
            await editWebhooks.updateFields(wid, { name: name.slice(0, 200) });
            editWebhooks.invalidate({ id: wid, token: existing.token });
          }
          if (b.status !== undefined) {
            if (!["active", "disabled"].includes(b.status)) return apiJson(user, env, ttlMs, { error: "Status must be active or disabled" }, 400);
            await editWebhooks.updateFields(wid, { status: b.status });
            editWebhooks.invalidate({ id: wid, token: existing.token });
          }
          if (b.filter_code !== undefined || b.filter !== undefined) {
            const fc = normalizeFilterCode(b.filter_code ?? b.filter);
            // fc === null means key present but null — treat as clear.
            const val = fc === null ? null : (fc || null);
            await editWebhooks.updateFields(wid, { filterCode: val });
            editWebhooks.invalidate({ id: wid, token: existing.token });
          }
          const actions = normalizeActions(b.actions);
          if (actions) await saveActions(env, ctx, wid, actions);
          const subs = normalizeSubscriptions(b.subscriptions);
          if (subs) {
            const planCfgForUpdate = await repos.plans.getAllCached().catch(() => structuredFallbackPlans());
            const updateLimits = effectiveTierLimit(planCfgForUpdate, { plan: normalizePlan(user.plan), tps_override: user.tps_override != null ? Number(user.tps_override) : null });
            if (updateLimits.max_subs_per_webhook != null && subs.length > updateLimits.max_subs_per_webhook) {
              return apiJson(user, env, ttlMs, { error: `Plan limit reached: ${updateLimits.max_subs_per_webhook} subscriptions per webhook on the ${normalizePlan(user.plan)} plan.`, plan: normalizePlan(user.plan), limit: updateLimits.max_subs_per_webhook }, 403);
            }
            await mergeSubscriptions(env, ctx, wid, subs);
          }
          const w = await editWebhooks.findByIdAndUser(wid, user.id);
          const rel = await webhookRelations(env, wid);
          return apiJson(user, env, ttlMs, { webhook: webhookView(w, request), actions: rel.actions, subscriptions: rel.subscriptions });
        }
        if (request.method === "GET" && hookIdMatch) {
          const wid = Number(hookIdMatch[1]);
          const { webhooks: getWebhooks } = createRepositories(env, null);
          const w = await getWebhooks.findByIdAndUser(wid, user.id);
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
          const { counters: subCounters, webhooks: subWebhooks } = createRepositories(env, null);
          const sub = await subCounters.findWithSubscription(sid);
          if (!sub) return apiJson(user, env, ttlMs, { error: "Not found" }, 404);
          const owns = await subWebhooks.findOwnerWebhook(sub.webhook_id, user.id);
          if (!owns) return apiJson(user, env, ttlMs, { error: "Not found" }, 404);
          const daily = await subCounters.findDaily(sid, 30);
          return apiJson(user, env, ttlMs, { subscription: subscriptionView(sub),
            webhook: webhookView({ ...owns, subscription_count: 0 }, request),
            daily: daily || [] });
        }

        const contextMatch = p.match(/^\/api\/webhooks\/(\d+)\/context$/);
        if (request.method === "GET" && contextMatch) {
          const wid = Number(contextMatch[1]);
          const { webhooks: ctxWebhooks } = createRepositories(env, null);
          const owns = await ctxWebhooks.findByIdAndUser(wid, user.id);
          if (!owns) return apiJson(user, env, ttlMs, { error: "Not found" }, 404);
          const { context, hasSample, eventId } = await sampleContextForWebhook(env, wid);
          return apiJson(user, env, ttlMs, { context, variables: listVariables(context), hasSample, eventId: eventId ?? null });
        }

        const previewMatch = p.match(/^\/api\/webhooks\/(\d+)\/subscriptions\/preview$/);
        if (request.method === "POST" && previewMatch) {
          const wid = Number(previewMatch[1]);
          const { webhooks: previewWebhooks, actions: previewActions } = createRepositories(env, null);
          const owns = await previewWebhooks.findByIdAndUser(wid, user.id);
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
            const action = await previewActions.findPreCode(wid);
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
          const webhookFilterCode = await previewWebhooks.findFilterCodeById(wid).then(async (stored) => {
            let code = stored;
            if (b.webhook_filter_code !== undefined || b.filter_code !== undefined) {
              const draft = normalizeFilterCode(b.webhook_filter_code ?? b.filter_code);
              if (draft !== null) code = draft || null;
            }
            return code;
          });
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
          const { webhooks: filterWebhooks, actions: filterActions } = createRepositories(env, null);
          const owns = await filterWebhooks.findByIdAndUser(wid, user.id);
          if (!owns) return apiJson(user, env, ttlMs, { error: "Not found" }, 404);
          const b = await readJson(request);
          const { context: sampleCtx } = await sampleContextForWebhook(env, wid);
          const baseCtx = { ...sampleCtx, webhook: { id: owns.id, name: owns.name || "" } };
          let ctx = baseCtx;
          try {
            const action = await filterActions.findPreCode(wid);
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
            // getAllCached() ensures the plans table itself.
            const cfg = await repos.plans.getAllCached().catch(() => structuredFallbackPlans());
            return apiJson(user, env, ttlMs, { plans: ["free", "pro", "dedicated"].map((plan) => planView(plan, cfg[plan])) });
          }

          const planMatch = p.match(/^\/api\/admin\/plans\/(free|shared|dedicated|pro)$/);
          if ((request.method === "PUT" || request.method === "PATCH") && planMatch) {
            const plan = normalizePlan(planMatch[1]);
            const b = await readJson(request);
            const tps = b.tps_limit ?? b.tps;
            const burst = b.burst_limit ?? b.burst;
            const win = b.window_seconds ?? b.windowSeconds ?? b.window;
            // Quota fields: null/"" = unlimited (dedicated). Numbers are caps.
            const daily = b.daily_limit ?? b.dailyLimit ?? b.per_day ?? b.daily;
            const maxWh = b.max_webhooks ?? b.maxWebhooks ?? b.webhooks;
            const maxSubs = b.max_subs_per_webhook ?? b.maxSubsPerWebhook ?? b.max_subs ?? b.subscriptions;
            const priceCents = b.price_cents ?? b.priceCents ?? b.price;
            const priceDisplay = b.price_display ?? b.priceDisplay;
            const infra = b.infra;
            const description = b.description;
            if (tps !== undefined && (!Number.isInteger(Number(tps)) || Number(tps) < 1 || Number(tps) > 100000)) {
              return apiJson(user, env, ttlMs, { error: "tps_limit must be an integer 1..100000" }, 400);
            }
            if (burst !== undefined && (!Number.isInteger(Number(burst)) || Number(burst) < 1 || Number(burst) > 200000)) {
              return apiJson(user, env, ttlMs, { error: "burst_limit must be an integer 1..200000" }, 400);
            }
            if (win !== undefined && (!Number.isInteger(Number(win)) || Number(win) < 1 || Number(win) > 3600)) {
              return apiJson(user, env, ttlMs, { error: "window_seconds must be an integer 1..3600" }, 400);
            }
            const quotaField = (v, name, max) => {
              if (v === undefined) return undefined;
              if (v === null || v === "") return null;
              if (!Number.isInteger(Number(v)) || Number(v) < 1 || Number(v) > max) {
                throw Object.assign(new Error(`${name} must be an integer 1..${max} or null (unlimited)`), { status: 400 });
              }
              return Math.floor(Number(v));
            };
            let qDaily, qWh, qSubs;
            try {
              qDaily = quotaField(daily, "daily_limit", 100000000);
              qWh = quotaField(maxWh, "max_webhooks", 100000);
              qSubs = quotaField(maxSubs, "max_subs_per_webhook", 100000);
            } catch (e) {
              return apiJson(user, env, ttlMs, { error: e.message }, e.status || 400);
            }
            if (priceCents !== undefined && (!Number.isInteger(Number(priceCents)) || Number(priceCents) < 0 || Number(priceCents) > 100000000)) {
              return apiJson(user, env, ttlMs, { error: "price_cents must be an integer 0..100000000 (dummy for now)" }, 400);
            }
            if (priceDisplay !== undefined && String(priceDisplay).length > 50) {
              return apiJson(user, env, ttlMs, { error: "price_display must be ≤ 50 chars" }, 400);
            }
            if (infra !== undefined && !["shared", "dedicated"].includes(String(infra).trim().toLowerCase())) {
              return apiJson(user, env, ttlMs, { error: "infra must be shared or dedicated" }, 400);
            }
            if (description !== undefined && String(description).length > 300) {
              return apiJson(user, env, ttlMs, { error: "description must be ≤ 300 chars" }, 400);
            }
            const { plans: adminPlans } = createRepositories(env, ctx);
            // findByPlan() ensures the plans table itself.
            const current = await adminPlans.findByPlan(plan)
              || FALLBACK_PLAN_LIMITS[plan];
            const next = {
              tps_limit: tps !== undefined ? Math.floor(Number(tps)) : Number(current.tps_limit),
              burst_limit: burst !== undefined ? Math.floor(Number(burst)) : Number(current.burst_limit),
              window_seconds: win !== undefined ? Math.floor(Number(win)) : Number(current.window_seconds),
              daily_limit: qDaily !== undefined ? qDaily : (current.daily_limit ?? FALLBACK_PLAN_LIMITS[plan].daily_limit ?? null),
              max_webhooks: qWh !== undefined ? qWh : (current.max_webhooks ?? FALLBACK_PLAN_LIMITS[plan].max_webhooks ?? null),
              max_subs_per_webhook: qSubs !== undefined ? qSubs : (current.max_subs_per_webhook ?? FALLBACK_PLAN_LIMITS[plan].max_subs_per_webhook ?? null),
              price_cents: priceCents !== undefined ? Math.floor(Number(priceCents)) : Number(current.price_cents ?? 0),
              price_display: priceDisplay !== undefined ? String(priceDisplay) : (current.price_display ?? FALLBACK_PLAN_LIMITS[plan].price_display),
              infra: infra !== undefined ? String(infra).trim().toLowerCase() : (current.infra || FALLBACK_PLAN_LIMITS[plan].infra),
              description: description !== undefined ? (String(description) || null) : (current.description ?? FALLBACK_PLAN_LIMITS[plan].description ?? null),
            };
            await adminPlans.update(plan, next);
            console.log(JSON.stringify({ level: "info", msg: "plan updated", plan, ...next, by: user.id }));
            return apiJson(user, env, ttlMs, { plan, ...next });
          }

          const userPlanMatch = p.match(/^\/api\/admin\/users\/(\d+)\/plan$/);
          if ((request.method === "PUT" || request.method === "PATCH") && userPlanMatch) {
            const targetId = Number(userPlanMatch[1]);
            const b = await readJson(request);
            if (b.plan === undefined) return apiJson(user, env, ttlMs, { error: "plan is required" }, 400);
            const rawPlan = String(b.plan).trim().toLowerCase();
            if (!VALID_PLANS.has(rawPlan) && !LEGACY_PLAN_ALIASES[rawPlan]) {
            return apiJson(user, env, ttlMs, { error: "plan must be free, pro or dedicated" }, 400);
            }
            const plan = normalizePlan(b.plan);
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
            const { users: adminUsers } = createRepositories(env, ctx);
            // updatePlan() ensures tier columns itself.
            const exists = await adminUsers.findById(targetId).catch(() => null);
            if (!exists) return apiJson(user, env, ttlMs, { error: "Not found" }, 404);
            await adminUsers.updatePlan(targetId, {
              plan, dedicatedQueue, tpsOverride: override != null ? Math.floor(Number(override)) : null,
            });
            console.log(JSON.stringify({ level: "info", msg: "user plan updated", userId: targetId, plan, dedicatedQueue, by: user.id }));
            const updated = await adminUsers.findById(targetId).catch(() => null);
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
        // Hot path: webhook lookup is KV-cached so repeat traffic skips D1.
        // Body read runs concurrently with the lookup so neither blocks the
        // other — whichever is slower sets the latency, not the sum.
        // All D1 access goes through repositories (IDbAccessor); no raw
        // env.DB in this handler.
        const { webhooks: ingestWebhooks, users: ingestUsers, plans: ingestPlans } = createRepositories(env, ctx);
        const hookPromise = ingestWebhooks.findByTokenCached(token);
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
          ingestUsers.findTierCached(hook.user_id).catch(() => ({ plan: "free", dedicated_queue: null, tps_override: null })),
          ingestPlans.getAllCached().catch(() => structuredFallbackPlans()),
        ]);
        const tier = normalizePlan(tierRow?.plan);
        const tierCheck = await tierRateLimit(env, ctx, hook.user_id, { ...tierRow, plan: tier }, planCfg);
        if (!tierCheck.allowed) {
          const isDaily = tierCheck.reason === "daily";
          return json({ error: isDaily ? "Daily event limit exceeded" : "Rate limit exceeded", plan: tier, reason: tierCheck.reason || "tps",
            ...(isDaily && tierCheck.limits.daily_limit != null ? { daily_limit: tierCheck.limits.daily_limit } : {}) }, 429, {
            "retry-after": String(tierCheck.retryAfter || 60),
            "x-plan": tier,
            "x-tps-limit": String(tierCheck.limits.tps_limit),
            ...(isDaily && tierCheck.limits.daily_limit != null ? { "x-daily-limit": String(tierCheck.limits.daily_limit) } : {}),
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
