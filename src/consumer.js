import { processDelivery, processEvent } from "./processing.js";

// Consumer worker for both queues.
//
// - `hooklane-events` (main queue): run the single pre-action (setting the
//   `pre` key-value object), fan out one task per subscription into
//   `hooklane-deliveries`, then ack.
//   Delivery failures never block this queue.
// - `hooklane-deliveries` (task queue): forward one event to one URL with
//   its own retry budget, logged in the deliveries table.
//
// This worker has no HTTP routes; `fetch` only exists so direct hits
// return a clear 404 instead of a missing-handler error.

const HANDLERS = {
  "hooklane-events": processEvent,
  "hooklane-deliveries": processDelivery,
};

export default {
  async fetch() {
    return new Response(JSON.stringify({ error: "Consumer worker does not serve HTTP" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  },

  async queue(batch, env, ctx) {
    const handler = HANDLERS[batch.queue] || processEvent;
    for (const message of batch.messages) {
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
    }
  },
};
