// Shared subscription templating: variables in URL / headers / JSON body.
//
// Syntax: {{ path }}  e.g. {{ body.user.id }}, {{ headers.x-api-key }},
//   {{ query.token }}, {{ event.id }}, {{ webhook.name }}, {{ method }}, {{ ip }}
// Fallback: {{ body.plan || "free" }}  or  {{ body.nick | "anon" }}
//   (everything after || or | is treated as a literal default, quotes stripped)
//
// Context shape built by buildContext():
//   { body, headers, query, method, ip, event, webhook, pre }
// pre is an array: pre[i] is the `output` object produced by the i-th
// enabled pre-action (in sort order). Subscriptions access it like any
// other variable, e.g. {{ pre.0.userId }} or {{ pre.0.plan || "free" }}.

function getPath(obj, parts) {
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(p);
      if (!Number.isInteger(i)) return undefined;
      cur = cur[i];
    } else if (typeof cur === "object") {
      // case-insensitive match for header-like objects is handled by caller;
      // here do exact match first, then case-insensitive fallback.
      if (p in cur) cur = cur[p];
      else {
        const lower = p.toLowerCase();
        const key = Object.keys(cur).find((k) => k.toLowerCase() === lower);
        cur = key === undefined ? undefined : cur[key];
      }
    } else {
      return undefined;
    }
  }
  return cur;
}

function resolveVariable(expr, ctx) {
  const raw = String(expr || "").trim();
  if (!raw) return "";
  // Split off default: support "||" or single "|" fallback.
  let path = raw;
  let fallback;
  const orIdx = raw.indexOf("||");
  if (orIdx !== -1) {
    path = raw.slice(0, orIdx).trim();
    fallback = raw.slice(orIdx + 2).trim();
  } else {
    const pipeIdx = raw.indexOf("|");
    if (pipeIdx !== -1) {
      path = raw.slice(0, pipeIdx).trim();
      fallback = raw.slice(pipeIdx + 1).trim();
    }
  }
  if (fallback !== undefined) {
    // strip surrounding quotes, and optional "default:"/"default " prefix
    fallback = fallback.replace(/^default\s*:\s*/i, "").trim();
    const m = fallback.match(/^(['"])(.*)\1$/s);
    if (m) fallback = m[2];
  }
  const parts = path.split(".").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return fallback ?? "";
  const root = parts[0];
  let value;
  if (root === "body" || root === "headers" || root === "query" || root === "event" || root === "webhook" || root === "pre") {
    value = getPath(ctx[root] ?? {}, parts.slice(1));
    // bare {{ body }} / {{ pre }} returns the whole object
    if (parts.length === 1) value = ctx[root];
  } else if (root === "method" || root === "ip") {
    value = parts.length === 1 ? ctx[root] : undefined;
  } else if (root === "payload") {
    // alias for body (back-compat with docs calling it payload)
    value = getPath(ctx.body ?? {}, parts.slice(1));
    if (parts.length === 1) value = ctx.body;
  } else {
    return fallback ?? "";
  }
  if (value === undefined || value === null) return fallback ?? "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function renderString(template, ctx) {
  if (template == null) return "";
  return String(template).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
    try {
      return resolveVariable(expr, ctx);
    } catch {
      return "";
    }
  });
}

function extractPlaceholders(template) {
  const out = [];
  const re = /\{\{\s*([^}]+?)\s*\}\}/g;
  let m;
  while ((m = re.exec(String(template || "")))) {
    const expr = m[1].trim();
    if (expr && !out.includes(expr)) out.push(expr);
  }
  return out;
}

function stringifyForBody(value) {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

// Build the template context from a stored event row + webhook row.
// preOutputs (optional) overrides eventRow.pre_json when provided.
function buildContext(eventRow, webhookRow, preOutputs) {
  let body = null;
  if (eventRow) {
    if (eventRow.payload_json) {
      try { body = JSON.parse(eventRow.payload_json); }
      catch { body = { _raw: eventRow.raw_body ?? eventRow.payload_json }; }
    } else if (eventRow.raw_body) {
      body = { _raw: eventRow.raw_body };
    }
  }
  let headers = {};
  let query = {};
  try { headers = JSON.parse(eventRow?.headers_json || "{}"); } catch { headers = {}; }
  try { query = JSON.parse(eventRow?.query_json || "{}"); } catch { query = {}; }
  let pre = [];
  if (preOutputs !== undefined) {
    pre = Array.isArray(preOutputs) ? preOutputs : [];
  } else if (eventRow && eventRow.pre_json != null) {
    try {
      const parsed = typeof eventRow.pre_json === "string" ? JSON.parse(eventRow.pre_json) : eventRow.pre_json;
      pre = Array.isArray(parsed) ? parsed : [];
    } catch { pre = []; }
  }
  return {
    body,
    headers,
    query,
    method: eventRow?.method || "POST",
    ip: eventRow?.ip || "",
    event: {
      id: eventRow?.id ?? null,
      webhook_id: eventRow?.webhook_id ?? webhookRow?.id ?? null,
      received_at: eventRow?.received_at || null,
    },
    webhook: {
      id: webhookRow?.id ?? eventRow?.webhook_id ?? null,
      name: webhookRow?.name || "",
    },
    pre,
  };
}

// Flatten an object into dot-paths for the variable picker (capped).
function flattenPaths(prefix, value, out, depth = 0) {
  if (out.length > 80 || depth > 4) return;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (!keys.length) {
      out.push(prefix);
      return;
    }
    out.push(prefix);
    for (const k of keys.slice(0, 20)) {
      flattenPaths(`${prefix}.${k}`, value[k], out, depth + 1);
    }
  } else if (Array.isArray(value)) {
    out.push(prefix);
    if (value.length && value[0] !== null && typeof value[0] === "object") {
      flattenPaths(`${prefix}.0`, value[0], out, depth + 1);
    }
  } else {
    out.push(prefix);
  }
}

