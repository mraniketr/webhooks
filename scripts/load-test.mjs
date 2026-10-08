#!/usr/bin/env node
/**
 * Webhook load tester — zero dependencies (Node 18+).
 *
 * Hits a webhook URL at a controlled rate and reports latency / status stats.
 *
 * Examples:
 *   # 10 req/s for 30s with inline JSON payload
 *   node scripts/load-test.mjs \
 *     --url "https://dev-webhooks.im-aniket-rai.workers.dev/webhooks/hoP_BscMcFm68ZnpGHXvAF_tXgZHiK31" \
 *     --method POST \
 *     --header "Content-Type: application/json" \
 *     --payload '{"hello":"world","xxx":"yyyy","plan":"paid","svix":true}' \
 *     --rps 10 --duration 30s
 *
 *   # 100 total requests at 50 req/s, payload from file, capped concurrency
 *   node scripts/load-test.mjs --url https://example.com/hook \
 *     --rps 50 --total 100 --concurrency 25 --payload-file ./payload.json
 *
 *   # Stepped load: 10 rps for 10s, then 50 rps for 30s, then 100 rps for 60s
 *   node scripts/load-test.mjs --url https://example.com/hook \
 *     --stages "10:10s,50:30s,100:60s" --payload '{"hello":"world"}'
 *
 *   # npm shortcut (after adding the script entry to package.json):
 *   npm run load:test -- --url <url> --rps 20 --duration 60s
 */

const args = process.argv.slice(2);

function printHelpAndExit(code = 0) {
  console.log(`
Webhook load tester

Options:
  --url <url>              Target webhook URL (required, or env LOAD_TEST_URL)
  --method <verb>          HTTP method (default: POST)
  --header "K: V"          Extra header, repeatable. Also: --header-file ./headers.json
  --payload <json>         Inline request body (string). Default content-type: application/json
  --payload-file <path>    Read request body from file (overrides --payload). Use @-random for
                           a unique body per request (appends {"_load_seq":N,"_load_ts":...})
  --rps <n>                Target requests/second (default: 10). The single-stage rate.
  --duration <s|ms|m>      How long to run, e.g. 30s, 5m, 500ms (default: 30s, ignored if --total set)
  --total <n>              Total requests to send (overrides --duration)
  --concurrency <n>        Max in-flight requests (default: min(100, max(10, rps)))
  --stages "<rps>:<dur>,…" Stepped load, e.g. "10:10s,50:30s,100:60s" (overrides --rps/--duration)
  --timeout <ms|s>         Per-request timeout (default: 15s)
  --insecure               Skip TLS verification (NOT recommended, dev only)
  --no-report              Only print final summary (skip per-second progress)
  --help                   Show this help

Env fallbacks: LOAD_TEST_URL, LOAD_TEST_RPS, LOAD_TEST_DURATION, LOAD_TEST_PAYLOAD
`);
  process.exit(code);
}

// ---------- arg parsing ----------
const multi = { header: [] };
const opts = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--help" || a === "-h") printHelpAndExit(0);
  else if (a.startsWith("--")) {
    const key = a.slice(2);
    if (key === "insecure" || key === "no-report") opts[key] = true;
    else {
      const val = args[i + 1];
      if (val === undefined || val.startsWith("--")) {
        console.error(`Missing value for ${a}`);
        process.exit(1);
      }
      if (key === "header") multi.header.push(val);
      else opts[key] = val;
      i++;
    }
  }
}

import { readFileSync } from "node:fs";

function parseDuration(s, fallback) {
  if (s === undefined || s === null || s === "") return fallback;
  if (typeof s === "number") return s * 1000;
  const m = String(s).trim().match(/^([\d.]+)\s*(ms|s|m|min|h)?$/i);
  if (!m) throw new Error(`Bad duration: ${s} (use e.g. 30s, 5m, 500ms)`);
  const n = parseFloat(m[1]);
  const u = (m[2] || "s").toLowerCase();
  if (u === "ms") return n;
  if (u === "s") return n * 1000;
  if (u === "m" || u === "min") return n * 60_000;
  if (u === "h") return n * 3_600_000;
  return n * 1000;
}

const url = opts.url || process.env.LOAD_TEST_URL;
if (!url) {
  console.error('Missing --url (or set LOAD_TEST_URL). See --help.');
  process.exit(1);
}
try {
  new URL(url);
} catch {
  console.error(`Invalid --url: ${url}`);
  process.exit(1);
}

const method = (opts.method || "POST").toUpperCase();
const timeoutMs = parseDuration(opts.timeout ?? "15s", 15_000);
const concurrencyOpt = opts.concurrency ? parseInt(opts.concurrency, 10) : null;

