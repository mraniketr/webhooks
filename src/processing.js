import { buildContext, evaluatePreAssignment } from "./template.js";

// Shared queue-worker helpers. This module owns NO queue and handles NO
// batches — it only holds the small pure/shared pieces used by exactly one
// consumer each:
//
// - src/router.js ....... events fan-out + analytics dispatch (queue owner)
// - src/delivery.js ..... delivery forwarding (queue owner)
// - src/analytics.js .... aggregate counter writer (used by the router)
//
// Keeping the handlers in their owner files (not here) is what stops the
// consumers from mixing again.

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

function analyticsMsg(webhookId, field, count = 1, at = now(), subscriptionId = null, tier = null) {
  const msg = { webhookId: Number(webhookId), field, count, day: dayOf(at) };
  if (subscriptionId != null && Number(subscriptionId)) msg.subscriptionId = Number(subscriptionId);
  if (tier) msg.tier = tier;
  return msg;
}

async function emitAnalytics(env, msg) {
  // Analytics must never break the main flow — queue send is async and the
  // analytics writer owns all D1 writes with its own retry budget.
  if (!env.ANALYTICS_QUEUE) return;
  try {
    await env.ANALYTICS_QUEUE.send(msg);
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      msg: "analytics enqueue failed",
      webhookId: msg.webhookId,
      subscriptionId: msg.subscriptionId ?? null,
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

function normalizeTier(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "pro" || s === "dedicated" ? s : "free";
}

// Exponential backoff for queue retries, total window held under 24h
// (Queues `delaySeconds` max is 24h). Uses per-message `attempts` (1 on first
// delivery) so a slow/down downstream backs off as:
// Deliveries (base 60s x 10 retries): 60s, 120s, ..., 30720s ≈ 17.05h total.
// Events (base 10s x 8 retries, cap 900s): ≈ 36m total.
// Analytics (base 30s x 8 retries, cap 3600s): ≈ 2.06h total.
// All totals stay under 86400s even with ±10% jitter. Queue `max_retries`
// in the wrangler consumer configs enforces the same budgets (10/8/8).
const ONE_DAY_SECONDS = 86400;
const DELIVERY_BASE_SECONDS = 60;
const EVENT_BASE_SECONDS = 10;
const ANALYTICS_BASE_SECONDS = 30;

function backoffDelay(attempts, baseSeconds, capSeconds = ONE_DAY_SECONDS) {
  const a = Math.max(1, Number(attempts) || 1);
  const exp = baseSeconds * 2 ** (a - 1);
  const capped = Math.min(capSeconds, Math.max(1, Math.floor(exp)));
  // ±20% jitter (min 1s) so a multi-tenant burst doesn't retry in lockstep.
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(capped * 0.2)));
  return Math.min(capSeconds, Math.max(1, capped + jitter - Math.floor(capped * 0.1)));
}

function deliveryDelay(attempts) {
  return backoffDelay(attempts, DELIVERY_BASE_SECONDS);
}

function eventDelay(attempts) {
  // Internal fan-out should stay fast: cap well under a day.
  return backoffDelay(attempts, EVENT_BASE_SECONDS, 900);
}

function analyticsDelay(attempts) {
  return backoffDelay(attempts, ANALYTICS_BASE_SECONDS, 3600);
}

export { analyticsDelay, analyticsMsg, backoffDelay, dayOf, deliveryDelay, emitAnalytics, eventDelay, hmacHex, logEventStatus, normalizeTier, now, rowFromMessage, runUserScript };
