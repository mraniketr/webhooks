import { buildContext, evaluatePreAssignment, renderSubscription } from "./template.js";

function now() {
  return new Date().toISOString();
}

function dayOf(iso) {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// Structured log line — the event/delivery status record. Surfaced via
// Workers observability / logpush; no per-event D1 row on the hot path.
function logEventStatus(fields) {
  console.log(JSON.stringify({ level: "info", ...fields }));
}

// Build a template.js-compatible row shim from a queue-carried event so
// buildContext() works unchanged without a DB fetch.
function rowFromMessage(msg, pre) {
  return {
    id: msg.eventId,
    webhook_id: msg.webhookId,
    method: msg.method || "POST",
    headers_json: JSON.stringify(msg.headers || {}),
    query_json: JSON.stringify(msg.query || {}),
    payload_json: msg.payload == null ? null : JSON.stringify(msg.payload),
    raw_body: msg.rawBody ?? null,
    ip: msg.ip || "",
    received_at: msg.receivedAt || now(),
    pre_json: pre === undefined ? null : JSON.stringify(pre ?? {}),
  };
}

function analyticsMsg(webhookId, field, count = 1, at = now()) {
  return { webhookId: Number(webhookId), field, count, day: dayOf(at) };
}

async function emitAnalytics(env, msg) {
  // Analytics must never break the main flow — queue send is async and the
  // analytics consumer owns all D1 writes with its own retry budget.
  if (!env.ANALYTICS_QUEUE) return;
  try {
    await env.ANALYTICS_QUEUE.send(msg);
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      msg: "analytics enqueue failed",
      webhookId: msg.webhookId,
      field: msg.field,
      error: error?.message || String(error),
    }));
  }
}

async function runUserScript(code, msg, webhookRow) {
  // Same contract as before: the pre-action only assigns a `pre` key-value
  // object via data-mapping statements — never executed as JS.
  const baseCtx = buildContext(rowFromMessage(msg), webhookRow, {});
  const { pre, error } = evaluatePreAssignment(code, baseCtx);
  return { pre: error ? {} : pre, error };
}

// Main queue: run the single pre-action (sets the `pre` key-value object),
// fan out one delivery task per enabled subscription carrying the full
// event + pre in the message, ack. No per-event D1 writes here — status is
// emitted as a structured log, counts go to the analytics queue.
async function processEvent(message, env, ctx) {
  const msg = message || {};
  const eventId = msg.eventId != null ? String(msg.eventId) : "";
  const webhookId = Number(msg.webhookId);
  if (!eventId || !webhookId) return;

  const webhookRow = await env.DB.prepare("SELECT id,name FROM webhooks WHERE id=?")
    .bind(webhookId).first().catch(() => null);
  const actions = await env.DB.prepare(
    "SELECT * FROM actions WHERE webhook_id=? AND enabled=1 AND phase='pre' ORDER BY sort_order, id"
  ).bind(webhookId).all().catch(() => ({ results: [] }));

  let pre = {};
  let preError = null;
  const enabled = (actions.results || []).filter((x) => x.phase === "pre" || !x.phase);
  const action = enabled[0];
  if (action && action.code && String(action.code).trim()) {
    const r = await runUserScript(action.code, msg, webhookRow);
    pre = r.pre;
    preError = r.error;
  }

  const subs = await env.DB.prepare(
    "SELECT id FROM subscriptions WHERE webhook_id=? AND enabled=1 ORDER BY id"
  ).bind(webhookId).all().catch(() => ({ results: [] }));
  const targets = subs.results || [];

  for (const sub of targets) {
    await env.DELIVERY_QUEUE.send({
      eventId,
      webhookId,
      subscriptionId: sub.id,
      method: msg.method || "POST",
      headers: msg.headers || {},
      query: msg.query || {},
      payload: msg.payload ?? null,
      rawBody: msg.rawBody ?? null,
      ip: msg.ip || "",
      receivedAt: msg.receivedAt || now(),
      pre,
    });
  }

  await emitAnalytics(env, analyticsMsg(webhookId, "processed", 1, msg.receivedAt));

  logEventStatus({
    msg: "event processed",
    status: "processed",
    eventId,
    webhookId,
    deliveriesEnqueued: targets.length,
    ...(preError ? { preError } : {}),
  });
}

