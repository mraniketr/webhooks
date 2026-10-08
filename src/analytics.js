// Analytics writer — the ONLY aggregate counter writer in the system.
// Owned by the router worker (which also consumes the analytics queue),
// but kept in this separate file so queue consumers never mix.
//
// DIP: all D1 access goes through CounterRepository (via IDbAccessor).
// This module holds NO SQL — accumulation + UPSERT live in the repo.

import { createRepositories } from "./repositories/index.js";

async function processAnalyticsBatch(messages, env) {
  const { counters } = createRepositories(env, null);
  await counters.processMessages(messages);
}

async function processAnalytics(message, env, ctx) {
  await processAnalyticsBatch([{ body: message }], env);
}

export { processAnalytics, processAnalyticsBatch };
