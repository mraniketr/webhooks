#!/usr/bin/env bash
# Provision a per-customer dedicated delivery worker + queue.
# Usage: npm run provision:dedicated -- <slug>
#   slug: lowercase letters, numbers, hyphens (e.g. acme)
set -euo pipefail

SLUG="${1:-}"
if ! [[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{0,59}$ ]]; then
  echo "Usage: $0 <slug>  (lowercase letters, numbers, hyphens)" >&2
  exit 1
fi

QUEUE="hooklane-deliveries-ded-${SLUG}"
WORKER="webhooks-delivery-ded-${SLUG}"
OUT="wrangler.delivery-dedicated.${SLUG}.jsonc"

echo "==> Creating queue ${QUEUE}"
npx wrangler queues create "$QUEUE"

echo "==> Stamping ${OUT}"
sed -e "s/__SLUG__/${SLUG}/g" -e "s/__WORKER_NAME__/${WORKER}/g" \
  wrangler.delivery-dedicated.template.jsonc > "$OUT"

echo "==> Next steps:"
echo "    1. Tune batch/retry settings in ${OUT} per the customer contract."
echo "    2. Add a producer binding for ${QUEUE} to the router config"
echo "       (wrangler.router.jsonc) and redeploy the router worker."
echo "    3. Deploy: npx wrangler deploy --config ${OUT}"
echo "    4. Set tier: PUT /api/admin/users/<id>/plan"
echo "       {\"plan\":\"dedicated\",\"dedicated_queue\":\"${QUEUE}\"}"
