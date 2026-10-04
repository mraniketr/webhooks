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
  return { event, logs: [] };
}

async function processEvent(message, env, ctx) {
  const eventId = Number(message.eventId);
  const row = await env.DB.prepare("SELECT * FROM events WHERE id=?").bind(eventId).first();
  if (!row) return;
  const actions = await env.DB.prepare(
    "SELECT * FROM actions WHERE webhook_id=? AND enabled=1 ORDER BY phase, sort_order, id"
  )
    .bind(row.webhook_id)
    .all();
  let event = {
    id: row.id,
    webhookId: row.webhook_id,
    payload: row.payload_json ? JSON.parse(row.payload_json) : row.raw_body,
    headers: JSON.parse(row.headers_json || "{}"),
    ip: row.ip,
    receivedAt: row.received_at,
  };
  const logs = [];

  try {
    for (const a of actions.results.filter((x) => x.phase === "pre")) {
      const result = await runUserScript(a.code, event, env, ctx);
      event = result.event;
      logs.push(...(result.logs || []));
    }

    await env.DB.batch([
      env.DB.prepare(
        "UPDATE events SET payload_json=?, status='processed', error=NULL, processed_at=? WHERE id=?"
      ).bind(event.payload == null ? null : JSON.stringify(event.payload), now(), eventId),
    ]);

    for (const a of actions.results.filter((x) => x.phase === "post")) {
      const result = await runUserScript(a.code, event, env, ctx);
      event = result.event;
      logs.push(...(result.logs || []));
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

export { now, processEvent, runUserScript };
