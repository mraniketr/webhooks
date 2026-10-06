import { buildContext, evaluateFilter, evaluatePreAssignment, renderSubscription } from "./template.js";
import { getRouteConfig, getSubscription, getUserTier, getWebhookRow, invalidateRouteConfig } from "./cache.js";

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
  // analytics consumer owns all D1 writes with its own retry budget.
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

// ---- Tiered delivery routing ----
// Ingress stamps msg.tier at ingest; fan-out re-validates against the
// owner's current plan so upgrades take effect within the tier-cache TTL.
// Dedicated queues are per-customer: the shared consumer needs one producer
// binding per dedicated queue, named DELIVERY_DEDICATED_<SLUG> (slug
// uppercased, hyphens -> underscores), e.g. queue hooklane-deliveries-ded-acme
// binds as DELIVERY_DEDICATED_ACME. Never reroute dedicated -> shared on a
// missing binding: throw so the event retries with backoff and alerts.
function normalizeTier(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "pro" || s === "dedicated" ? s : "free";
}

function dedicatedBindingKey(queueName) {
  const slug = String(queueName || "").replace(/^hooklane-deliveries-ded-/, "");
  if (!slug) return null;
  return `DELIVERY_DEDICATED_${slug.toUpperCase().replace(/-/g, "_")}`;
}

function resolveDeliveryQueue(env, tier, dedicatedQueue) {
  if (tier === "pro") {
    return env.DELIVERY_PRO || env.DELIVERY_QUEUE || null;
  }
  if (tier === "dedicated") {
    const key = dedicatedBindingKey(dedicatedQueue);
    const bound = (key && env[key]) || env.DELIVERY_DEDICATED || null;
    if (!bound) {
      const err = new Error(`dedicated queue not bound: ${dedicatedQueue || "(unset)"}${key ? ` (expected binding ${key})` : ""}`);
      err.code = "DEDICATED_QUEUE_MISSING";
      throw err;
    }
    return bound;
  }
  return env.DELIVERY_SHARED || env.DELIVERY_QUEUE || null;
}

async function resolveEventTier(msg, env, ctx, webhookRow) {
  const stamped = normalizeTier(msg.tier);
  const stampedQueue = msg.dedicatedQueue || null;
  try {
    const userId = webhookRow?.user_id;
    if (!userId) return { tier: stamped, dedicatedQueue: stampedQueue, fresh: false };
    const tierRow = await getUserTier(env, ctx, userId, async () => {
      try {
        const row = await env.DB.prepare("SELECT plan,dedicated_queue FROM users WHERE id=?").bind(userId).first();
        if (!row) return null;
        return { plan: row.plan || "free", dedicated_queue: row.dedicated_queue || null };
      } catch {
        return null;
      }
    }).catch(() => null);
    if (!tierRow) return { tier: stamped, dedicatedQueue: stampedQueue, fresh: false };
    return {
      tier: normalizeTier(tierRow.plan),
      dedicatedQueue: tierRow.dedicated_queue || stampedQueue,
      fresh: true,
    };
  } catch {
    return { tier: stamped, dedicatedQueue: stampedQueue, fresh: false };
  }
}

