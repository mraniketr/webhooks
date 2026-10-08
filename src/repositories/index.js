// Composition root for repositories (DIP wiring).
// One call per request/batch builds every repository sharing the SAME
// accessor pair — swap accessors once here and all repos follow (OCP).

import { createAccessors } from "../accessors/index.js";
import { createUserRepository } from "./users.js";
import { createWebhookRepository } from "./webhooks.js";
import { createActionRepository } from "./actions.js";
import { createSubscriptionRepository } from "./subscriptions.js";
import { createPlanRepository } from "./plans.js";
import { createCounterRepository } from "./counters.js";
import { createRouteConfigRepository } from "./routes.js";

/**
 * @param {any} env - worker env
 * @param {any} ctx - execution context (for cache waitUntil)
 * @param {{db?: any, cache?: any}} [overrides] - inject fakes in tests
 */
export function createRepositories(env, ctx, overrides = {}) {
  const { db, cache } = overrides.db && overrides.cache
    ? overrides
    : { ...createAccessors(env), ...overrides };
  const deps = { db, cache, ctx, env };

  const users = createUserRepository(deps);
  const webhooks = createWebhookRepository(deps);
  const actions = createActionRepository(deps);
  const subscriptions = createSubscriptionRepository(deps);
  const plans = createPlanRepository(deps);
  const counters = createCounterRepository(deps);
  const routes = createRouteConfigRepository({ ...deps, webhooks, actions, subscriptions });

  return { db, cache, users, webhooks, actions, subscriptions, plans, counters, routes };
}

export { createUserRepository } from "./users.js";
export { createWebhookRepository } from "./webhooks.js";
export { createActionRepository } from "./actions.js";
export { createSubscriptionRepository } from "./subscriptions.js";
export { createPlanRepository, FALLBACK_PLAN_LIMITS, VALID_PLANS, effectiveTierLimit, structuredFallbackPlans } from "./plans.js";
export { createCounterRepository } from "./counters.js";
export { createRouteConfigRepository } from "./routes.js";
export { normalizePlan } from "./users.js";
