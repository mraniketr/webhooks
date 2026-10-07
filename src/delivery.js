import { buildContext, evaluateFilter, renderSubscription } from "./template.js";
import { getSubscription, getWebhookRow } from "./cache.js";
import { analyticsMsg, deliveryDelay, emitAnalytics, eventDelay, hmacHex, logEventStatus, normalizeTier, rowFromMessage } from "./processing.js";

// Delivery worker: consumes ONLY `hooklane-deliveries-*` queues (shared,
// pro, and per-customer dedicated — same code artifact, the consumers[]
// list in each wrangler config selects the queue).
//
// Forwards one event to one subscription URL. Throws on failure so the
// task alone is retried — the events queue is unaffected. Outcome is a
// structured log (with http_status) + an analytics increment;
// no per-delivery D1 row.

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

// This worker has no HTTP routes; `fetch` only exists so direct hits
// return a clear 404 instead of a missing-handler error.

export default {
  async fetch() {
    return new Response(JSON.stringify({ error: "Delivery worker does not serve HTTP" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  },

  async queue(batch, env, ctx) {
    // This worker owns delivery queues only. Anything else landing here is
    // a config error — retry (don't ack, don't process) so it surfaces.
    // Match by inclusion so shared, pro, and per-customer dedicated
    // (`hooklane-deliveries-ded-*`) queues all route here, in prod and dev.
    if (!batch.queue.includes("hooklane-deliveries")) {
      console.error(
        JSON.stringify({
          level: "error",
          msg: "unexpected queue on delivery worker, retrying",
          queue: batch.queue,
        })
      );
      const delaySeconds = eventDelay(1);
      for (const message of batch.messages) {
        try {
          message.retry({ delaySeconds });
        } catch {
          message.retry();
        }
      }
      return;
    }
    // Run messages in a batch concurrently — sequential awaits would stack
    // per-message latency (notably the outbound fetch in processDelivery).
    await Promise.all(batch.messages.map(async (message) => {
      try {
        await processDelivery(message.body, env, ctx);
        message.ack();
      } catch (error) {
        const delaySeconds = deliveryDelay(message.attempts);
        console.error(
          JSON.stringify({
            level: "error",
            msg: "queue message failed, retrying with backoff",
            queue: batch.queue,
            attempt: Number(message.attempts) || 1,
            delaySeconds,
            body: message.body,
            error: error?.message || String(error),
          })
        );
        try {
          message.retry({ delaySeconds });
        } catch {
          message.retry();
        }
      }
    }));
  },
};

export { processDelivery };
