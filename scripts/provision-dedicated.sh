#!/usr/bin/env bash
# Provision a per-customer dedicated delivery queue + consumer config.
# Usage: npm run provision:dedicated -- <slug>
#   slug: lowercase letters, numbers, hyphens (e.g. acme)
set -euo pipefail

SLUG="${1:-}"
if ! [[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{0,59}$ ]]; then
  echo "Usage: $0 <slug>  (lowercase letters, numbers, hyphens)" >&2
  exit 1
fi

QUEUE="hooklane-deliveries-ded-${SLUG}"
WORKER="webhooks-consumer-ded-${SLUG}"
OUT="wrangler.consumer-dedicated.${SLUG}.jsonc"

echo "==> Creating queue ${QUEUE}"
npx wrangler queues create "$QUEUE"

echo "==> Stamping ${OUT}"
sed -e "s/__SLUG__/${SLUG}/g" -e "s/__WORKER_NAME__/${WORKER}/g" \
  wrangler.consumer-dedicated.template.jsonc > "$OUT"

echo "==> Next steps:"
echo "    1. Tune batch/retry settings in ${OUT} per the customer contract."
echo "    2. Add a producer binding for ${QUEUE} to wrangler.jsonc"
echo "       (or a per-customer producer overlay) and redeploy the API worker."
echo "    3. Deploy: npx wrangler deploy --config ${OUT}"
echo "    4. Set tier: PUT /api/admin/users/<id>/plan"
echo "       {\"plan\":\"dedicated\",\"dedicated_queue\":\"${QUEUE}\"}"
