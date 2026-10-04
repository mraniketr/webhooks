const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let authMode = 'login', currentPage = 'dashboard', currentWebhook = null, user = null;
let editingId = null;
let varCache = { wid: null, variables: null, hasSample: false };
let lastTemplateField = null;

const api = async (path, opts = {}) => {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, ...opts });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
};
function toast(msg, error = false) { const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (error ? ' error' : ''); setTimeout(() => t.className = 'toast', 2400); }
function buildCurl(url) { return `curl -X POST "${url}" -H "Content-Type: application/json" -d '{"hello":"world"}'`; }
async function copyText(text, okMsg) {
  try { if (navigator.clipboard && window.isSecureContext !== false) { await navigator.clipboard.writeText(text); toast(okMsg || 'Copied'); return; } } catch (_) {}
  try {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand('copy'); ta.remove();
    if (ok) { toast(okMsg || 'Copied'); return; }
  } catch (_) {}
  try { window.prompt('Copy manually:', text); } catch (_) { toast('Copy failed', true); }
}
function copyWebhookUrl() { if (!currentWebhook?.url) return toast('No URL yet', true); copyText(currentWebhook.url, 'URL copied'); }
function copyWebhookCurl() { if (!currentWebhook?.url) return toast('No URL yet', true); copyText(buildCurl(currentWebhook.url), 'curl copied'); }
function showPage(page) {
  currentPage = page;
  $$('.page').forEach(x => x.classList.add('hidden'));
  $(`#page-${page}`).classList.remove('hidden');
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  const titles = {
    dashboard: ['Overview', 'Webhook health at a glance'],
    webhooks: ['Webhooks', 'Endpoints and event streams'],
    edit: ['Webhooks', 'Create or edit endpoint'],
  };
  const [eyebrow, title] = titles[page] || titles.webhooks;
  $('#pageEyebrow').textContent = eyebrow;
  $('#pageTitle').textContent = title;
  if (page === 'dashboard') loadDashboard(); else if (page === 'webhooks') loadWebhooks();
  window.scrollTo(0, 0);
}
function showAuth() { $('#authView').classList.remove('hidden'); $('#appView').classList.add('hidden'); }
function showApp() {
  $('#authView').classList.add('hidden'); $('#appView').classList.remove('hidden');
  $('#userName').textContent = user.name; $('#userEmail').textContent = user.email;
  $('#avatar').textContent = user.name?.[0]?.toUpperCase() || 'A';
  showPage('dashboard');
}
async function bootstrap() { try { const d = await api('/api/me'); user = d.user; showApp(); } catch { showAuth(); } }
$$('.tab').forEach(b => b.onclick = () => {
  authMode = b.dataset.auth;
  $$('.tab').forEach(x => x.classList.toggle('active', x === b));
  $('#nameWrap').classList.toggle('hidden', authMode !== 'signup');
  $('#password').autocomplete = authMode === 'signup' ? 'new-password' : 'current-password';
  $('#authSubmit').textContent = authMode === 'signup' ? 'Create account' : 'Login';
});
$('#authForm').onsubmit = async e => {
  e.preventDefault();
  try {
    const d = await api('/api/auth/' + authMode, { method: 'POST', body: JSON.stringify({ name: $('#name').value, email: $('#email').value, password: $('#password').value }) });
    user = d.user; showApp(); toast(authMode === 'signup' ? 'Account created' : 'Welcome back');
  } catch (err) { toast(err.message, true); }
};
$('#logoutBtn').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); user = null; showAuth(); };
$$('[data-page]').forEach(b => b.onclick = () => showPage(b.dataset.page));