// Delivery queue: forward one event to one subscription URL. Throws on
// failure so this task alone is retried — the main queue is unaffected.
// Outcome is a structured log (with http_status) + an analytics increment;
// no per-delivery D1 row.
async function processDelivery(message, env, ctx) {
  const msg = message || {};
  const eventId = msg.eventId != null ? String(msg.eventId) : "";
  const webhookId = Number(msg.webhookId);
  const subscriptionId = Number(msg.subscriptionId);
  if (!eventId || !webhookId || !subscriptionId) return;

  const sub = await env.DB.prepare("SELECT * FROM subscriptions WHERE id=?").bind(subscriptionId).first();
  if (!sub || !sub.enabled) {
    logEventStatus({
      msg: "delivery skipped", status: "skipped",
      eventId, webhookId, subscriptionId, reason: !sub ? "subscription gone" : "disabled",
    });
    return;
  }

  const webhookRow = await env.DB.prepare("SELECT id,name FROM webhooks WHERE id=?")
    .bind(webhookId).first().catch(() => null);
  const tplCtx = buildContext(
    rowFromMessage(msg, msg.pre || {}),
    webhookRow,
    msg.pre || {}
  );
  const rendered = renderSubscription(sub, tplCtx);

  if (!rendered.url) {
    const err = rendered.errors[0] || "Subscription template rendered an empty URL";
    await emitAnalytics(env, analyticsMsg(webhookId, "delivered_failed", 1, msg.receivedAt));
    logEventStatus({
      msg: "delivery failed", status: "failed",
      eventId, webhookId, subscriptionId,
      target: sub.target_url, http_status: null, error: err,
    });
    throw new Error(`${sub.name}: ${err}`);
  }

  const bodyText = rendered.bodyText;
  const attemptHint = 1;
  const headers = {
    "content-type": "application/json",
    "X-Hooklane-Event-Id": String(eventId),
    "X-Hooklane-Webhook-Id": String(webhookId),
    "X-Hooklane-Attempt": String(attemptHint),
    ...rendered.headers,
  };
  if (sub.secret) {
    headers["X-Hooklane-Signature"] = "sha256=" + (await hmacHex(sub.secret, bodyText));
  }

  let outcome;
  try {
    const res = await fetch(rendered.url, {
      method: rendered.method || "POST",
      headers,
      body: ["POST", "PUT", "PATCH"].includes(rendered.method) ? bodyText : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const preview = await res.text().catch(() => "");
    outcome = res.ok
      ? { ok: true, httpStatus: res.status, preview: preview.slice(0, 500), message: null }
      : { ok: false, httpStatus: res.status, preview: preview.slice(0, 500), message: `Target responded ${res.status}` };
  } catch (error) {
    outcome = { ok: false, httpStatus: null, preview: null, message: error?.message || String(error) };
  }

  if (outcome.ok) {
    await emitAnalytics(env, analyticsMsg(webhookId, "delivered_ok", 1, msg.receivedAt));
    logEventStatus({
      msg: "delivery ok", status: "success",
      eventId, webhookId, subscriptionId,
      target: rendered.url, http_status: outcome.httpStatus,
    });
    return;
  }
  await emitAnalytics(env, analyticsMsg(webhookId, "delivered_failed", 1, msg.receivedAt));
  logEventStatus({
    msg: "delivery failed", status: "failed",
    eventId, webhookId, subscriptionId,
    target: rendered.url, http_status: outcome.httpStatus, error: outcome.message,
  });
  throw new Error(`${sub.name}: ${outcome.message}`);
}

async function hmacHex(secret, bodyText) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(bodyText));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const ANALYTICS_FIELDS = new Set(["received", "processed", "delivered_ok", "delivered_failed"]);

// Analytics queue: the ONLY writer of aggregate counters. Batches collapse
// N messages into one UPSERT per (webhook, day), so hot-path throughput
// never translates into per-event D1 writes.
async function processAnalyticsBatch(messages, env) {
  // Accumulate {webhookId -> {day -> {field -> count}}}
  const acc = new Map();
  for (const m of messages) {
    const b = m.body || {};
    const webhookId = Number(b.webhookId);
    if (!webhookId || !ANALYTICS_FIELDS.has(b.field)) continue;
    const day = String(b.day || dayOf(now()));
    const count = Math.max(1, Math.min(10000, Number(b.count) || 1));
    if (!acc.has(webhookId)) acc.set(webhookId, new Map());
    const byDay = acc.get(webhookId);
    if (!byDay.has(day)) byDay.set(day, { received: 0, processed: 0, delivered_ok: 0, delivered_failed: 0 });
    byDay.get(day)[b.field] += count;
  }
  const ts = now();
  for (const [webhookId, byDay] of acc) {
    for (const [day, c] of byDay) {
      await env.DB.prepare(
        `INSERT INTO webhook_counters (webhook_id, received, processed, delivered_ok, delivered_failed, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(webhook_id) DO UPDATE SET
           received=received+excluded.received,
           processed=processed+excluded.processed,
           delivered_ok=delivered_ok+excluded.delivered_ok,
           delivered_failed=delivered_failed+excluded.delivered_failed,
           updated_at=excluded.updated_at`
      ).bind(webhookId, c.received, c.processed, c.delivered_ok, c.delivered_failed, ts).run();
      await env.DB.prepare(
        `INSERT INTO webhook_daily_counters (webhook_id, day, received, processed, delivered_ok, delivered_failed, updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(webhook_id, day) DO UPDATE SET
           received=received+excluded.received,
           processed=processed+excluded.processed,
           delivered_ok=delivered_ok+excluded.delivered_ok,
           delivered_failed=delivered_failed+excluded.delivered_failed,
           updated_at=excluded.updated_at`
      ).bind(webhookId, day, c.received, c.processed, c.delivered_ok, c.delivered_failed, ts).run();
    }
  }
}

async function processAnalytics(message, env, ctx) {
  await processAnalyticsBatch([{ body: message }], env);
}

export { analyticsMsg, dayOf, emitAnalytics, logEventStatus, now, processAnalytics, processAnalyticsBatch, processDelivery, processEvent, rowFromMessage, runUserScript };
