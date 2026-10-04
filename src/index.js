const WEBHOOK_BODY_LIMIT = 256 * 1024;
const RATE_LIMIT = 60;
const RATE_PERIOD = 60;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

async function signSession(userId, secret) {
  const body = base64urlFromBytes(new TextEncoder().encode(JSON.stringify({ uid: userId, exp: Date.now() + SESSION_TTL_MS })));
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

function sessionCookie(value) {
  return `sid=${encodeURIComponent(value)}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}
function clearSessionCookie() {
  return "sid=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0";
}

function sanitizeUser(u) { return { id: u.id, name: u.name, email: u.email, created_at: u.created_at }; }
function webhookView(w, request) {
  return { id: w.id, name: w.name, token: w.token, status: w.status, created_at: w.created_at,
    url: `${new URL(request.url).origin}/webhooks/${w.token}` };
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

async function rateLimit(request, env, userId) {
  // Rate-limit binding may be unavailable on some plans — fail open.
  try {
    if (!env.USER_RATE_LIMITER) return { success: true };
    return await env.USER_RATE_LIMITER.limit({ key: String(userId) });
  } catch {
    return { success: true };
  }
}

async function runUserScript(code, event, env, ctx) {
  // Free-plan compatible stub.
  // Original implementation used env.LOADER.load() (Dynamic Workers /
  // Workers for Platforms), which requires a Workers Paid plan and fails
  // deploy with error 10195 on Free. Custom user code is therefore skipped
  // here so deploy + queue processing works on Free.
  // To re-enable sandboxed actions: upgrade to Workers Paid, restore
  // `worker_loaders: [{ "binding": "LOADER" }]` in wrangler.jsonc and the
  // LOADER-based implementation.
  return { event, logs: [] };
}

async function processEvent(message, env, ctx) {
  const eventId = Number(message.eventId);
  const row = await env.DB.prepare("SELECT * FROM events WHERE id=?").bind(eventId).first();
  if (!row) return;
  const actions = await env.DB.prepare("SELECT * FROM actions WHERE webhook_id=? AND enabled=1 ORDER BY phase, sort_order, id").bind(row.webhook_id).all();
  let event = {
    id: row.id,
    webhookId: row.webhook_id,
    payload: row.payload_json ? JSON.parse(row.payload_json) : row.raw_body,
    headers: JSON.parse(row.headers_json || "{}"),
    ip: row.ip,
    receivedAt: row.received_at,
  };
  const logs = [];

  try {
    for (const a of actions.results.filter(x => x.phase === "pre")) {
      const result = await runUserScript(a.code, event, env, ctx);
      event = result.event;
      logs.push(...(result.logs || []));
    }

    await env.DB.batch([
      env.DB.prepare("UPDATE events SET payload_json=?, status='processed', error=NULL, processed_at=? WHERE id=?")
        .bind(event.payload == null ? null : JSON.stringify(event.payload), now(), eventId),
    ]);

    for (const a of actions.results.filter(x => x.phase === "post")) {
      const result = await runUserScript(a.code, event, env, ctx);
      event = result.event;
      logs.push(...(result.logs || []));
    }

    if (logs.length) {
      await env.DB.prepare("UPDATE events SET error=? WHERE id=?").bind(logs.join("\n"), eventId).run();
    }
  } catch (error) {
    await env.DB.prepare("UPDATE events SET status='failed', error=?, processed_at=? WHERE id=?")
      .bind(error?.message || String(error), now(), eventId).run();
    throw error;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

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
        return json({ user: sanitizeUser(user) }, 201, { "set-cookie": sessionCookie(await signSession(user.id, env.APP_SECRET)) });
      }

      if (request.method === "POST" && p === "/api/auth/login") {
        const b = await readJson(request);
        const email = String(b.email || "").trim().toLowerCase();
        const password = String(b.password || "");
        const user = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
        if (!user || !(await verifyPassword(password, user.password_salt, user.password_hash))) return json({ error: "Invalid email or password" }, 401);
        return json({ user: sanitizeUser(user) }, 200, { "set-cookie": sessionCookie(await signSession(user.id, env.APP_SECRET)) });
      }

      if (request.method === "POST" && p === "/api/auth/logout") return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });

      if (p.startsWith("/api/")) {
        const user = await auth(request, env);
        if (!user) return json({ error: "Authentication required" }, 401);

        if (request.method === "GET" && p === "/api/me") {
          return json({ user: sanitizeUser(user), rateLimit: { perMinute: RATE_LIMIT, period: RATE_PERIOD } });
        }

        if (request.method === "GET" && p === "/api/dashboard") {
          const stats = await env.DB.prepare(`SELECT COUNT(*) total,
            SUM(CASE WHEN e.status='processed' THEN 1 ELSE 0 END) processed,
            SUM(CASE WHEN e.status='failed' THEN 1 ELSE 0 END) failed,
            SUM(CASE WHEN e.status='accepted' THEN 1 ELSE 0 END) pending
            FROM events e JOIN webhooks w ON w.id=e.webhook_id WHERE w.user_id=?`).bind(user.id).first();
          const hooks = await env.DB.prepare(`SELECT w.*, COUNT(e.id) events,
            SUM(CASE WHEN e.status='processed' THEN 1 ELSE 0 END) processed,
            SUM(CASE WHEN e.status='failed' THEN 1 ELSE 0 END) failed
            FROM webhooks w LEFT JOIN events e ON e.webhook_id=w.id WHERE w.user_id=? GROUP BY w.id ORDER BY w.id DESC`).bind(user.id).all();
          const recent = await env.DB.prepare(`SELECT e.id,e.method,e.status,e.received_at,w.name webhook_name
            FROM events e JOIN webhooks w ON w.id=e.webhook_id WHERE w.user_id=? ORDER BY e.id DESC LIMIT 8`).bind(user.id).all();
          return json({ stats: { total: Number(stats.total || 0), processed: Number(stats.processed || 0), failed: Number(stats.failed || 0), pending: Number(stats.pending || 0) },
            webhooks: hooks.results.map(w => webhookView(w, request)), recent: recent.results });
        }

        if (request.method === "GET" && p === "/api/webhooks") {
          const rows = await env.DB.prepare(`SELECT w.*, COUNT(e.id) events,
            SUM(CASE WHEN e.status='processed' THEN 1 ELSE 0 END) processed,
            SUM(CASE WHEN e.status='failed' THEN 1 ELSE 0 END) failed
            FROM webhooks w LEFT JOIN events e ON e.webhook_id=w.id WHERE w.user_id=? GROUP BY w.id ORDER BY w.id DESC`).bind(user.id).all();
          return json({ webhooks: rows.results.map(w => webhookView(w, request)) });
        }

        if (request.method === "POST" && p === "/api/webhooks") {
          const b = await readJson(request);
          const name = String(b.name || "Untitled webhook").trim() || "Untitled webhook";
          const token = randomToken();
          const created = now();
          const hook = await env.DB.prepare("INSERT INTO webhooks (user_id,name,token,created_at) VALUES (?,?,?,?)")
            .bind(user.id, name, token, created).run();
          const wid = hook.meta.last_row_id;
          const actions = Array.isArray(b.actions) ? b.actions : [];
          for (let i = 0; i < actions.length; i++) {
            const a = actions[i];
            if (!["pre", "post"].includes(a.phase) || !a.code) continue;
            await env.DB.prepare("INSERT INTO actions (webhook_id,phase,name,code,sort_order,enabled) VALUES (?,?,?,?,?,?)")
              .bind(wid, a.phase, String(a.name || `Action ${i + 1}`), String(a.code), i, a.enabled === false ? 0 : 1).run();
          }
          const w = await env.DB.prepare("SELECT * FROM webhooks WHERE id=? AND user_id=?").bind(wid, user.id).first();
          const actionRows = await env.DB.prepare("SELECT * FROM actions WHERE webhook_id=? ORDER BY phase,sort_order,id").bind(wid).all();
          return json({ webhook: webhookView(w, request), actions: actionRows.results }, 201);
        }

        const hookIdMatch = p.match(/^\/api\/webhooks\/(\d+)$/);
        if (request.method === "GET" && hookIdMatch) {
          const wid = Number(hookIdMatch[1]);
          const w = await env.DB.prepare("SELECT * FROM webhooks WHERE id=? AND user_id=?").bind(wid, user.id).first();
          if (!w) return json({ error: "Not found" }, 404);
          const stats = await env.DB.prepare(`SELECT COUNT(*) total,
            SUM(CASE WHEN status='processed' THEN 1 ELSE 0 END) processed,
            SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
            SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) pending
            FROM events WHERE webhook_id=?`).bind(wid).first();
          const actions = await env.DB.prepare("SELECT * FROM actions WHERE webhook_id=? ORDER BY phase,sort_order,id").bind(wid).all();
          return json({ webhook: webhookView(w, request), stats, actions: actions.results, rateLimit: { perMinute: RATE_LIMIT, period: RATE_PERIOD } });
        }

        const eventsMatch = p.match(/^\/api\/webhooks\/(\d+)\/events$/);
        if (request.method === "GET" && eventsMatch) {
          const wid = Number(eventsMatch[1]);
          const owns = await env.DB.prepare("SELECT id FROM webhooks WHERE id=? AND user_id=?").bind(wid, user.id).first();
          if (!owns) return json({ error: "Not found" }, 404);
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 25)));
          const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
          const rows = await env.DB.prepare(`SELECT e.id,e.method,e.ip,e.status,e.error,e.received_at,e.processed_at,
            substr(COALESCE(e.payload_json,e.raw_body,''),1,140) payload_preview
            FROM events e WHERE e.webhook_id=? ORDER BY e.id DESC LIMIT ? OFFSET ?`).bind(wid, limit, offset).all();
          const total = await env.DB.prepare("SELECT COUNT(*) count FROM events WHERE webhook_id=?").bind(wid).first();
          return json({ events: rows.results, total: Number(total.count || 0) });
        }

        const eventMatch = p.match(/^\/api\/events\/(\d+)$/);
        if (request.method === "GET" && eventMatch) {
          const event = await env.DB.prepare(`SELECT e.*,w.name webhook_name,w.token
            FROM events e JOIN webhooks w ON w.id=e.webhook_id WHERE e.id=? AND w.user_id=?`).bind(Number(eventMatch[1]), user.id).first();
          if (!event) return json({ error: "Not found" }, 404);
          return json({ event: { ...event, headers: JSON.parse(event.headers_json || "{}"), payload: event.payload_json ? JSON.parse(event.payload_json) : event.raw_body } });
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
        const headers = Object.fromEntries(request.headers.entries());
        const ip = request.headers.get("cf-connecting-ip") || "";
        const insert = await env.DB.prepare(`INSERT INTO events
          (webhook_id,method,headers_json,payload_json,raw_body,ip,status,received_at)
          VALUES (?,?,?,?,?,?,?,?)`)
          .bind(hook.id, request.method, JSON.stringify(headers), payload == null ? null : JSON.stringify(payload), raw, ip, "accepted", received).run();
        const eventId = insert.meta.last_row_id;
        await env.WEBHOOK_QUEUE.send({ eventId: Number(eventId) });
        return json({ accepted: true, eventId: Number(eventId), status: "queued" }, 202);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ error: error?.message || "Internal server error" }, error?.status || 500);
    }
  },

  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      try {
        await processEvent(message.body, env, ctx);
        message.ack();
      } catch (error) {
        message.retry();
      }
    }
  },
};