function openCreate() {
  editingId = null; varCache = { wid: null, variables: null, hasSample: false };
  $('#editEyebrow').textContent = 'NEW ENDPOINT';
  $('#editTitle').textContent = 'Create webhook';
  $('#webhookSubmit').textContent = 'Create webhook';
  $('#webhookName').value = ''; $('#webhookStatus').value = 'active';
  $('#actionRows').innerHTML = ''; $('#subRows').innerHTML = '';
  $('#actionRows').append(actionRow({ phase: 'pre' }));
  $('#subRows').append(subRow({}));
  showPage('edit');
}
async function openEdit(id) {
  try {
    const d = await api('/api/webhooks/' + id);
    editingId = id; varCache = { wid: null, variables: null, hasSample: false };
    $('#editEyebrow').textContent = 'EDIT ENDPOINT';
    $('#editTitle').textContent = 'Edit webhook';
    $('#webhookSubmit').textContent = 'Save changes';
    $('#webhookName').value = d.webhook.name;
    $('#webhookStatus').value = d.webhook.status || 'active';
    $('#actionRows').innerHTML = ''; $('#subRows').innerHTML = '';
    (d.actions.length ? d.actions : [{}]).forEach(a => $('#actionRows').append(actionRow(a)));
    (d.subscriptions.length ? d.subscriptions : [{}]).forEach(s => $('#subRows').append(subRow(s)));
    showPage('edit');
    loadVariables(id);
  } catch (err) { toast(err.message, true); }
}
function cancelEdit() {
  const id = editingId;
  editingId = null;
  if (id) openWebhook(id); else showPage('webhooks');
}

function actionRow(a = {}) {
  const d = document.createElement('div');
  d.className = 'row-card'; d.dataset.id = a.id || '';
  d.innerHTML = '<div class="row-grid three"><input data-k="name" placeholder="Action name" maxlength="100"/><select data-k="phase"><option value="pre">pre</option><option value="post">post</option></select><select data-k="enabled"><option value="1">enabled</option><option value="0">disabled</option></select></div><textarea data-k="code" placeholder="// event.payload is available"></textarea><div class="row-foot"><span></span><button type="button" class="link-danger">Remove</button></div>';
  d.querySelector('[data-k="name"]').value = a.name || '';
  d.querySelector('[data-k="phase"]').value = a.phase || 'pre';
  d.querySelector('[data-k="enabled"]').value = String(a.enabled ?? 1);
  d.querySelector('[data-k="code"]').value = a.code || '';
  d.querySelector('.link-danger').onclick = () => d.remove();
  return d;
}

function headerEditorRow(k = '', v = '') {
  const r = document.createElement('div');
  r.className = 'hdr-row';
  r.innerHTML = '<input data-hk placeholder="X-Custom-Header"/><input data-hv placeholder="value or {{ body.field }}"/><button type="button" class="link-danger">×</button>';
  r.querySelector('[data-hk]').value = k;
  r.querySelector('[data-hv]').value = v;
  r.querySelector('[data-hk]').addEventListener('focus', e => lastTemplateField = e.target);
  r.querySelector('[data-hv]').addEventListener('focus', e => lastTemplateField = e.target);
  r.querySelector('.link-danger').onclick = () => r.remove();
  return r;
}

