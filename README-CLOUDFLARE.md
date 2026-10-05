# Hooklane on Cloudflare Workers

This version maps the webhook service to Cloudflare primitives:

- **Workers Static Assets** for the admin UI
- **D1** for accounts, webhooks, actions and event history
- **Cloudflare Queues** for asynchronous event processing
- **Workers Rate Limiting** for per-user ingestion protection
- **Dynamic Workers** for sandboxed custom JavaScript actions

## 1. Install and authenticate

```bash
npm install
npx wrangler login
```

## 2. Create resources

The `wrangler.jsonc` file declares the D1 and Queue resources. Current Wrangler can automatically provision supported resources from config. If your account/CLI asks you to create them first, run:

```bash
npx wrangler d1 create hooklane-db
npx wrangler queues create hooklane-events
```

Then put the returned D1 database ID into `wrangler.jsonc` if Wrangler has not done so automatically.

## 3. Initialize the remote database

```bash
npx wrangler d1 execute hooklane-db --remote --file=./db/schema.sql
```

## 4. Set the production secret

```bash
npx wrangler secret put APP_SECRET
```

Use a long random value.

## 5. Deploy

```bash
npm run deploy
```

Wrangler will print your `*.workers.dev` URL.

## 6. Test the webhook

Create an account in the dashboard, create a webhook, then:

```bash
curl -X POST "https://YOUR-WORKER.workers.dev/webhooks/YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"event":"user.created","userId":123,"name":"Jane"}'
```

Expected response:

```json
{"accepted":true,"eventId":1,"status":"queued"}
```

## Important custom-script note

The deployed service does **not** use `eval()` or `new Function()` for user code. Cloudflare Workers blocks those APIs during request processing. Custom actions are executed in sandboxed Dynamic Workers with outbound network access disabled by default. This keeps tenant scripts isolated from the main Worker and its secrets.

The action body can use:

- `event` — mutable event object
- `log(...)` — append a message to the event log
- `setStatus("failed")` — mark the event as failed

Example pre-action:

```js
if (event.payload && event.payload.email) {
  event.payload.email = event.payload.email.toLowerCase();
}
log("normalized email");
```

## Rate limiting

The sample configuration applies 60 requests/minute per user. The Workers Rate Limiting API is enforced after the public webhook token is resolved, using the owner's user ID as the rate-limit key.

For stricter/global protection, also consider Cloudflare WAF/rate-limit rules on the public hostname. Worker Rate Limiting is local to the Cloudflare location handling the request.
