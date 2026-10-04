import { processEvent } from "./processing.js";

// Dedicated queue consumer worker.
//
// Responsibilities:
// - Drain `hooklane-events` and mark events processed/failed in D1.
// - Scale / retry independently of the API + producer worker (src/index.js).
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
    for (const message of batch.messages) {
      try {
        await processEvent(message.body, env, ctx);
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            msg: "queue message failed, retrying",
            queue: batch.queue,
            eventId: message.body?.eventId,
            error: error?.message || String(error),
          })
        );
        message.retry();
      }
    }
  },
};
