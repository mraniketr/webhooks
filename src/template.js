// Shared subscription templating: variables in URL / headers / JSON body.
//
// Syntax: {{ path }}  e.g. {{ body.user.id }}, {{ headers.x-api-key }},
//   {{ query.token }}, {{ event.id }}, {{ webhook.name }}, {{ method }}, {{ ip }}
// Fallback: {{ body.plan || "free" }}  or  {{ body.nick | "anon" }}
//   (everything after || or | is treated as a literal default, quotes stripped)
//
// Context shape built by buildContext():
//   { body, headers, query, method, ip, event, webhook, pre }
// pre is a key-value object set by the single pre-action
// (the script assigns `pre = { key: value, ... }`).
// Subscriptions access it by key, e.g. {{ pre.userId }} or
// {{ pre.plan || "free" }}.

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

// ---------------------------------------------------------------------------
// Safe pre-action evaluation (no arbitrary JS execution).
//
// Workers on the Free plan cannot eval/new Function or load dynamic code, so
// the pre-action is evaluated as data-mapping statements only:
//
//   pre = { key: value, ... }      (replaces the whole pre object)
//   pre.key = value                (applied in order)
//   pre["key"] = value
//
// Values may be plain literals (lenient JSON: unquoted keys, single quotes,
// trailing commas), {{ }} templates (rendered against the inbound event), or
// simple references like event.payload.userId / body.userId / headers.x-api-key
// / query.token / method / ip. Bare words (e.g. {tag: vip}) are kept as
// strings. Anything else (function calls, operators, loops, fetch, ...) is
// rejected with an explanatory error — never executed.
//
// Returns { pre, error }. On error, pre is {}.
// ---------------------------------------------------------------------------