// Main queue: run the single pre-action (sets the `pre` key-value object),
// fan out one delivery task per enabled subscription carrying the full
// event + pre in the message, ack. No per-event D1 writes here — status is
// emitted as a structured log, counts go to the analytics queue.
//
// Hot-path reads (webhook row + pre-action + subscription ids) are cached
// as one route-config entry, so steady traffic skips D1 entirely. The three
// D1 queries run concurrently on a miss, and fan-out sends run concurrently
// so per-subscription latency never stacks.
async function processEvent(message, env, ctx) {
  const msg = message || {};
  const eventId = msg.eventId != null ? String(msg.eventId) : "";
  const webhookId = Number(msg.webhookId);
  if (!eventId || !webhookId) return;

  let route = await getRouteConfig(env, ctx, webhookId, async () => {
    const [webhookRow, actions, subs] = await Promise.all([
      env.DB.prepare("SELECT id,name,user_id,filter_code FROM webhooks WHERE id=?").bind(webhookId).first()
        .catch(() => env.DB.prepare("SELECT id,name,filter_code FROM webhooks WHERE id=?").bind(webhookId).first()
          .catch(() => env.DB.prepare("SELECT id,name FROM webhooks WHERE id=?").bind(webhookId).first().catch(() => null))),
      env.DB.prepare(
        "SELECT * FROM actions WHERE webhook_id=? AND enabled=1 AND phase='pre' ORDER BY sort_order, id"
      ).bind(webhookId).all().catch(() => ({ results: [] })),
      env.DB.prepare(
        "SELECT id,filter_code FROM subscriptions WHERE webhook_id=? AND enabled=1 ORDER BY id"
      ).bind(webhookId).all().catch(() =>
        env.DB.prepare("SELECT id FROM subscriptions WHERE webhook_id=? AND enabled=1 ORDER BY id").bind(webhookId).all().catch(() => ({ results: [] }))),
    ]);
    const subRows = (subs?.results || []).map((s) => ({ id: Number(s.id), filter_code: s.filter_code ?? null })).filter((s) => Boolean(s.id));
    return {
      webhookRow: webhookRow || null,
      actions: actions?.results || [],
      subIds: subRows.map((s) => s.id),
      subs: subRows,
    };
  }).catch(() => null);

  // Stale-empty guard: a cached "no subscriptions" entry must never drop a
  // fan-out right after a subscription was added. Re-check D1 once and
  // refresh the cache when the fresh list is non-empty.
  if (route && (route.subIds || []).length === 0 && !(route.subs || []).length) {
    try {
      const fresh = await env.DB.prepare(
        "SELECT id FROM subscriptions WHERE webhook_id=? AND enabled=1 ORDER BY id"
      ).bind(webhookId).all().catch(() => null);
      const freshIds = (fresh?.results || []).map((s) => Number(s.id)).filter(Boolean);
      if (freshIds.length > 0) {
        invalidateRouteConfig(env, ctx, webhookId);
        route = { ...route, subIds: freshIds, subs: freshIds.map((id) => ({ id, filter_code: null })) };
      }
    } catch { /* keep cached route */ }
  }

  const webhookRow = route?.webhookRow || null;
  const cachedActions = route?.actions || [];

  let pre = {};
  let preError = null;
  const enabled = (cachedActions || []).filter((x) => x.phase === "pre" || !x.phase);
  const action = enabled[0];
  if (action && action.code && String(action.code).trim()) {
    const r = await runUserScript(action.code, msg, webhookRow);
    pre = r.pre;
    preError = r.error;
  }

  // Webhook-level conditional filter: falsy drops the whole event.
  // Empty/unset allows everything; errors fail open (allow) with a log.
  const filterCtx = buildContext(rowFromMessage(msg, pre), webhookRow, pre);
  let webhookFilterError = null;
  const webhookFilterCode = webhookRow?.filter_code ?? null;
  if (webhookFilterCode && String(webhookFilterCode).trim()) {
    const fr = evaluateFilter(webhookFilterCode, filterCtx);
    if (fr.error) webhookFilterError = fr.error;
    if (!fr.allow && !fr.error) {
      logEventStatus({
        msg: "event filtered", status: "filtered",
        eventId, webhookId, deliveriesEnqueued: 0, filtered: true,
        ...(preError ? { preError } : {}),
      });
      return;
    }
    // On filter error we fail open (deliver anyway) but surface the error.
    if (!fr.allow && fr.error) webhookFilterError = fr.error;
  }

  // Subscription-level filters: falsy skips only that subscription.
  // Cached rows carry filter_code; unknown/legacy shapes fail open.
  const cachedSubs = Array.isArray(route?.subs) && route.subs.length
    ? route.subs
    : (route?.subIds || []).map((id) => ({ id: Number(id), filter_code: null }));
  const targets = [];
  let filteredSubs = 0;
  for (const s of cachedSubs) {
    const sid = Number(s?.id);
    if (!sid) continue;
    const fc = s?.filter_code ?? null;
    if (fc && String(fc).trim()) {
      const fr = evaluateFilter(fc, filterCtx);
      if (fr.error) {
        // Fail open per subscription; surface via log below.
        webhookFilterError = webhookFilterError || fr.error;
        targets.push(sid);
      } else if (fr.allow) {
        targets.push(sid);
      } else {
        filteredSubs++;
      }
    } else {
      targets.push(sid);
    }
  }

  // Tiered fan-out: re-validate the stamped tier against the owner's
  // current plan, then send to that tier's delivery queue. Dedicated
  // failures throw (retry + alert) — never spill into shared.
  const { tier, dedicatedQueue } = await resolveEventTier(msg, env, ctx, webhookRow);
  let deliveryQueue = null;
  try {
    deliveryQueue = resolveDeliveryQueue(env, tier, dedicatedQueue);
  } catch (error) {
    console.error(JSON.stringify({ level: "error", msg: "tier queue unbound, retrying with backoff",
      eventId, webhookId, tier, dedicatedQueue: dedicatedQueue || null, error: error?.message || String(error) }));
    throw error;
  }
  if (!deliveryQueue) {
    const error = new Error(`no delivery queue bound for tier: ${tier}`);
    console.error(JSON.stringify({ level: "error", msg: "tier queue unbound, retrying with backoff",
      eventId, webhookId, tier, error: error.message }));
    throw error;
  }
  // Fan-out concurrently: per-subscription latency never stacks, and the
  // analytics increment rides along with its own delivery send.
  const baseDelivery = {
    eventId,
    webhookId,
    tier,
    method: msg.method || "POST",
    headers: msg.headers || {},
    query: msg.query || {},
    payload: msg.payload ?? null,
    rawBody: msg.rawBody ?? null,
    ip: msg.ip || "",
    receivedAt: msg.receivedAt || now(),
    pre,
  };
  const sendOne = async (subscriptionId) => {
    await deliveryQueue.send({ ...baseDelivery, subscriptionId });
    // Subscription-level stat: one task enqueued for this subscription.
    await emitAnalytics(env, analyticsMsg(webhookId, "enqueued", 1, msg.receivedAt, subscriptionId, tier));
  };
  if (typeof deliveryQueue.sendBatch === "function") {
    // One round-trip for N deliveries when the runtime supports batching.
    try {
      await deliveryQueue.sendBatch(targets.map((subscriptionId) => ({ body: { ...baseDelivery, subscriptionId } })));
      await Promise.all(targets.map((subscriptionId) =>
        emitAnalytics(env, analyticsMsg(webhookId, "enqueued", 1, msg.receivedAt, subscriptionId, tier))
      ));
    } catch {
      await Promise.all(targets.map(sendOne));
    }
  } else {
    await Promise.all(targets.map(sendOne));
  }

  logEventStatus({
    msg: filteredSubs > 0 ? "event processed (some subscriptions filtered)" : "event processed",
    status: filteredSubs > 0 && targets.length === 0 ? "filtered" : "processed",
    eventId,
    webhookId,
    tier,
    deliveriesEnqueued: targets.length,
    ...(filteredSubs ? { filteredSubs } : {}),
    ...(preError ? { preError } : {}),
    ...(webhookFilterError ? { filterError: webhookFilterError } : {}),
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

  // Both reads are cached and run concurrently — steady traffic skips D1.
  let [sub, webhookRow] = await Promise.all([
    getSubscription(env, ctx, subscriptionId, async () =>
      env.DB.prepare("SELECT * FROM subscriptions WHERE id=?").bind(subscriptionId).first().catch(() => null)
    ).catch(() => null),
    getWebhookRow(env, ctx, webhookId, async () =>
      env.DB.prepare("SELECT id,name,filter_code FROM webhooks WHERE id=?").bind(webhookId).first()
        .catch(() => env.DB.prepare("SELECT id,name FROM webhooks WHERE id=?").bind(webhookId).first().catch(() => null))
    ).catch(() => null),
  ]);
  // Stale-disabled guard: a cached disabled/missing row must never drop a
  // delivery right after a re-enable. Re-check D1 once before skipping.
  if (!sub || !sub.enabled) {
    try {
      const fresh = await env.DB.prepare("SELECT * FROM subscriptions WHERE id=?")
        .bind(subscriptionId).first().catch(() => null);
      if (fresh && fresh.enabled) sub = fresh;
    } catch { /* keep cached value */ }
  }
  if (!sub || !sub.enabled) {
    logEventStatus({
      msg: "delivery skipped", status: "skipped",
      eventId, webhookId, subscriptionId, reason: !sub ? "subscription gone" : "disabled",
    });
    return;
  }

  const tplCtx = buildContext(
    rowFromMessage(msg, msg.pre || {}),
    webhookRow,
    msg.pre || {}
  );
  // Defense-in-depth: re-evaluate filters here in case the fan-out used a
  // stale route cache from before a filter was added. Filter errors fail
  // open (deliver anyway).
  const webhookFc = webhookRow?.filter_code ?? null;
  if (webhookFc && String(webhookFc).trim()) {
    const fr = evaluateFilter(webhookFc, tplCtx);
    if (!fr.error && !fr.allow) {
      logEventStatus({
        msg: "delivery filtered", status: "filtered",
        eventId, webhookId, subscriptionId, reason: "webhook filter",
      });
      return;
    }
  }
  const subFc = sub?.filter_code ?? null;
  if (subFc && String(subFc).trim()) {
    const fr = evaluateFilter(subFc, tplCtx);
    if (fr.error) {
      logEventStatus({
        msg: "delivery filter error (fail open)", status: "success",
        eventId, webhookId, subscriptionId, filterError: fr.error,
      });
    } else if (!fr.allow) {
      logEventStatus({
        msg: "delivery filtered", status: "filtered",
        eventId, webhookId, subscriptionId, reason: "subscription filter",
      });
      return;
    }
  }
  const rendered = renderSubscription(sub, tplCtx);

  if (!rendered.url) {
    const err = rendered.errors[0] || "Subscription template rendered an empty URL";
    await emitAnalytics(env, analyticsMsg(webhookId, "delivered_failed", 1, msg.receivedAt, subscriptionId, normalizeTier(msg.tier)));
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
    await emitAnalytics(env, analyticsMsg(webhookId, "delivered_ok", 1, msg.receivedAt, subscriptionId, normalizeTier(msg.tier)));
    logEventStatus({
      msg: "delivery ok", status: "success",
      eventId, webhookId, subscriptionId,
      target: rendered.url, http_status: outcome.httpStatus,
    });
    return;
  }
  await emitAnalytics(env, analyticsMsg(webhookId, "delivered_failed", 1, msg.receivedAt, subscriptionId, normalizeTier(msg.tier)));
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

const ANALYTICS_FIELDS = new Set(["enqueued", "delivered_ok", "delivered_failed"]);

// Analytics queue: the ONLY writer of aggregate counters. Batches collapse
// N messages into one UPSERT per (subscription, day), so hot-path throughput
// never translates into per-event D1 writes. All stats are subscription-level.
async function processAnalyticsBatch(messages, env) {
  await ensureSubscriptionCounterTables(env);
  // Accumulate {"subId|day" -> {subscriptionId, webhookId, day, counts}}
  const subAcc = new Map();
  for (const m of messages) {
    const b = m.body || {};
    const webhookId = Number(b.webhookId);
    const subscriptionId = b.subscriptionId != null ? Number(b.subscriptionId) : 0;
    if (!webhookId || !subscriptionId || !ANALYTICS_FIELDS.has(b.field)) continue;
    const day = String(b.day || dayOf(now()));
    const count = Math.max(1, Math.min(10000, Number(b.count) || 1));
    const key = `${subscriptionId}|${day}`;
    if (!subAcc.has(key)) subAcc.set(key, { subscriptionId, webhookId, day, enqueued: 0, delivered_ok: 0, delivered_failed: 0 });
    subAcc.get(key)[b.field] += count;
  }
  const ts = now();
  for (const entry of subAcc.values()) {
    await env.DB.prepare(
      `INSERT INTO subscription_counters (subscription_id, webhook_id, enqueued, delivered_ok, delivered_failed, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(subscription_id) DO UPDATE SET
         enqueued=enqueued+excluded.enqueued,
         delivered_ok=delivered_ok+excluded.delivered_ok,
         delivered_failed=delivered_failed+excluded.delivered_failed,
         updated_at=excluded.updated_at`
    ).bind(entry.subscriptionId, entry.webhookId, entry.enqueued, entry.delivered_ok, entry.delivered_failed, ts).run();
    await env.DB.prepare(
      `INSERT INTO subscription_daily_counters (subscription_id, day, enqueued, delivered_ok, delivered_failed, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(subscription_id, day) DO UPDATE SET
         enqueued=enqueued+excluded.enqueued,
         delivered_ok=delivered_ok+excluded.delivered_ok,
         delivered_failed=delivered_failed+excluded.delivered_failed,
         updated_at=excluded.updated_at`
    ).bind(entry.subscriptionId, entry.day, entry.enqueued, entry.delivered_ok, entry.delivered_failed, ts).run();
  }
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
  } catch { /* ignore — next batch retries */ }
}

async function processAnalytics(message, env, ctx) {
  await processAnalyticsBatch([{ body: message }], env);
}

export { analyticsMsg, dayOf, emitAnalytics, logEventStatus, now, processAnalytics, processAnalyticsBatch, processDelivery, processEvent, rowFromMessage, runUserScript };
