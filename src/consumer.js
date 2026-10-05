import { processAnalyticsBatch, processDelivery, processEvent } from "./processing.js";

// Consumer worker for all three queues.
//
// - `hooklane-events` (main queue): run the single pre-action (setting the
//   `pre` key-value object), fan out one task per subscription into
//   `hooklane-deliveries`, then ack. No D1 writes here — status goes to
//   structured logs, counts go to the analytics queue.
//   Delivery failures never block this queue.
// - `hooklane-deliveries` (task queue): forward one event to one URL with
//   its own retry budget. Outcome is a structured log (with http_status)
//   plus an analytics increment — no per-delivery D1 row.
// - `hooklane-analytics` (counts queue): the ONLY aggregate writer.
//   Collapses each batch into one UPSERT per (webhook, day).
//
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
    if (batch.queue === "hooklane-analytics") {
      try {
        await processAnalyticsBatch(batch.messages, env);
        for (const message of batch.messages) message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            msg: "analytics batch failed, retrying",
            queue: batch.queue,
            error: error?.message || String(error),
          })
        );
        for (const message of batch.messages) message.retry();
      }
      return;
    }

    const handler = batch.queue === "hooklane-deliveries" ? processDelivery : processEvent;
    // Run messages in a batch concurrently — sequential awaits would stack
    // per-message latency (notably the outbound fetch in processDelivery).
    await Promise.all(batch.messages.map(async (message) => {
      try {
        await handler(message.body, env, ctx);
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            msg: "queue message failed, retrying",
            queue: batch.queue,
            body: message.body,
            error: error?.message || String(error),
          })
        );
        message.retry();
      }
    }));
  },
};
