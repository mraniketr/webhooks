import { buildContext, renderSubscription } from "./template.js";

function now() {
  return new Date().toISOString();
}

async function runUserScript(code, event, env, ctx) {
  // Free-plan compatible stub.
  // Original implementation used env.LOADER.load() (Dynamic Workers /
  // Workers for Platforms), which requires a Workers Paid plan and fails
  // deploy with error 10195 on Free. Custom user code is therefore skipped
  // here so deploy + queue processing works on Free.
  // To re-enable sandboxed actions: upgrade to Workers Paid, restore
  // `worker_loaders: [{ "binding": "LOADER" }]` in wrangler configs and the
  // LOADER-based implementation.
  //
  // Contract when re-enabled: the script runs with `event` mutable and may
  // assign `output` (any JSON-serializable value). The returned `output`
  // becomes one entry in the event's `pre[]` array (index = action order),
  // exposed to subscriptions as {{ pre.0 }}, {{ pre.0.field }}, etc.
  return { event, output: undefined, logs: [] };
}

async function ensurePreColumn(env) {
  try {
    const cols = await env.DB.prepare("PRAGMA table_info(events)").all();
    const names = new Set((cols.results || []).map((c) => c.name));
    if (!names.has("pre_json")) await env.DB.prepare("ALTER TABLE events ADD COLUMN pre_json TEXT").run();
    return names.has("pre_json");
  } catch { return false; }
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

function payloadText(payload) {
  if (payload == null) return "";
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

// Main queue: run pre-actions (each may produce an `output` object collected
// into pre[]), persist the event + pre[], fan out one task per enabled
// subscription into the delivery queue, ack.
// Delivery failures never fail this handler — each delivery task carries
// its own retry budget on the delivery queue.
async function processEvent(message, env, ctx) {
  const eventId = Number(message.eventId);
  const row = await env.DB.prepare("SELECT * FROM events WHERE id=?").bind(eventId).first();
  if (!row) return;
  const actions = await env.DB.prepare(
    "SELECT * FROM actions WHERE webhook_id=? AND enabled=1 AND phase='pre' ORDER BY sort_order, id"
  )
    .bind(row.webhook_id)
    .all()
    .catch(async () => await env.DB.prepare(
      "SELECT * FROM actions WHERE webhook_id=? AND enabled=1 ORDER BY sort_order, id"
    ).bind(row.webhook_id).all());
  let event = {
    id: row.id,
    webhookId: row.webhook_id,
    payload: row.payload_json ? JSON.parse(row.payload_json) : row.raw_body,
    headers: JSON.parse(row.headers_json || "{}"),
    ip: row.ip,
    receivedAt: row.received_at,
  };
  const logs = [];
  const pre = [];

  try {
    for (const a of (actions.results || []).filter((x) => x.phase === "pre" || !x.phase)) {
      const result = await runUserScript(a.code, event, env, ctx);
      event = result.event;
      logs.push(...(result.logs || []));
      // Index-stable: pre[i] corresponds to the i-th enabled pre-action.
      pre.push(result.output === undefined ? null : result.output);
    }

    const preJson = JSON.stringify(pre);
    const hasPreCol = await ensurePreColumn(env);
    if (hasPreCol) {
      await env.DB.prepare(
        "UPDATE events SET payload_json=?, pre_json=?, status='processed', error=NULL, processed_at=? WHERE id=?"
      )
        .bind(event.payload == null ? null : JSON.stringify(event.payload), preJson, now(), eventId)
        .run();
    } else {
      try {
        await env.DB.prepare(
          "UPDATE events SET payload_json=?, pre_json=?, status='processed', error=NULL, processed_at=? WHERE id=?"
        )
          .bind(event.payload == null ? null : JSON.stringify(event.payload), preJson, now(), eventId)
          .run();
      } catch {
        await env.DB.prepare(
          "UPDATE events SET payload_json=?, status='processed', error=NULL, processed_at=? WHERE id=?"
        )
          .bind(event.payload == null ? null : JSON.stringify(event.payload), now(), eventId)
          .run();
      }
    }

    const subs = await env.DB.prepare(
      "SELECT id FROM subscriptions WHERE webhook_id=? AND enabled=1 ORDER BY id"
    )
      .bind(row.webhook_id)
      .all();
    for (const sub of subs.results) {
      await env.DELIVERY_QUEUE.send({ eventId, subscriptionId: sub.id });
    }

    if (logs.length) {
      await env.DB.prepare("UPDATE events SET error=? WHERE id=?").bind(logs.join("\n"), eventId).run();
    }
  } catch (error) {
    await env.DB.prepare("UPDATE events SET status='failed', error=?, processed_at=? WHERE id=?")
      .bind(error?.message || String(error), now(), eventId)
      .run();
    throw error;
  }
}

// Delivery queue: forward one event to one subscription URL. Throws on
// failure so this task alone is retried — the main queue is unaffected.
// The deliveries table is the idempotency record: already-successful
// (event, subscription) pairs are skipped, attempts are counted per row.
async function processDelivery(message, env, ctx) {
  const eventId = Number(message.eventId);
  const subscriptionId = Number(message.subscriptionId);
  if (!eventId || !subscriptionId) return;

  const eventRow = await env.DB.prepare("SELECT * FROM events WHERE id=?").bind(eventId).first();
  if (!eventRow) return;
  const sub = await env.DB.prepare("SELECT * FROM subscriptions WHERE id=?").bind(subscriptionId).first();
  if (!sub || !sub.enabled) return;

  let row = await env.DB.prepare("SELECT * FROM deliveries WHERE event_id=? AND subscription_id=?")
    .bind(eventId, subscriptionId)
    .first();
  if (!row) {
    const inserted = await env.DB.prepare(
      "INSERT INTO deliveries (event_id,subscription_id,target_url,status,attempts,created_at) VALUES (?,?,?,?,?,?)"
    )
      .bind(eventId, subscriptionId, sub.target_url, "pending", 0, now())
      .run();
    row = await env.DB.prepare("SELECT * FROM deliveries WHERE id=?").bind(inserted.meta.last_row_id).first();
  }
  if (row.status === "success") return;

  const attempt = row.attempts + 1;
  const webhookRow = await env.DB.prepare("SELECT id,name FROM webhooks WHERE id=?").bind(eventRow.webhook_id).first().catch(() => null);
  const tplCtx = buildContext(eventRow, webhookRow);
  const rendered = renderSubscription(sub, tplCtx);
  // Sync the stored delivery URL with the rendered URL so history shows the real target.
  if (rendered.url && rendered.url !== row.target_url) {
    await env.DB.prepare("UPDATE deliveries SET target_url=? WHERE id=?").bind(rendered.url.slice(0, 2000), row.id).run();
    row.target_url = rendered.url;
  }
  if (!rendered.url || rendered.errors.length && rendered.url === "") {
    const message = rendered.errors[0] || "Subscription template rendered an empty URL";
    await env.DB.prepare(
      "UPDATE deliveries SET status='failed', attempts=?, http_status=?, response_preview=?, error=?, completed_at=? WHERE id=?"
    )
      .bind(attempt, null, null, message, now(), row.id)
      .run();
    throw new Error(`${sub.name}: ${message}`);
  }
  const bodyText = rendered.bodyText;
  const headers = {
    "content-type": "application/json",
    "X-Hooklane-Event-Id": String(eventId),
    "X-Hooklane-Webhook-Id": String(eventRow.webhook_id),
    "X-Hooklane-Delivery-Id": String(row.id),
    "X-Hooklane-Attempt": String(attempt),
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
    await env.DB.prepare(
      "UPDATE deliveries SET status='success', attempts=?, http_status=?, response_preview=?, error=NULL, completed_at=? WHERE id=?"
    )
      .bind(attempt, outcome.httpStatus, outcome.preview, now(), row.id)
      .run();
    return;
  }
  await env.DB.prepare(
    "UPDATE deliveries SET status='failed', attempts=?, http_status=?, response_preview=?, error=?, completed_at=? WHERE id=?"
  )
    .bind(attempt, outcome.httpStatus, outcome.preview, outcome.message, now(), row.id)
    .run();
  throw new Error(`${sub.name}: ${outcome.message}`);
}

export { now, processDelivery, processEvent, runUserScript };