function subRow(s = {}) {
  const d = document.createElement('div');
  d.className = 'row-card sub-card'; d.dataset.id = s.id || '';
  const headers = s.headers && typeof s.headers === 'object' ? s.headers
    : (() => { try { return JSON.parse(s.headers_json || '{}'); } catch { return {}; } })();
  d.innerHTML = `
    <div class="row-grid three">
      <input data-k="name" placeholder="Subscription name" maxlength="100"/>
      <select data-k="http_method"><option value="POST">POST</option><option value="PUT">PUT</option><option value="PATCH">PATCH</option><option value="DELETE">DELETE</option></select>
      <select data-k="enabled"><option value="1">enabled</option><option value="0">disabled</option></select>
    </div>
    <input data-k="target_url" placeholder="https://example.com/hooks/{{ body.tenant_id }}?token={{ query.token }}" inputmode="url" class="tpl-field"/>
    <div class="hint">URL supports <code>{{ }}</code> variables — e.g. <code>{{ body.user.id }}</code>, <code>{{ query.token }}</code>, <code>{{ headers.x-tenant }}</code></div>
    <div class="row-grid"><input data-k="secret" type="password" placeholder="Signing secret (optional)" autocomplete="off"/><select data-k="payload_mode"><option value="passthrough">passthrough body</option><option value="custom">custom JSON body</option></select></div>
    <div class="hdr-head"><span>Custom headers <small class="muted">values support {{ }} too</small></span><button type="button" class="ghost sm" data-act="add-hdr">+ Header</button></div>
    <div data-k="headers-box"></div>
    <div data-k="payload-wrap"><textarea data-k="payload_template" class="tpl-field code" placeholder='{\n  "userId": "{{ body.user.id }}",\n  "plan": "{{ body.plan || \\"free\\" }}"\n}'></textarea>
    <div class="hint">Custom JSON body with variables. Choose <b>passthrough</b> to forward the event body unchanged.</div></div>
    <div class="sub-tools"><button type="button" class="ghost sm" data-act="vars">Variables</button><button type="button" class="ghost sm" data-act="preview">Preview render</button><span class="muted">${s.has_secret ? 'Has signing secret — leave blank to keep' : ''}</span><button type="button" class="link-danger" data-act="remove">Remove</button></div>
    <div class="var-panel hidden" data-k="var-panel"></div>
    <div class="preview-box hidden" data-k="preview-box"></div>`;
  d.querySelector('[data-k="name"]').value = s.name || '';
  d.querySelector('[data-k="http_method"]').value = s.http_method || s.method || 'POST';
  d.querySelector('[data-k="enabled"]').value = String(s.enabled ?? 1);
  d.querySelector('[data-k="target_url"]').value = s.target_url || '';
  d.querySelector('[data-k="secret"]').value = '';
  d.querySelector('[data-k="payload_mode"]').value = s.payload_mode || 'passthrough';
  d.querySelector('[data-k="payload_template"]').value = s.payload_template || '';
  const box = d.querySelector('[data-k="headers-box"]');
  const entries = Object.entries(headers || {});
  (entries.length ? entries : [['', '']]).forEach(([k, v]) => box.append(headerEditorRow(k, v)));
  const syncMode = () => { d.querySelector('[data-k="payload-wrap"]').style.display = d.querySelector('[data-k="payload_mode"]').value === 'custom' ? '' : 'none'; };
  d.querySelector('[data-k="payload_mode"]').onchange = syncMode; syncMode();
  d.querySelectorAll('.tpl-field').forEach(el => el.addEventListener('focus', e => lastTemplateField = e.target));
  d.querySelector('[data-act="add-hdr"]').onclick = () => box.append(headerEditorRow('', ''));
  d.querySelector('[data-act="remove"]').onclick = () => d.remove();
  d.querySelector('[data-act="vars"]').onclick = () => toggleVarPanel(d);
  d.querySelector('[data-act="preview"]').onclick = () => previewSubscription(d);
  return d;
}

async function loadVariables(wid) {
  try {
    const d = await api('/api/webhooks/' + wid + '/context');
    varCache = { wid, variables: d.variables, hasSample: d.hasSample };
  } catch { varCache = { wid, variables: fallbackVariables(), hasSample: false }; }
}

function fallbackVariables() {
  return {
    base: [
      { variable: '{{ method }}', description: 'Inbound HTTP method' },
      { variable: '{{ ip }}', description: 'Sender IP' },
      { variable: '{{ event.id }}', description: 'Event id' },
      { variable: '{{ webhook.name }}', description: 'Webhook name' },
      { variable: '{{ body }}', description: 'Full parsed body' },
    ],
    dynamic: [
      { variable: '{{ body.user.id }}', description: 'Field from JSON body' },
      { variable: '{{ headers.x-api-key }}', description: 'Inbound request header' },
      { variable: '{{ query.token }}', description: 'Inbound query param' },
    ],
  };
}

function toggleVarPanel(card) {
  const panel = card.querySelector('[data-k="var-panel"]');
  const vars = varCache.variables || fallbackVariables();
  if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
  const group = (title, items) => items?.length
    ? `<div class="var-group"><div class="var-title">${title}</div>${items.map(v => `<button type="button" class="var-pill" data-var="${esc(v.variable)}" title="${esc(v.description || '')}${v.sample ? ' — e.g. ' + esc(String(v.sample)) : ''}">${esc(v.variable)}</button>`).join('')}</div>`
    : '';
  panel.innerHTML = `<div class="var-help">Click a variable to insert it into the last-focused URL / header / JSON field. Fallbacks: <code>{{ body.plan || "free" }}</code></div>`
    + `<div class="var-note muted">${varCache.hasSample ? 'Values below come from your latest event.' : 'No events yet — showing example fields. Send a test event to see real body / header / query names.'}</div>`
    + group('Always available', vars.base) + group('From latest event', vars.dynamic);
  panel.classList.remove('hidden');
  panel.querySelectorAll('.var-pill').forEach(b => b.onclick = () => {
    const v = b.dataset.var;
    if (lastTemplateField && card.contains(lastTemplateField)) {
      const el = lastTemplateField;
      const start = el.selectionStart ?? el.value.length;
      el.value = el.value.slice(0, start) + v + el.value.slice(el.selectionEnd ?? start);
      el.focus();
    } else {
      copyText(v, 'Variable copied');
    }
  });
}