// Headers
const headers = {};
for (const h of multi.header) {
  const idx = h.indexOf(":");
  if (idx === -1) throw new Error(`Bad --header "${h}" (expected "Name: value")`);
  headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
}
if (opts["header-file"]) {
  Object.assign(headers, JSON.parse(readFileSync(opts["header-file"], "utf8")));
}
if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
  headers["Content-Type"] = "application/json";
}

// Payload
let payloadTemplate = opts.payload ?? process.env.LOAD_TEST_PAYLOAD ?? null;
let payloadFile = opts["payload-file"] ?? null;
let randomizeBody = false;
if (payloadFile) {
  if (payloadFile === "@-random" || payloadFile === "@random") randomizeBody = true;
  else payloadTemplate = readFileSync(payloadFile, "utf8");
}
if (payloadTemplate === null && (method === "POST" || method === "PUT" || method === "PATCH")) {
  payloadTemplate = '{"hello":"world","xxx":"yyyy","plan":"paid","svix":true}';
}
function bodyFor(seq) {
  if (payloadTemplate === null) return undefined;
  if (!randomizeBody && !payloadTemplate.includes("$SEQ") && !payloadTemplate.includes("$RAND")) {
    return payloadTemplate;
  }
  let b = payloadTemplate
    .replaceAll("$SEQ", String(seq))
    .replaceAll("$RAND", Math.random().toString(36).slice(2));
  if (randomizeBody) {
    try {
      const obj = JSON.parse(payloadTemplate || "{}");
      obj._load_seq = seq;
      obj._load_ts = new Date().toISOString();
      obj._load_rand = Math.random().toString(36).slice(2);
      b = JSON.stringify(obj);
    } catch {
      b = payloadTemplate;
    }
  }
  return b;
}

// Stages: either --stages "rps:dur,..." or single --rps/--duration/--total
let stages = [];
if (opts.stages) {
  for (const part of String(opts.stages).split(",")) {
    const [rpsRaw, durRaw] = part.split(":").map((s) => s.trim());
    const rps = parseFloat(rpsRaw.replace(/rps$/i, ""));
    if (!Number.isFinite(rps) || rps <= 0) throw new Error(`Bad stage "${part}" (expected "<rps>:<duration>")`);
    stages.push({ rps, durationMs: parseDuration(durRaw, null) ?? (() => { throw new Error(`Bad stage duration in "${part}"`); })() });
  }
} else {
  const rps = parseFloat(opts.rps ?? process.env.LOAD_TEST_RPS ?? "10");
  if (!Number.isFinite(rps) || rps <= 0) throw new Error(`Bad --rps: ${opts.rps}`);
  if (opts.total) {
    const total = parseInt(opts.total, 10);
    if (!Number.isFinite(total) || total <= 0) throw new Error(`Bad --total: ${opts.total}`);
    stages = [{ rps, total }];
  } else {
    stages = [{ rps, durationMs: parseDuration(opts.duration ?? process.env.LOAD_TEST_DURATION ?? "30s", 30_000) }];
  }
}
const maxRps = Math.max(...stages.map((s) => s.rps));
const concurrency = concurrencyOpt || Math.min(500, Math.max(10, Math.ceil(maxRps)));
const showProgress = !opts["no-report"];