function stripJsComments(s) {
  let out = "";
  let i = 0;
  const n = s.length;
  let q = null;
  while (i < n) {
    const c = s[i];
    if (q) {
      out += c;
      if (c === "\\" && i + 1 < n) { out += s[i + 1]; i += 2; continue; }
      if (c === q) q = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { q = c; out += c; i++; continue; }
    if (c === "/" && s[i + 1] === "/") {
      while (i < n && s[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      i += 2;
      while (i < n && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function lookupPreRef(token, ctx) {
  const parts = String(token).split(".").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  const root = parts[0];
  const rest = parts.slice(1);
  if (root === "body" || root === "headers" || root === "query" || root === "event" || root === "webhook") {
    return getPath(ctx[root] ?? {}, rest);
  }
  if (root === "payload") {
    // alias for body
    return getPath(ctx.body ?? {}, rest);
  }
  if (root === "method" || root === "ip") {
    return rest.length === 0 ? ctx[root] : undefined;
  }
  return undefined;
}

function coerceTemplateValue(s) {
  if (s === "") return null;
  try { return JSON.parse(s); } catch { return s; }
}

function parseQuoted(st) {
  const t = st.t;
  const q = t[st.i];
  let i = st.i + 1;
  let out = "";
  const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" };
  while (i < t.length) {
    const c = t[i];
    if (c === "\\" && i + 1 < t.length) {
      const e = t[i + 1];
      out += e in escapes ? escapes[e] : e;
      i += 2;
      continue;
    }
    if (c === q) { st.i = i + 1; return { value: out }; }
    out += c;
    i++;
  }
  st.i = i;
  return { value: out }; // unterminated — lenient, take the rest
}

function skipWsSt(st) {
  while (st.i < st.t.length && /\s/.test(st.t[st.i])) st.i++;
}

function parsePreValue(st, ctx) {
  skipWsSt(st);
  const t = st.t;
  const c = t[st.i];
  if (c === undefined) return { error: "Unexpected end of pre-action while reading a value." };
  if (c === "{" && t[st.i + 1] === "{") {
    const end = t.indexOf("}}", st.i + 2);
    if (end === -1) return { error: "Unclosed {{ }} placeholder in pre-action." };
    const expr = t.slice(st.i + 2, end);
    st.i = end + 2;
    return { value: coerceTemplateValue(resolveVariable(expr, ctx)) };
  }
  if (c === "{") return parsePreObject(st, ctx);
  if (c === "[") return parsePreArray(st, ctx);
  if (c === '"' || c === "'" || c === "`") {
    const q = parseQuoted(st);
    return { value: renderString(q.value, ctx) };
  }
  const numMatch = t.slice(st.i).match(/^(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/);
  if (c === "-" || (c >= "0" && c <= "9") || (c === "." && t[st.i + 1] >= "0" && t[st.i + 1] <= "9")) {
    if (!numMatch) return { error: `Could not read a number in pre-action near "${t.slice(st.i, st.i + 12)}".` };
    st.i += numMatch[1].length;
    return { value: Number(numMatch[1]) };
  }
  if (/[A-Za-z_$]/.test(c)) {
    let j = st.i;
    while (j < t.length && /[A-Za-z0-9_$]/.test(t[j])) j++;
    const word = t.slice(st.i, j);
    if (t[j] === "(") {
      return { error: `Function calls like ${word}(...) are not evaluated — use plain values, {{ }} templates, or references like event.payload.x.` };
    }
    // Dotted reference (header names may contain hyphens).
    let k = j;
    const segs = [word];
    while (t[k] === ".") {
      let m = k + 1;
      while (m < t.length && /\s/.test(t[m])) m++;
      let e = m;
      while (e < t.length && /[A-Za-z0-9_$-]/.test(t[e])) e++;
      if (e === m) break;
      segs.push(t.slice(m, e));
      k = e;
    }
    if (segs.length === 1) {
      if (word === "true") { st.i = j; return { value: true }; }
      if (word === "false") { st.i = j; return { value: false }; }
      if (word === "null") { st.i = j; return { value: null }; }
      if (["body", "headers", "query", "event", "webhook", "payload", "method", "ip"].includes(word)) {
        st.i = j;
        const v = lookupPreRef(word, ctx);
        return { value: v === undefined ? null : v };
      }
      // Lenient: other bare words are kept as strings, e.g. {tag: vip}.
      st.i = j;
      return { value: word };
    }
    st.i = k;
    const full = segs.join(".");
    if (!["body", "headers", "query", "event", "webhook", "payload", "method", "ip"].includes(segs[0])) {
      return { error: `Unknown reference "${full}" — use event.payload.x, body.x, headers.x, query.x, method, ip, or quote it as a string.` };
    }
    const v = lookupPreRef(full, ctx);
    return { value: v === undefined ? null : v };
  }
  return { error: `Only plain values, {{ }} templates, or references like event.payload.x are supported in pre-actions (found "${t.slice(st.i, st.i + 12)}").` };
}

function parsePreObject(st, ctx) {
  const obj = {};
  st.i++; // {
  while (true) {
    skipWsSt(st);
    if (st.t[st.i] === "}") { st.i++; return { value: obj }; }
    if (st.i >= st.t.length) return { error: "Unclosed { in pre-action." };
    let key;
    const c = st.t[st.i];
    if (c === '"' || c === "'" || c === "`") {
      key = parseQuoted(st).value;
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = st.i;
      while (j < st.t.length && /[A-Za-z0-9_$-]/.test(st.t[j])) j++;
      key = st.t.slice(st.i, j);
      st.i = j;
    } else {
      return { error: `Expected a key in pre-action object (found "${st.t.slice(st.i, st.i + 12)}").` };
    }
    skipWsSt(st);
    if (st.t[st.i] !== ":") return { error: `Expected ":" after key "${key}" in pre-action.` };
    st.i++;
    const v = parsePreValue(st, ctx);
    if (v.error) return v;
    obj[key] = v.value;
    skipWsSt(st);
    if (st.t[st.i] === ",") { st.i++; continue; }
    if (st.t[st.i] === "}") continue;
    if (st.i >= st.t.length) return { error: "Unclosed { in pre-action." };
    return { error: `Expected "," or "}" in pre-action object (found "${st.t.slice(st.i, st.i + 12)}").` };
  }
}

function parsePreArray(st, ctx) {
  const arr = [];
  st.i++; // [
  while (true) {
    skipWsSt(st);
    if (st.t[st.i] === "]") { st.i++; return { value: arr }; }
    if (st.i >= st.t.length) return { error: "Unclosed [ in pre-action." };
    const v = parsePreValue(st, ctx);
    if (v.error) return v;
    arr.push(v.value);
    skipWsSt(st);
    if (st.t[st.i] === ",") { st.i++; continue; }
    if (st.t[st.i] === "]") continue;
    return { error: `Expected "," or "]" in pre-action array (found "${st.t.slice(st.i, st.i + 12)}").` };
  }
}

function skipQuotedSt(st) {
  const t = st.t;
  const q = t[st.i];
  let i = st.i + 1;
  while (i < t.length) {
    if (t[i] === "\\") { i += 2; continue; }
    if (t[i] === q) { st.i = i + 1; return; }
    i++;
  }
  st.i = i;
}

function setPrePath(pre, keys, value) {
  let cur = pre;
  for (let d = 0; d < keys.length - 1; d++) {
    if (!cur[keys[d]] || typeof cur[keys[d]] !== "object" || Array.isArray(cur[keys[d]])) cur[keys[d]] = {};
    cur = cur[keys[d]];
  }
  cur[keys[keys.length - 1]] = value;
}

function evaluatePreAssignment(code, baseCtx) {
  const text = String(code || "");
  if (!text.trim()) return { pre: {}, error: null };
  const t = stripJsComments(text);
  const st = { t, i: 0 };
  const ctx = baseCtx || {};
  let pre = {};
  let sawPre = false;
  const isIdStart = (c) => /[A-Za-z_$]/.test(c || "");
  const isIdChar = (c) => /[A-Za-z0-9_$]/.test(c || "");
  while (true) {
    while (st.i < t.length && /\s/.test(t[st.i])) st.i++;
    if (st.i >= t.length) break;
    const c = t[st.i];
    if (c === '"' || c === "'" || c === "`") { skipQuotedSt(st); continue; }
    if (c === ";") { st.i++; continue; }
    if (isIdStart(c)) {
      let j = st.i;
      while (j < t.length && isIdChar(t[j])) j++;
      if (t.slice(st.i, j) !== "pre" || (j < t.length && isIdChar(t[j]))) {
        st.i = j;
        continue;
      }
      // Found `pre` — parse optional .key / ["key"] path, then require `=`.
      const save = st.i;
      let k = j;
      const keys = [];
      let ok = true;
      while (true) {
        let m = k;
        while (m < t.length && /\s/.test(t[m])) m++;
        if (t[m] === ".") {
          m++;
          while (m < t.length && /\s/.test(t[m])) m++;
          let e = m;
          while (e < t.length && /[A-Za-z0-9_$-]/.test(t[e])) e++;
          if (e === m) { ok = false; break; }
          keys.push(t.slice(m, e));
          k = e;
        } else if (t[m] === "[") {
          let p = m + 1;
          while (p < t.length && /\s/.test(t[p])) p++;
          const q = t[p];
          if (q !== '"' && q !== "'") { ok = false; break; }
          const qs = { t, i: p };
          const keyVal = parseQuoted(qs).value;
          p = qs.i;
          while (p < t.length && /\s/.test(t[p])) p++;
          if (t[p] !== "]") { ok = false; break; }
          keys.push(keyVal);
          k = p + 1;
        } else {
          break;
        }
      }
      let m = k;
      while (m < t.length && /\s/.test(t[m])) m++;
      if (!ok || t[m] !== "=" || t[m + 1] === "=" || t[m + 1] === ">") {
        st.i = save + 3; // not an assignment (e.g. `pre == x`) — skip past `pre`
        continue;
      }
      st.i = m + 1;
      const v = parsePreValue(st, ctx);
      if (v.error) return { pre: {}, error: v.error };
      if (keys.length === 0) {
        if (!v.value || typeof v.value !== "object" || Array.isArray(v.value)) {
          return { pre: {}, error: "`pre` must be assigned an object, e.g. pre = { key: value }." };
        }
        pre = v.value;
      } else {
        setPrePath(pre, keys, v.value);
      }
      sawPre = true;
      continue;
    }
    st.i++;
  }
  if (!sawPre) {
    if (/\boutput\s*=/.test(t)) {
      return { pre: {}, error: "Found `output = ...` — assign `pre = { key: value }` instead (single pre-action contract)." };
    }
    return { pre: {}, error: "No `pre = { key: value }` assignment found — assign a key-value object to `pre`." };
  }
  return { pre, error: null };
}

// Build the template context from a stored event row + webhook row.
// preOutputs (optional) overrides eventRow.pre_json when provided.
// pre is always a plain key-value object.
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
  let pre = {};
  if (preOutputs !== undefined) {
    pre = (preOutputs && typeof preOutputs === "object" && !Array.isArray(preOutputs)) ? preOutputs : {};
  } else if (eventRow && eventRow.pre_json != null) {
    try {
      const parsed = typeof eventRow.pre_json === "string" ? JSON.parse(eventRow.pre_json) : eventRow.pre_json;
      pre = (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
    } catch { pre = {}; }
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
      payload: body,
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
    { variable: "{{ pre }}", description: "Key-value object set by the pre-action", sample: "" },
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
  const pre = (ctx && ctx.pre) || {};
  if (pre && typeof pre === "object" && !Array.isArray(pre) && Object.keys(pre).length) {
    const paths = [];
    flattenPaths("pre", pre, paths);
    for (const p of paths.slice(0, 40)) {
      if (p === "pre") continue;
      push(`{{ ${p} }}`, "Field set by the pre-action (by key)", getPath({ pre }, p.split(".")));
    }
  } else {
    push("{{ pre.key }}", "Value set by the pre-action (use your key)", "");
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
  evaluatePreAssignment,
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