function collectSub(card) {
  const g = k => card.querySelector('[data-k="' + k + '"]').value;
  const headers = {};
  card.querySelectorAll('.hdr-row').forEach(r => {
    const k = r.querySelector('[data-hk]').value.trim();
    const v = r.querySelector('[data-hv]').value;
    if (k) headers[k] = v;
  });
  const mode = card.querySelector('[data-k="payload_mode"]').value === 'custom' ? 'custom' : 'passthrough';
  return {
    id: card.dataset.id || undefined,
    name: g('name').trim(),
    enabled: g('enabled') !== '0',
    http_method: card.querySelector('[data-k="http_method"]').value,
    target_url: g('target_url').trim(),
    secret: g('secret'),
    headers,
    payload_mode: mode,
    payload_template: mode === 'custom' ? card.querySelector('[data-k="payload_template"]').value : undefined,
  };
}

function collect(box, kind) {
  return [...box.children].map(c => {
    if (kind === 'sub') return collectSub(c);
    const g = k => c.querySelector('[data-k="' + k + '"]').value;
    return { id: c.dataset.id || undefined, name: g('name').trim(), enabled: g('enabled') !== '0', phase: g('phase'), code: g('code') };
  }).filter(kind === 'action' ? o => o.code.trim() : o => o.target_url);
}

async function previewSubscription(card) {
  const box = card.querySelector('[data-k="preview-box"]');
  box.classList.remove('hidden');
  box.innerHTML = '<div class="muted">Rendering…</div>';
  const sub = collectSub(card);
  if (!sub.target_url) { box.innerHTML = '<div class="preview-err">Enter a target URL first.</div>'; return; }
  if (!editingId) {
    box.innerHTML = '<div class="muted">Save the webhook first, then preview renders against the latest event. URL / header <code>{{ }}</code> variables will be resolved per event at delivery time.</div>';
    return;
  }
  try {
    const d = await api('/api/webhooks/' + editingId + '/subscriptions/preview', { method: 'POST', body: JSON.stringify({ subscription: sub }) });
    const r = d.rendered;
    box.innerHTML = `${r.errors?.length ? `<div class="preview-err">${r.errors.map(esc).join('<br/>')}</div>` : '<div class="preview-ok">Rendered OK</div>'}`
      + `<div class="preview-grid"><div><span>METHOD</span><code>${esc(r.method)}</code></div><div><span>URL</span><code>${esc(r.url)}</code></div></div>`
      + `${Object.keys(r.headers || {}).length ? `<div><span>HEADERS</span><pre>${esc(JSON.stringify(r.headers, null, 2))}</pre></div>` : '<div class="muted">No custom headers.</div>'}`
      + `<div><span>BODY</span><pre>${esc((r.bodyText || '').slice(0, 2000))}</pre></div>`;
  } catch (err) { box.innerHTML = `<div class="preview-err">${esc(err.message)}</div>`; }
}

