import { buildContext, evaluatePreAssignment, listVariables, parseHeadersJson, renderSubscription } from "./template.js";

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

async function sha256(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64urlFromBytes(bytes);
}

async function derivePassword(password, saltB64) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: bytesFromBase64url(saltB64), iterations: 100000, hash: "SHA-256" },
    key,
    256
  );
  return base64urlFromBytes(bits);
}

async function hashPassword(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const saltB64 = base64urlFromBytes(salt);
  return { salt: saltB64, hash: await derivePassword(password, saltB64) };
}

async function verifyPassword(password, salt, expected) {
  const actual = await derivePassword(password, salt);
  return actual === expected;
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

function sanitizeUser(u) { return { id: u.id, name: u.name, email: u.email, created_at: u.created_at }; }
// Aggregate-only analytics: counts come from webhook_counters (maintained
// async by the analytics queue), never from per-event rows.
function webhookView(w, request) {
  return { id: w.id, name: w.name, token: w.token, status: w.status, created_at: w.created_at,
    events: Number(w.received ?? 0), processed: Number(w.processed ?? 0), failed: Number(w.delivered_failed ?? 0),
    delivered_ok: Number(w.delivered_ok ?? 0),
    url: `${new URL(request.url).origin}/webhooks/${w.token}` };
}

function emptySampleContext() {
  const empty = buildContext(null, null, { enriched: true, userId: 123 });
  // Representative seed so the variable picker is useful pre-traffic.
  empty.body = { event: "user.created", user: { id: 123, email: "jane@example.com" } };
  empty.headers = { "content-type": "application/json", "x-api-key": "… " };
  empty.query = { token: "…" };
  return empty;
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
    });
  }
  return out;
}

async function saveActions(env, wid, actions) {
  await env.DB.prepare("DELETE FROM actions WHERE webhook_id=?").bind(wid).run();
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    await env.DB.prepare("INSERT INTO actions (webhook_id,phase,name,code,sort_order,enabled) VALUES (?,?,?,?,?,?)")
      .bind(wid, a.phase, a.name, a.code, i, a.enabled).run();
  }
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
  } catch { /* D1 may disallow PRAGMA in some contexts — callers fall back */ }
}

