# Hooklane — Simple Webhook Service

A small full-stack webhook control plane built with Node.js 22's built-in `node:sqlite` and no external packages.

## Flow

1. Create an admin account and log in.
2. Create a webhook and get a public URL.
3. Any client can `POST`, `PUT`, or `PATCH` to that URL.
4. The service checks a per-user token-bucket rate limit.
5. It persists the event and queues a background job.
6. The HTTP request returns `202 Accepted` quickly.
7. A worker runs pre/post custom JavaScript actions asynchronously.
8. The admin dashboard shows webhook stats, event history, status, payloads, headers, and errors.

## Run

```bash
cd webhook-service
APP_SECRET='replace-this' node server.js
```

Open http://localhost:3000

## Test a webhook

After creating one, copy the generated URL and run:

```bash
curl -X POST 'http://localhost:3000/webhooks/YOUR_TOKEN' \\
  -H 'content-type: application/json' \\
  -d '{"type":"invoice.created","amount":4200,"customer":"cus_123"}'
```

You should get a `202` response with an `eventId`.

## Rate limiting

Defaults are 60 requests/minute per user with a burst of 20 tokens. Configure with:

```bash
RATE_LIMIT_PER_MIN=120 RATE_LIMIT_BURST=40 node server.js
```

For a horizontally scaled production service, move the limiter to Redis so all instances share the same bucket.

## Custom scripts

Scripts run in the background using Node's `vm` API with a 500ms timeout. They receive:

- `event.id`
- `event.webhookId`
- `event.payload`
- `event.headers`
- `event.ip`
- `event.receivedAt`
- `log(...)`
- `setStatus(...)`

Example pre-script:

```js
event.payload.normalized = true;
event.payload.receivedBy = 'hooklane';
```

Example post-script:

```js
log('processed event', event.id);
if (event.payload.amount > 10000) setStatus('failed');
```

**Production note:** `vm` is not a hardened sandbox for hostile code. For untrusted customer-defined scripts, isolate execution in a separate container/process sandbox with CPU, memory, filesystem, and network controls.

## Persistence model

SQLite tables:

- `users` — admin accounts
- `webhooks` — endpoint configuration and secrets
- `actions` — pre/post processing scripts
- `events` — webhook deliveries
- `jobs` — asynchronous processing queue

This is intentionally simple. A production version could move event storage to Postgres, use Redis for rate limiting and queue coordination, and run a durable worker fleet.
