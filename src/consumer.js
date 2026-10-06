import { processAnalyticsBatch } from "./analytics.js";
import { processEvent } from "./router.js";
import { processDelivery } from "./delivery.js";
import { analyticsDelay, deliveryDelay, eventDelay } from "./processing.js";

// Legacy consumer worker — DRAIN ONLY.
//
// This shim keeps the old single-worker deployment (`wrangler.consumer.jsonc`,
// consuming the legacy `hooklane-events` / `hooklane-deliveries` /
// `hooklane-analytics` queues) runnable while the old delivery queue drains.
// Each branch delegates to the handler owned by its own module — no queue
// logic lives here. Do not add new behavior; deploy the router + delivery
// workers for all live traffic.

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