async function saveSubscriptions(env, wid, subs) {
  await ensureSubscriptionColumns(env);
  await env.DB.prepare("DELETE FROM subscriptions WHERE webhook_id=?").bind(wid).run();
  const created = now();
  for (const s of subs) {
    try {
      await env.DB.prepare("INSERT INTO subscriptions (webhook_id,name,target_url,secret,enabled,http_method,headers_json,payload_mode,payload_template,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(wid, s.name, s.target_url, s.secret, s.enabled, s.http_method || "POST", s.headers_json || null, s.payload_mode || "passthrough", s.payload_template || null, created).run();
    } catch {
      await env.DB.prepare("INSERT INTO subscriptions (webhook_id,name,target_url,secret,enabled,created_at) VALUES (?,?,?,?,?,?)")
        .bind(wid, s.name, s.target_url, s.secret, s.enabled, created).run();
    }
  }
}

function subscriptionView(s) {
  let headers = {};
  try { headers = parseHeadersJson(s.headers_json ?? s.headers ?? {}); } catch { headers = {}; }
  return {
    id: s.id, name: s.name, target_url: s.target_url, enabled: s.enabled, created_at: s.created_at,
    has_secret: s.has_secret ?? (s.secret ? 1 : 0),
    http_method: s.http_method || "POST",
    headers,
    headers_json: s.headers_json ?? null,
    payload_mode: s.payload_mode || "passthrough",
    payload_template: s.payload_template ?? null,
  };
}

async function webhookRelations(env, wid) {
  const actions = await env.DB.prepare("SELECT id,phase,name,code,sort_order,enabled FROM actions WHERE webhook_id=? AND phase='pre' ORDER BY sort_order,id").bind(wid).all();
  let subscriptions;
  try {
    subscriptions = await env.DB.prepare(`SELECT id,name,target_url,enabled,created_at,http_method,headers_json,payload_mode,payload_template,
      CASE WHEN secret IS NOT NULL AND secret != '' THEN 1 ELSE 0 END AS has_secret
      FROM subscriptions WHERE webhook_id=? ORDER BY id`).bind(wid).all();
  } catch {
    subscriptions = await env.DB.prepare(`SELECT id,name,target_url,enabled,created_at,
      CASE WHEN secret IS NOT NULL AND secret != '' THEN 1 ELSE 0 END AS has_secret
      FROM subscriptions WHERE webhook_id=? ORDER BY id`).bind(wid).all();
  }
  return { actions: actions.results, subscriptions: (subscriptions.results || []).map(subscriptionView) };
}

async function mergeSubscriptions(env, wid, input) {
  // Update in place when an id matches (preserves the signing secret when
  // the client leaves it blank); insert new rows; delete removed rows.
  await ensureSubscriptionColumns(env);
  const current = await env.DB.prepare("SELECT * FROM subscriptions WHERE webhook_id=?").bind(wid).all();
  const byId = new Map(current.results.map((s) => [s.id, s]));
  const seen = new Set();
  for (const item of input) {
    const id = Number(item.id);
    if (id && byId.has(id)) {
      seen.add(id);
      const prev = byId.get(id);
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
    } else {
      try {
        await env.DB.prepare("INSERT INTO subscriptions (webhook_id,name,target_url,secret,enabled,http_method,headers_json,payload_mode,payload_template,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .bind(wid, item.name, item.target_url, item.secret || null, item.enabled,
            item.http_method || "POST", item.headers_json || null, item.payload_mode || "passthrough",
            item.payload_mode === "custom" ? (item.payload_template || null) : null, now()).run();
      } catch {
        await env.DB.prepare("INSERT INTO subscriptions (webhook_id,name,target_url,secret,enabled,created_at) VALUES (?,?,?,?,?,?)")
          .bind(wid, item.name, item.target_url, item.secret || null, item.enabled, now()).run();
      }
    }
  }
  for (const s of current.results) {
    if (!seen.has(s.id)) await env.DB.prepare("DELETE FROM subscriptions WHERE id=?").bind(s.id).run();
  }
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
  return await env.DB.prepare("SELECT id,email,name,created_at FROM users WHERE id=?").bind(uid).first();
}

// API + producer worker: serves HTTP and enqueues webhook events.
// Queue consumption lives in src/consumer.js (webhooks-consumer worker).

async function rateLimit(request, env, userId) {
  // Rate-limit binding may be unavailable on some plans — fail open.
  try {
    if (!env.USER_RATE_LIMITER) return { success: true };
    return await env.USER_RATE_LIMITER.limit({ key: String(userId) });
  } catch {
    return { success: true };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const ttlMs = sessionTtlMs(env);

    if (p === "/" && request.method === "GET") return env.ASSETS.fetch(request);
    if (p.endsWith(".js") || p.endsWith(".css") || p.endsWith(".html")) return env.ASSETS.fetch(request);

    try {
      if (request.method === "POST" && p === "/api/auth/signup") {
        const b = await readJson(request);
        const email = String(b.email || "").trim().toLowerCase();
        const name = String(b.name || "").trim();
        const password = String(b.password || "");
        if (!email || !email.includes("@") || !name || password.length < 8) return json({ error: "Name, valid email and password (8+ chars) are required" }, 400);
        const existing = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
        if (existing) return json({ error: "Account already exists" }, 409);
        const { salt, hash } = await hashPassword(password);
        const created = now();
        const result = await env.DB.prepare("INSERT INTO users (email,name,password_hash,password_salt,created_at) VALUES (?,?,?,?,?)")
          .bind(email, name, hash, salt, created).run();
        const user = await env.DB.prepare("SELECT id,email,name,created_at FROM users WHERE id=?").bind(result.meta.last_row_id).first();
        return json({ user: sanitizeUser(user) }, 201, { "set-cookie": sessionCookie(await signSession(user.id, env.APP_SECRET, ttlMs), ttlMs) });
      }

      if (request.method === "POST" && p === "/api/auth/login") {
        const b = await readJson(request);
        const email = String(b.email || "").trim().toLowerCase();
        const password = String(b.password || "");
        const user = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
        if (!user || !(await verifyPassword(password, user.password_salt, user.password_hash))) return json({ error: "Invalid email or password" }, 401);
        return json({ user: sanitizeUser(user) }, 200, { "set-cookie": sessionCookie(await signSession(user.id, env.APP_SECRET, ttlMs), ttlMs) });
      }

      if (request.method === "POST" && p === "/api/auth/logout") return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });

      if (p.startsWith("/api/")) {
        const user = await auth(request, env);
        if (!user) return json({ error: "Authentication required" }, 401);

        if (request.method === "GET" && p === "/api/me") {
          return apiJson(user, env, ttlMs, { user: sanitizeUser(user), rateLimit: { perMinute: RATE_LIMIT, period: RATE_PERIOD } });
        }

        if (request.method === "GET" && p === "/api/dashboard") {
          // Aggregate-only: totals from webhook_counters. Per-event history
          // lives in worker logs (observability), not in D1.
          const sums = await env.DB.prepare(`SELECT
            COALESCE(SUM(c.received),0) received,
            COALESCE(SUM(c.processed),0) processed,
            COALESCE(SUM(c.delivered_ok),0) delivered_ok,
            COALESCE(SUM(c.delivered_failed),0) delivered_failed
            FROM webhooks w LEFT JOIN webhook_counters c ON c.webhook_id=w.id WHERE w.user_id=?`).bind(user.id).first().catch(() => null);
          const hooks = await env.DB.prepare(`SELECT w.*,
            COALESCE(c.received,0) received, COALESCE(c.processed,0) processed,
            COALESCE(c.delivered_ok,0) delivered_ok, COALESCE(c.delivered_failed,0) delivered_failed
            FROM webhooks w LEFT JOIN webhook_counters c ON c.webhook_id=w.id WHERE w.user_id=? GROUP BY w.id ORDER BY w.id DESC`).bind(user.id).all();
          const received = Number(sums?.received || 0), processed = Number(sums?.processed || 0);
          const failed = Number(sums?.delivered_failed || 0);
          return apiJson(user, env, ttlMs, { stats: { total: received, processed, failed, pending: Math.max(0, received - processed), delivered_ok: Number(sums?.delivered_ok || 0) },
            webhooks: hooks.results.map(w => webhookView(w, request)) });
        }

        if (request.method === "GET" && p === "/api/webhooks") {
          const rows = await env.DB.prepare(`SELECT w.*,
            COALESCE(c.received,0) received, COALESCE(c.processed,0) processed,
            COALESCE(c.delivered_ok,0) delivered_ok, COALESCE(c.delivered_failed,0) delivered_failed
            FROM webhooks w LEFT JOIN webhook_counters c ON c.webhook_id=w.id WHERE w.user_id=? GROUP BY w.id ORDER BY w.id DESC`).bind(user.id).all();
          return apiJson(user, env, ttlMs, { webhooks: rows.results.map(w => webhookView(w, request)) });
        }

        if (request.method === "POST" && p === "/api/webhooks") {
          const b = await readJson(request);
          const name = String(b.name || "Untitled webhook").trim() || "Untitled webhook";
          const token = randomToken();
          const created = now();
          const hook = await env.DB.prepare("INSERT INTO webhooks (user_id,name,token,created_at) VALUES (?,?,?,?)")
            .bind(user.id, name, token, created).run();
          const wid = hook.meta.last_row_id;
          const actions = normalizeActions(b.actions) || [];
          await saveActions(env, wid, actions);
          const subs = normalizeSubscriptions(b.subscriptions) || [];
          await saveSubscriptions(env, wid, subs);
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
          }
          if (b.status !== undefined) {
            if (!["active", "disabled"].includes(b.status)) return apiJson(user, env, ttlMs, { error: "Status must be active or disabled" }, 400);
            await env.DB.prepare("UPDATE webhooks SET status=? WHERE id=?").bind(b.status, wid).run();
          }
          const actions = normalizeActions(b.actions);
          if (actions) await saveActions(env, wid, actions);
          const subs = normalizeSubscriptions(b.subscriptions);
          if (subs) await mergeSubscriptions(env, wid, subs);
          const w = await env.DB.prepare("SELECT * FROM webhooks WHERE id=? AND user_id=?").bind(wid, user.id).first();
          const rel = await webhookRelations(env, wid);
          return apiJson(user, env, ttlMs, { webhook: webhookView(w, request), actions: rel.actions, subscriptions: rel.subscriptions });
        }
        if (request.method === "GET" && hookIdMatch) {
          const wid = Number(hookIdMatch[1]);
          const w = await env.DB.prepare("SELECT * FROM webhooks WHERE id=? AND user_id=?").bind(wid, user.id).first();
          if (!w) return apiJson(user, env, ttlMs, { error: "Not found" }, 404);
          const stats = await env.DB.prepare(`SELECT COALESCE(received,0) received, COALESCE(processed,0) processed,
            COALESCE(delivered_ok,0) delivered_ok, COALESCE(delivered_failed,0) delivered_failed
            FROM webhook_counters WHERE webhook_id=?`).bind(wid).first().catch(() => null);
          const rel = await webhookRelations(env, wid);
          const received = Number(stats?.received || 0), processed = Number(stats?.processed || 0);
          return apiJson(user, env, ttlMs, { webhook: webhookView({ ...w, received, processed, delivered_ok: Number(stats?.delivered_ok || 0), delivered_failed: Number(stats?.delivered_failed || 0) }, request),
            stats: { total: received, processed, failed: Number(stats?.delivered_failed || 0), pending: Math.max(0, received - processed), delivered_ok: Number(stats?.delivered_ok || 0) },
            actions: rel.actions, subscriptions: rel.subscriptions, rateLimit: { perMinute: RATE_LIMIT, period: RATE_PERIOD } });
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
          const rendered = renderSubscription({ ...sub, secret: undefined }, ctx);
          return apiJson(user, env, ttlMs, { rendered, context: ctx, variables: listVariables(ctx), pre: ctx.pre, preError });
        }
      }

      const publicMatch = p.match(/^\/webhooks\/([^/]+)$/);
      if (publicMatch && ["POST", "PUT", "PATCH"].includes(request.method)) {
        const token = publicMatch[1];
        const hook = await env.DB.prepare("SELECT * FROM webhooks WHERE token=? AND status='active'").bind(token).first();
        if (!hook) return json({ error: "Webhook not found" }, 404);
        const rl = await rateLimit(request, env, hook.user_id);
        if (!rl.success) return json({ error: "Rate limit exceeded" }, 429, { "retry-after": "60" });
        const raw = await readBody(request);
        const payload = parsePayload(request, raw);
        const received = now();
        // No D1 write on ingest — the event travels in the queue message.
        // Status is observed via structured worker logs; counts accumulate
        // async through the analytics queue (ctx.waitUntil, off the hot path).
        const eventId = crypto.randomUUID();
        const eventMessage = {
          eventId,
          webhookId: hook.id,
          method: request.method,
          headers: Object.fromEntries(request.headers.entries()),
          query: Object.fromEntries(url.searchParams.entries()),
          payload,
          rawBody: raw,
          ip: request.headers.get("cf-connecting-ip") || "",
          receivedAt: received,
        };
        await env.WEBHOOK_QUEUE.send(eventMessage);
        ctx.waitUntil((async () => {
          try {
            if (env.ANALYTICS_QUEUE) {
              await env.ANALYTICS_QUEUE.send({
                webhookId: hook.id, field: "received", count: 1,
                day: received.slice(0, 10),
              });
            }
          } catch (e) {
            console.error(JSON.stringify({ level: "error", msg: "analytics enqueue failed", webhookId: hook.id, error: e?.message || String(e) }));
          }
        })());
        return json({ accepted: true, eventId, status: "queued" }, 202);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ error: error?.message || "Internal server error" }, error?.status || 500);
    }
  },
};
