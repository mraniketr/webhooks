import { processAnalyticsBatch, processDelivery, processEvent } from "./processing.js";

// Consumer worker for all queues (same artifact, three deployments).
//
// - `hooklane-events` (main queue, shared consumer only): run the single
//   pre-action (setting the `pre` key-value object), fan out one task per
//   subscription into the owner's tier delivery queue
//   (`hooklane-deliveries-shared` / `-pro` / `-ded-<slug>`), then ack.
//   No D1 writes here — status goes to structured logs, counts go to the
//   analytics queue. Delivery failures never block this queue.
// - `hooklane-deliveries-*` (tier task queues): forward one event to one URL
//   with its own retry budget. Outcome is a structured log (with http_status)
//   plus an analytics increment — no per-delivery D1 row. The shared
//   deployment consumes `-shared`, the pro deployment consumes `-pro`, and
//   each dedicated deployment consumes its own `-ded-<slug>` queue.
// - `hooklane-analytics` (counts queue): the ONLY aggregate writer.
//   Collapses each batch into one UPSERT per (webhook, day).
//
// Exponential backoff for queue retries, total window held under 24h
// (Queues `delaySeconds` max is 24h). Uses per-message `attempts` (1 on first
// delivery) so a slow/down downstream backs off as:
// Deliveries (base 60s x 10 retries): 60s, 120s, ..., 30720s ≈ 17.05h total.
// Events (base 10s x 8 retries, cap 900s): ≈ 36m total.
// Analytics (base 30s x 8 retries, cap 3600s): ≈ 2.06h total.
// All totals stay under 86400s even with ±10% jitter. Queue `max_retries`
// in wrangler.consumer.jsonc enforces the same budgets (10/8/8).
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

// This worker has no HTTP routes; `fetch` only exists so direct hits
// return a clear 404 instead of a missing-handler error.

export default {
  async fetch() {
    return new Response(JSON.stringify({ error: "Consumer worker does not serve HTTP" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  },

  async queue(batch, env, ctx) {
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

    const isDelivery = batch.queue.includes("hooklane-deliveries");
    const handler = isDelivery ? processDelivery : processEvent;
    const delayFor = isDelivery ? deliveryDelay : eventDelay;
    // Run messages in a batch concurrently — sequential awaits would stack
    // per-message latency (notably the outbound fetch in processDelivery).
    await Promise.all(batch.messages.map(async (message) => {
      try {
        await handler(message.body, env, ctx);
        message.ack();
      } catch (error) {
        const delaySeconds = delayFor(message.attempts);
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