// Curated variable catalog for the UI: base vars + flattened sample.
function listVariables(ctx) {
  const base = [
    { variable: "{{ method }}", description: "Inbound HTTP method", sample: ctx?.method ?? "POST" },
    { variable: "{{ ip }}", description: "Sender IP", sample: ctx?.ip ?? "" },
    { variable: "{{ event.id }}", description: "Event id", sample: ctx?.event?.id ?? "" },
    { variable: "{{ event.received_at }}", description: "When the event arrived", sample: ctx?.event?.received_at ?? "" },
    { variable: "{{ webhook.id }}", description: "Webhook id", sample: ctx?.webhook?.id ?? "" },
    { variable: "{{ webhook.name }}", description: "Webhook name", sample: ctx?.webhook?.name ?? "" },
    { variable: "{{ body }}", description: "Full parsed body (object or { _raw })", sample: "" },
    { variable: "{{ pre }}", description: "All pre-hook outputs (array)", sample: "" },
  ];
  const dynamic = [];
  const push = (variable, description, sample) => {
    if (dynamic.some((d) => d.variable === variable)) return;
    dynamic.push({ variable, description, sample: sample == null ? "" : typeof sample === "object" ? JSON.stringify(sample).slice(0, 80) : String(sample).slice(0, 80) });
  };
  const headers = (ctx && ctx.headers) || {};
  for (const k of Object.keys(headers).slice(0, 20)) {
    push(`{{ headers.${k} }}`, "Inbound request header", headers[k]);
  }
  const query = (ctx && ctx.query) || {};
  for (const k of Object.keys(query).slice(0, 20)) {
    push(`{{ query.${k} }}`, "Inbound query param", query[k]);
  }
  const bodyPaths = [];
  flattenPaths("body", ctx?.body ?? {}, bodyPaths);
  for (const p of bodyPaths.slice(0, 60)) {
    if (p === "body") continue;
    push(`{{ ${p} }}`, "Field parsed from JSON body", getPath(ctx?.body ?? {}, p.split(".").slice(1)));
  }
  if (ctx?.body && typeof ctx.body === "object" && "_raw" in ctx.body) {
    push("{{ body._raw }}", "Raw body (non-JSON payloads)", ctx.body._raw);
  }
  const pre = (ctx && ctx.pre) || [];
  if (Array.isArray(pre) && pre.length) {
    pre.forEach((entry, i) => {
      push(`{{ pre.${i} }}`, `Output of pre-hook #${i + 1}`, entry);
      const paths = [];
      flattenPaths(`pre.${i}`, entry ?? {}, paths);
      for (const p of paths.slice(0, 20)) {
        if (p === `pre.${i}`) continue;
        push(`{{ ${p} }}`, `Field from pre-hook #${i + 1}`, getPath({ pre }, p.split(".")));
      }
    });
  } else {
    push("{{ pre.0 }}", "Output of first pre-hook (per event)", "");
  }
  return { base, dynamic };
}

function parseHeadersJson(raw) {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k && v !== undefined && v !== null && String(v) !== "") out[String(k).slice(0, 200)] = String(v).slice(0, 2000);
    }
    return out;
  }
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parseHeadersJson(parsed);
  } catch { /* fall through */ }
  return {};
}

// Render a subscription against a context.
// Returns { url, method, headers, bodyText, errors[] }
function renderSubscription(sub, ctx) {
  const errors = [];
  const url = renderString(sub?.target_url || "", ctx).trim();
  if (!url) errors.push("Rendered URL is empty — check variables in target URL.");
  else {
    try {
      const u = new URL(url);
      if (!["http:", "https:"].includes(u.protocol)) errors.push("Rendered URL must be http(s).");
    } catch {
      errors.push("Rendered URL is not a valid absolute URL.");
    }
  }
  const method = String(sub?.http_method || sub?.method || "POST").toUpperCase();
  const allowed = ["POST", "PUT", "PATCH", "DELETE"];
  const finalMethod = allowed.includes(method) ? method : "POST";
  if (!allowed.includes(method)) errors.push(`HTTP method ${method} unsupported, fell back to POST.`);

  const customHeaders = parseHeadersJson(sub?.headers_json ?? sub?.headers);
  const headers = {};
  for (const [k, v] of Object.entries(customHeaders)) {
    headers[k] = renderString(v, ctx);
  }
  const missing = [];
  for (const [k, v] of Object.entries(customHeaders)) {
    for (const ph of extractPlaceholders(v)) {
      if (resolveVariable(ph, ctx) === "") missing.push(`${k}: {{ ${ph} }}`);
    }
  }
  if (missing.length) errors.push(`Empty values for: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`);

  const mode = sub?.payload_mode === "custom" ? "custom" : "passthrough";
  let bodyText = "";
  if (mode === "custom") {
    const tpl = sub?.payload_template ?? "";
    const rendered = renderString(tpl, ctx);
    const trimmed = rendered.trim();
    if (!trimmed) {
      errors.push("Custom payload template rendered empty.");
      bodyText = "";
    } else {
      try {
        JSON.parse(trimmed);
        bodyText = trimmed;
      } catch {
        errors.push("Custom payload is not valid JSON after rendering — sending as text.");
        bodyText = rendered;
      }
    }
  } else {
    bodyText = stringifyForBody(ctx?.body ?? "");
  }
  return { url, method: finalMethod, headers, bodyText, errors };
}

export {
  buildContext,
  extractPlaceholders,
  flattenPaths,
  getPath,
  listVariables,
  parseHeadersJson,
  renderString,
  renderSubscription,
  resolveVariable,
  stringifyForBody,
};