['#newWebhookBtn', '#newWebhookBtn2', '#newWebhookBtn3'].forEach(id => { const e = $(id); if (e) e.onclick = openCreate; });
$('#addActionBtn').onclick = () => $('#actionRows').append(actionRow({}));
$('#addSubBtn').onclick = () => $('#subRows').append(subRow({}));
$('#cancelEdit').onclick = cancelEdit;
$('#backToWebhooks').onclick = cancelEdit;
$('#closeEventModal').onclick = () => $('#eventModal').classList.add('hidden');
$('#webhookForm').onsubmit = async e => {
  e.preventDefault();
  const body = { name: $('#webhookName').value.trim(), status: $('#webhookStatus').value, actions: collect($('#actionRows'), 'action'), subscriptions: collect($('#subRows'), 'sub') };
  try {
    if (editingId) {
      const d = await api('/api/webhooks/' + editingId, { method: 'PUT', body: JSON.stringify(body) });
      toast('Webhook updated'); openWebhook(d.webhook.id);
    } else {
      const d = await api('/api/webhooks', { method: 'POST', body: JSON.stringify(body) });
      toast('Webhook created'); showPage('webhooks'); openWebhook(d.webhook.id);
    }
  } catch (err) { toast(err.message, true); }
};
function renderStats(s) {
  $('#statsGrid').innerHTML = [['Events', s.total || 0, 'All accepted deliveries'], ['Processed', s.processed || 0, 'Completed by worker'], ['Pending', s.pending || 0, 'Queued or in flight'], ['Failed', s.failed || 0, 'Needs attention']].map(([l, v, sub]) => `<div class="stat"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${sub}</div></div>`).join('');
}
async function loadDashboard() {
  try {
    const d = await api('/api/dashboard');
    renderStats(d.stats);
    $('#recentEvents').innerHTML = d.recent?.length ? `<table class="table"><thead><tr><th>ID</th><th>Webhook</th><th>Status</th><th>Received</th></tr></thead><tbody>${d.recent.map(x => `<tr class="clickable" onclick="viewEvent(${x.id})"><td class="mono">#${x.id}</td><td>${x.webhook_name}</td><td><span class="badge ${x.status}">${x.status}</span></td><td>${new Date(x.received_at).toLocaleString()}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No events yet. Send a POST to one of your webhook URLs.</div>';
    $('#dashboardWebhooks').innerHTML = d.webhooks?.length ? `<div class="hook-list">${d.webhooks.slice(0, 6).map(w => `<div class="hook-row"><div><strong>${esc(w.name)}</strong><small>${w.events || 0} events · ${w.status}</small></div><button class="ghost" onclick="openWebhook(${w.id})">Open</button></div>`).join('')}</div>` : '<div class="empty">Create your first webhook.</div>';
  } catch (err) { toast(err.message, true); }
}
async function loadWebhooks() {
  try {
    const d = await api('/api/webhooks');
    $('#webhooksTable').innerHTML = d.webhooks?.length ? `<table class="table"><thead><tr><th>Name</th><th>Endpoint</th><th>Events</th><th>Status</th><th></th></tr></thead><tbody>${d.webhooks.map(w => `<tr><td><strong>${esc(w.name)}</strong></td><td class="mono">/webhooks/${w.token.slice(0, 12)}…</td><td>${w.events || 0}</td><td><span class="badge processed">active</span></td><td><button class="ghost" onclick="openWebhook(${w.id})">Inspect</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No webhooks yet.</div>';
  } catch (err) { toast(err.message, true); }
}
async function openWebhook(id) {
  showPage('webhooks');
  try {
    const d = await api('/api/webhooks/' + id);
    currentWebhook = d.webhook;
    const e = await api(`/api/webhooks/${id}/events?limit=25&offset=0`);
    $('#webhookDetail').classList.remove('hidden');
    $('#webhookDetail').innerHTML = `<div class="detail-title"><div><div class="eyebrow">WEBHOOK</div><h3>${esc(currentWebhook.name)}</h3><div class="url-box"><code>${esc(currentWebhook.url)}</code><button type="button" class="ghost" onclick="copyWebhookUrl()">Copy URL</button></div><div class="curl-box"><div class="curl-head"><span>Test with curl</span><button type="button" class="ghost sm" onclick="copyWebhookCurl()">Copy curl</button></div><pre class="curl-code"><code>${esc(buildCurl(currentWebhook.url))}</code></pre></div></div><div style="display:flex;gap:8px"><button class="ghost" onclick="openEdit(${id})">Edit</button><button class="ghost" onclick="$('#webhookDetail').classList.add('hidden')">Close</button></div></div>`
      + `<div class="detail-stats">${[['Total', d.stats.total || 0], ['Processed', d.stats.processed || 0], ['Pending', d.stats.pending || 0], ['Failed', d.stats.failed || 0]].map(x => `<div class="detail-stat"><div class="n">${x[1]}</div><div class="l">${x[0]}</div></div>`).join('')}</div>`
      + `<div class="panel-head"><div><h3>Actions</h3><p>Executed by the background worker.</p></div><span class="count-pill">${d.actions.length}</span></div><div class="action-list">${d.actions.length ? d.actions.map(a => `<div class="action-item"><strong>${esc(a.name)}</strong><small>${a.phase} · ${a.enabled ? 'enabled' : 'disabled'}</small><pre>${esc(a.code)}</pre></div>`).join('') : '<div class="empty">No custom scripts configured.</div>'}</div>`
      + `<div class="panel-head" style="margin-top:18px"><div><h3>Subscriptions</h3><p>Templated forwards — URL, headers and JSON body render per event.</p></div><span class="count-pill">${d.subscriptions.length}</span></div><div class="action-list">${d.subscriptions.length ? d.subscriptions.map(s => `<div class="action-item"><strong>${esc(s.name)}</strong><small class="mono">${esc(s.http_method || 'POST')} ${esc(s.target_url)}</small><small>${s.enabled ? 'enabled' : 'disabled'} · ${s.payload_mode === 'custom' ? 'custom JSON' : 'passthrough'}${s.has_secret ? ' · signed' : ''}${s.headers && Object.keys(s.headers).length ? ` · ${Object.keys(s.headers).length} header${Object.keys(s.headers).length === 1 ? '' : 's'}` : ''}</small>${s.payload_mode === 'custom' && s.payload_template ? `<pre>${esc(s.payload_template)}</pre>` : ''}</div>`).join('') : '<div class="empty">No subscriptions — events are stored and processed only.</div>'}</div>`
      + `<div class="panel-head" style="margin-top:18px"><div><h3>Events</h3><p>${e.total} total events</p></div></div><div class="table-wrap"><table class="table"><thead><tr><th>ID</th><th>Method</th><th>Status</th><th>Received</th><th>IP</th></tr></thead><tbody>${e.events.map(x => `<tr class="clickable" onclick="viewEvent(${x.id})"><td class="mono">#${x.id}</td><td>${x.method}</td><td><span class="badge ${x.status}">${x.status}</span></td><td>${new Date(x.received_at).toLocaleString()}</td><td class="mono">${esc(x.ip || '—')}</td></tr>`).join('')}</tbody></table></div>`;
  } catch (err) { toast(err.message, true); }
}
async function viewEvent(id) {
  try {
    const d = await api('/api/events/' + id);
    $('#eventTitle').textContent = `Event #${id} · ${d.event.status}`;
    const e = { ...d.event }; delete e.headers_json; delete e.payload_json; delete e.raw_body; delete e.query_json;
    $('#eventJson').textContent = JSON.stringify({ id: e.id, webhook: e.webhook_name, status: e.status, receivedAt: e.received_at, processedAt: e.processed_at, ip: e.ip, headers: d.event.headers, query: d.event.query, payload: d.event.payload, error: e.error }, null, 2);
    const dl = d.deliveries || [];
    $('#eventDeliveries').innerHTML = dl.length ? `<div class="panel-head" style="margin-top:14px"><div><h3>Deliveries</h3><p>${dl.length} subscription attempt${dl.length === 1 ? '' : 's'}</p></div></div><table class="table"><thead><tr><th>Target</th><th>Status</th><th>HTTP</th><th>Attempts</th><th>Error</th></tr></thead><tbody>${dl.map(x => `<tr><td><strong>${esc(x.subscription_name || '—')}</strong><br/><small class="mono">${esc(x.target_url)}</small></td><td><span class="badge ${x.status === 'success' ? 'processed' : 'failed'}">${x.status}</span></td><td class="mono">${x.http_status ?? '—'}</td><td class="mono">${x.attempts}</td><td><small>${esc(x.error || '—')}</small></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No subscription deliveries for this event.</div>';
    $('#eventModal').classList.remove('hidden');
  } catch (err) { toast(err.message, true); }
}
function esc(s) { return String(s ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
window.openWebhook = openWebhook; window.openEdit = openEdit; window.viewEvent = viewEvent;
window.toast = toast; window.copyWebhookUrl = copyWebhookUrl; window.copyWebhookCurl = copyWebhookCurl;
window.copyText = copyText; window.buildCurl = buildCurl;
bootstrap();