if (opts.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// ---------- stats ----------
const latencies = [];
const statusCounts = new Map();
let sent = 0, ok2xx = 0, failed = 0, timedOut = 0;
const errors = new Map();
let testStart = 0;

function record(status, ms, errName) {
  latencies.push(ms);
  sent++;
  if (status !== null) {
    statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
    if (status >= 200 && status < 300) ok2xx++;
    else failed++;
  } else {
    failed++;
    if (errName === "TimeoutError" || errName === "AbortError") timedOut++;
    errors.set(errName || "Unknown", (errors.get(errName || "Unknown") || 0) + 1);
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function fmtMs(n) {
  if (n < 1000) return `${n.toFixed(1)}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

function snapshot() {
  const s = [...latencies].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    sent, ok2xx, failed, timedOut,
    avg: s.length ? sum / s.length : 0,
    min: s.length ? s[0] : 0,
    max: s.length ? s[s.length - 1] : 0,
    p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99),
  };
}

// ---------- sender with concurrency cap ----------
let inFlight = 0;
let maxInFlightSeen = 0;
const waiters = [];
async function acquire() {
  if (inFlight < concurrency) { inFlight++; maxInFlightSeen = Math.max(maxInFlightSeen, inFlight); return; }
  await new Promise((res) => waiters.push(res));
  inFlight++; maxInFlightSeen = Math.max(maxInFlightSeen, inFlight);
}
function release() {
  inFlight--;
  if (waiters.length) waiters.shift()();
}

let seq = 0;
async function sendOnce() {
  await acquire();
  const mySeq = ++seq;
  const t0 = performance.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: ["GET", "HEAD"].includes(method) ? undefined : bodyFor(mySeq),
      signal: ctrl.signal,
    });
    // Drain body so timing includes full response; ignore parse errors.
    try { await res.arrayBuffer(); } catch { /* ignore */ }
    record(res.status, performance.now() - t0, null);
    return res.status;
  } catch (e) {
    const name = e?.name === "AbortError" ? "TimeoutError" : (e?.name || "FetchError");
    record(null, performance.now() - t0, `${name}${e?.cause?.code ? `(${e.cause.code})` : ""}`);
    return null;
  } finally {
    clearTimeout(t);
    release();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Accurate constant-rate loop: each request i is due at start + i*interval.
async function runStage({ rps, durationMs, total }, stageIdx, stageCount) {
  const count = total ?? Math.max(1, Math.round((rps * durationMs) / 1000));
  const intervalMs = 1000 / rps;
  const label = stageCount > 1 ? ` [stage ${stageIdx + 1}/${stageCount}: ${rps} rps × ${total ? `${count} req` : fmtMs(durationMs)}]` : "";
  console.log(`→ sending ${count} requests @ ${rps} rps (concurrency ≤ ${concurrency})${label}`);
  const t0 = performance.now();
  const pending = [];
  for (let i = 0; i < count; i++) {
    const due = t0 + i * intervalMs;
    const wait = due - performance.now();
    if (wait > 0) await sleep(wait);
    pending.push(sendOnce());
  }
  await Promise.allSettled(pending);
}

// ---------- main ----------
testStart = Date.now();
console.log(`Load test → ${method} ${url}`);
console.log(`Payload: ${payloadTemplate === null ? "(none)" : `${payloadTemplate.length} bytes${payloadFile ? ` (from ${payloadFile})` : ""}`}`);
let progressTimer = null;
if (showProgress) {
  progressTimer = setInterval(() => {
    const s = snapshot();
    const el = ((Date.now() - testStart) / 1000).toFixed(0).padStart(4, " ");
    process.stdout.write(
      `\r[${el}s] sent=${s.sent} ok=${s.ok2xx} fail=${s.failed} ` +
      `avg=${fmtMs(s.avg)} p50=${fmtMs(s.p50)} p95=${fmtMs(s.p95)} p99=${fmtMs(s.p99)} inFlight=${inFlight}   `
    );
  }, 1000);
}

const globalStart = performance.now();
for (let i = 0; i < stages.length; i++) await runStage(stages[i], i, stages.length);
const wallMs = performance.now() - globalStart;
if (progressTimer) { clearInterval(progressTimer); process.stdout.write("\n"); }

const s = snapshot();
const totalPlanned = stages.reduce((a, st) => a + (st.total ?? Math.round((st.rps * st.durationMs) / 1000)), 0);
console.log("\n========== RESULT ==========");
console.log(`URL            : ${method} ${url}`);
console.log(`Requested      : ${totalPlanned}  |  sent: ${s.sent}`);
console.log(`Success (2xx)  : ${s.ok2xx} (${((100 * s.ok2xx) / Math.max(1, s.sent)).toFixed(1)}%)`);
console.log(`Failed         : ${s.failed} (timeouts: ${s.timedOut})`);
console.log(`Wall time      : ${fmtMs(wallMs)}  |  achieved: ${(s.sent / (wallMs / 1000)).toFixed(1)} rps`);
console.log(`Max in-flight  : ${maxInFlightSeen} (cap ${concurrency})`);
console.log(`Latency min/avg: ${fmtMs(s.min)} / ${fmtMs(s.avg)}`);
console.log(`Latency p50/p95: ${fmtMs(s.p50)} / ${fmtMs(s.p95)}`);
console.log(`Latency p99/max: ${fmtMs(s.p99)} / ${fmtMs(s.max)}`);
if (statusCounts.size) {
  console.log(`Status codes   : ${[...statusCounts.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}×${v}`).join(", ")}`);
}
if (errors.size) {
  console.log(`Errors         : ${[...errors.entries()].map(([k, v]) => `${k}×${v}`).join(", ")}`);
}
console.log("============================");
process.exit(s.failed > 0 && s.ok2xx === 0 ? 1 : 0);
