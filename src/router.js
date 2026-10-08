import { buildContext, evaluateFilter } from "./template.js";
import { createRepositories } from "./repositories/index.js";
import { analyticsDelay, analyticsMsg, emitAnalytics, eventDelay, logEventStatus, normalizeTier, now, rowFromMessage, runUserScript } from "./processing.js";
import { processAnalyticsBatch } from "./analytics.js";

// Router worker: consumes the single `hooklane-events` queue plus the
// `hooklane-analytics` queue — and nothing else. Delivery queues are owned
// by the delivery worker(s) (src/delivery.js).
//
// - events: run the single pre-action (setting the `pre` key-value object),
//   fan out one task per subscription into the owner's tier delivery queue
//   (`hooklane-deliveries-shared` / `-pro` / `-ded-<slug>`), then ack.
//   No D1 writes here — status goes to structured logs, counts go to the
//   analytics queue. Delivery failures never block this queue.
// - analytics: delegated to src/analytics.js (the ONLY aggregate writer).

// ---- Tiered delivery routing ----
// Ingress stamps msg.tier at ingest; fan-out re-validates against the
// owner's current plan so upgrades take effect within the tier-cache TTL.
// The router needs one producer binding per dedicated queue, named
// DELIVERY_DEDICATED_<SLUG> (slug uppercased, hyphens -> underscores),
// e.g. queue hooklane-deliveries-ded-acme binds as DELIVERY_DEDICATED_ACME.
// Never reroute dedicated -> shared on a missing binding: throw so the
// event retries with backoff and alerts.
function dedicatedBindingKey(queueName) {
  const slug = String(queueName || "").replace(/^hooklane-deliveries-ded-/, "");
  if (!slug) return null;
  return `DELIVERY_DEDICATED_${slug.toUpperCase().replace(/-/g, "_")}`;
}

function resolveDeliveryQueue(env, tier, dedicatedQueue) {
  // 'shared' is accepted as an alias for the 'pro' tier queue (DELIVERY_PRO).
  if (tier === "pro" || tier === "shared") {
    return env.DELIVERY_PRO || env.DELIVERY_QUEUE || null;
  }
  if (tier === "dedicated") {
    const key = dedicatedBindingKey(dedicatedQueue);
    const bound = (key && env[key]) || env.DELIVERY_DEDICATED || null;
    if (bound) return bound;
    if (!dedicatedQueue) {
      // Self-serve dedicated before an admin provisions a queue: fall back
      // to the shared queue so events still deliver (logged at the call site).
      // A *named* but unbound queue stays a hard error (misconfiguration).
      return env.DELIVERY_SHARED || env.DELIVERY_QUEUE || null;
    }
    const err = new Error(`dedicated queue not bound: ${dedicatedQueue || "(unset)"}${key ? ` (expected binding ${key})` : ""}`);
    err.code = "DEDICATED_QUEUE_MISSING";
    throw err;
  }
  return env.DELIVERY_SHARED || env.DELIVERY_QUEUE || null;
}

async function resolveEventTier(msg, env, ctx, webhookRow) {
  const stamped = normalizeTier(msg.tier);
  const stampedQueue = msg.dedicatedQueue || null;
  try {
    const userId = webhookRow?.user_id;
    if (!userId) return { tier: stamped, dedicatedQueue: stampedQueue, fresh: false };
    // KV-cached owner tier via UserRepository — no raw env.DB here.
    const { users } = createRepositories(env, ctx);
    const tierRow = await users.findTierCached(userId).catch(() => null);
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

// Events queue: run the single pre-action (sets the `pre` key-value object),
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

  // Stale-empty guard lives in the repository: a cached "no subscriptions"
  // entry must never drop a fan-out right after a subscription was added.
  let route = await routes.getCached(webhookId).catch(() => null);
  route = await routes.refreshWhenStaleEmpty(webhookId, route);

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

// This worker has no HTTP routes; `fetch` only exists so direct hits
// return a clear 404 instead of a missing-handler error.

export default {
  async fetch() {
    return new Response(JSON.stringify({ error: "Router worker does not serve HTTP" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  },

  async queue(batch, env, ctx) {
    // Analytics batches go to the aggregate writer (own retry budget).
    // Match by suffix so both prod (`hooklane-*`) and dev (`dev-hooklane-*`)
    // queue names route correctly.
    if (batch.queue.endsWith("hooklane-analytics")) {
      try {
        await processAnalyticsBatch(batch.messages, env);
        for (const message of batch.messages) message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            msg: "analytics batch failed, retrying with backoff",
            queue: batch.queue,
            error: error?.message || String(error),
          })
        );
        const maxAttempts = Math.max(...batch.messages.map((m) => Number(m.attempts) || 1), 1);
        const delaySeconds = analyticsDelay(maxAttempts);
        try {
          batch.retryAll({ delaySeconds });
        } catch {
          for (const message of batch.messages) message.retry({ delaySeconds });
        }
      }
      return;
    }

    if (!batch.queue.endsWith("hooklane-events")) {
      // Delivery queues belong to the delivery worker — a batch landing here
      // is a config error. Retry (don't ack, don't process) so it surfaces.
      console.error(
        JSON.stringify({
          level: "error",
          msg: "unexpected queue on router worker, retrying",
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

    // Events queue: run messages concurrently — sequential awaits would stack
    // per-message latency (notably the fan-out queue sends).
    await Promise.all(batch.messages.map(async (message) => {
      try {
        await processEvent(message.body, env, ctx);
        message.ack();
      } catch (error) {
        const delaySeconds = eventDelay(message.attempts);
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

export { processEvent };
