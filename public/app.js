const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let authMode = 'login', currentPage = 'dashboard', currentWebhook = null, user = null;
let editingId = null;
let editingPre = null;
let editingSubs = [];
let editingSubIndex = null; // null | number ('new' uses -1)
let varCache = { wid: null, variables: null, hasSample: false };
let lastTemplateField = null;
let currentDetailId = null;

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
  const navFor = ['detail', 'edit', 'subedit', 'preedit'].includes(page) ? 'webhooks' : page;
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === navFor));
  const titles = {
    dashboard: ['Overview', 'Webhook health at a glance'],
    webhooks: ['Webhooks', 'All Webhooks'],
    detail: ['All Webhooks', 'Webhook details'],
    edit: ['All Webhooks', 'Create or edit endpoint'],
    subedit: ['All Webhooks', 'Edit one subscription'],
    preedit: ['All Webhooks', 'Edit pre-action'],
  };
  const [eyebrow, title] = titles[page] || titles.webhooks;
  $('#pageEyebrow').textContent = eyebrow;
  $('#pageTitle').textContent = title;
  const newBtn = $('#newWebhookBtn');
  if (newBtn) newBtn.classList.toggle('hidden', page !== 'webhooks');
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
async function bootstrap() {
  try {
    const q = new URLSearchParams(location.search);
    const ssoError = q.get('sso_error');
    if (ssoError) {
      history.replaceState(null, '', location.pathname);
      setTimeout(() => toast(ssoError, true), 50);
    }
  } catch {}
  try { const cfg = await api('/api/auth/config'); const w = $('#ssoWrap'); if (w && cfg.googleEnabled) w.classList.remove('hidden'); } catch {}
  try { const d = await api('/api/me'); user = d.user; showApp(); } catch { showAuth(); }
}
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

function normalizePreForEditor(a = {}) {
  return {
    id: a.id || undefined,
    name: a.name || '',
    enabled: (a.enabled ?? 1) ? 1 : 0,
    code: a.code || '',
  };
}
function normalizeSubForEditor(s = {}) {
  let headers = s.headers && typeof s.headers === 'object' ? s.headers
    : (() => { try { return JSON.parse(s.headers_json || '{}'); } catch { return {}; } })();
  return {
    id: s.id || undefined,
    name: s.name || '',
    http_method: s.http_method || s.method || 'POST',
    enabled: (s.enabled ?? 1) ? 1 : 0,
    target_url: s.target_url || '',
    secret: '',
    has_secret: s.has_secret ? 1 : 0,
    headers: headers || {},
    payload_mode: s.payload_mode || 'passthrough',
    payload_template: s.payload_template || '',
  };
}
function openCreate() {
  editingId = null; varCache = { wid: null, variables: null, hasSample: false };
  editingPre = normalizePreForEditor({}); editingSubs = []; editingSubIndex = null;
  $('#editEyebrow').textContent = 'NEW ENDPOINT';
  $('#editTitle').textContent = 'Create webhook';
  $('#webhookSubmit').textContent = 'Create webhook';
  $('#webhookName').value = ''; $('#webhookStatus').value = 'active';
  renderPreSummary();
  renderSubList();
  showPage('edit');
}
async function openEdit(id) {
  try {
    const d = await api('/api/webhooks/' + id);
    editingId = id; varCache = { wid: null, variables: null, hasSample: false };
    editingSubIndex = null;
    $('#editEyebrow').textContent = 'EDIT ENDPOINT';
    $('#editTitle').textContent = 'Edit webhook';
    $('#webhookSubmit').textContent = 'Save changes';
    $('#webhookName').value = d.webhook.name;
    $('#webhookStatus').value = d.webhook.status || 'active';
    editingPre = normalizePreForEditor(d.actions[0] || {});
    renderPreSummary();
    editingSubs = (d.subscriptions || []).map(normalizeSubForEditor);
    renderSubList();
    showPage('edit');
    loadVariables(id);
  } catch (err) { toast(err.message, true); }
}
function cancelEdit() {
  const id = editingId;
  editingId = null;
  if (id) openWebhook(id); else showPage('webhooks');
}

function renderPreSummary() {
  const box = $('#preSummary');
  if (!box) return;
  const p = editingPre || {};
  if (!p.code || !String(p.code).trim()) {
    box.innerHTML = '<div class="empty">No pre-action yet. Edit it to set a <code>pre</code> key-value object for subscriptions.</div>';
    return;
  }
  const preview = String(p.code).slice(0, 220);
  box.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'hook-row sub-list-row';
  row.innerHTML = `<div><strong>${esc(p.name || 'Pre-action')}</strong>`
    + `<small class="mono">${esc(preview)}${String(p.code).length > 220 ? '…' : ''}</small>`
    + `<small>${p.enabled ? 'enabled' : 'disabled'} · sets <code>pre</code> object, subscriptions use <code>{{ pre.key }}</code></small></div>`
    + `<div style="display:flex;gap:8px"><button type="button" class="ghost sm">Edit</button></div>`;
  row.querySelector('button').onclick = () => openPreEditor();
  box.append(row);
}

function openPreEditor() {
  const p = editingPre || normalizePreForEditor({});
  $('#preName').value = p.name || '';
  $('#preEnabled').value = String(p.enabled ?? 1);
  $('#preCode').value = p.code || '';
  showPage('preedit');
}

function closePreEditor() {
  showPage('edit');
}

function collectPreEditor() {
  const prev = editingPre || {};
  return {
    id: prev.id || undefined,
    name: $('#preName').value.trim(),
    enabled: $('#preEnabled').value !== '0' ? 1 : 0,
    code: $('#preCode').value,
  };
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

function renderSubList() {
  const box = $('#subList');
  if (!editingSubs.length) {
    box.innerHTML = '<div class="empty">No subscriptions yet. Add one to start forwarding events.</div>';
    return;
  }
  box.innerHTML = '';
  editingSubs.forEach((s, i) => {
    const hdrCount = s.headers ? Object.keys(s.headers).length : 0;
    const row = document.createElement('div');
    row.className = 'hook-row sub-list-row';
    row.innerHTML = `<div><strong>${esc(s.name || s.target_url || 'Untitled subscription')}</strong>`
      + `<small class="mono">${esc(s.http_method || 'POST')} ${esc(s.target_url || '—')}</small>`
      + `<small>${s.enabled ? 'enabled' : 'disabled'} · ${s.payload_mode === 'custom' ? 'custom JSON' : 'passthrough'}${s.has_secret ? ' · signed' : ''}${hdrCount ? ` · ${hdrCount} header${hdrCount === 1 ? '' : 's'}` : ''}</small></div>`
      + `<div style="display:flex;gap:8px"><button type="button" class="ghost sm">Edit</button></div>`;
    row.querySelector('button').onclick = () => openSubEditor(i);
    box.append(row);
  });
}

function syncSubPayloadMode() {
  $('#subPayloadWrap').style.display = $('#subPayloadMode').value === 'custom' ? '' : 'none';
}

function openSubEditor(index) {
  editingSubIndex = index;
  const isNew = index === -1;
  const s = isNew ? normalizeSubForEditor({}) : editingSubs[index];
  if (!s) return;
  $('#subEditEyebrow').textContent = isNew ? 'NEW SUBSCRIPTION' : 'EDIT SUBSCRIPTION';
  $('#subEditTitle').textContent = isNew ? 'Add subscription' : (s.name || 'Edit subscription');
  $('#subEditSub').textContent = isNew
    ? 'Configure one subscription. It is added to the list when you save.'
    : 'Edit one subscription. Nothing else changes until you save.';
  $('#subSaveBtn').textContent = isNew ? 'Add subscription' : 'Save subscription';
  $('#subName').value = s.name || '';
  $('#subMethod').value = s.http_method || 'POST';
  $('#subEnabled').value = String(s.enabled ?? 1);
  $('#subPayloadMode').value = s.payload_mode || 'passthrough';
  $('#subTargetUrl').value = s.target_url || '';
  $('#subSecret').value = '';
  $('#subSecretHint').textContent = s.has_secret ? 'has secret — leave blank to keep' : 'optional';
  $('#subPayloadTemplate').value = s.payload_template || '';
  const hb = $('#subHeadersBox');
  hb.innerHTML = '';
  const entries = Object.entries(s.headers || {});
  (entries.length ? entries : [['', '']]).forEach(([k, v]) => hb.append(headerEditorRow(k, v)));
  syncSubPayloadMode();
  $('#subVarPanel').classList.add('hidden');
  $('#subPreviewBox').classList.add('hidden');
  $('#subPreviewBox').innerHTML = '';
  showPage('subedit');
}

function closeSubEditor() {
  editingSubIndex = null;
  showPage('edit');
}

function collectSubEditor() {
  const headers = {};
  document.querySelectorAll('#subHeadersBox .hdr-row').forEach(r => {
    const k = r.querySelector('[data-hk]').value.trim();
    const v = r.querySelector('[data-hv]').value;
    if (k) headers[k] = v;
  });
  const mode = $('#subPayloadMode').value === 'custom' ? 'custom' : 'passthrough';
  const prev = editingSubIndex !== -1 && editingSubs[editingSubIndex] ? editingSubs[editingSubIndex] : {};
  return {
    id: prev.id || undefined,
    name: $('#subName').value.trim() || $('#subTargetUrl').value.trim(),
    http_method: $('#subMethod').value,
    enabled: $('#subEnabled').value !== '0' ? 1 : 0,
    target_url: $('#subTargetUrl').value.trim(),
    secret: $('#subSecret').value,
    has_secret: prev.has_secret || 0,
    headers,
    payload_mode: mode,
    payload_template: mode === 'custom' ? $('#subPayloadTemplate').value : '',
  };
}

function subToApi(s) {
  return {
    id: s.id || undefined,
    name: s.name,
    enabled: s.enabled ? true : s.enabled !== 0,
    http_method: s.http_method,
    target_url: s.target_url,
    secret: s.secret || '',
    headers: s.headers || {},
    payload_mode: s.payload_mode,
    payload_template: s.payload_mode === 'custom' ? (s.payload_template || '') : undefined,
  };
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
      { variable: '{{ pre }}', description: 'Key-value object set by the pre-action' },
    ],
    dynamic: [
      { variable: '{{ body.user.id }}', description: 'Field from JSON body' },
      { variable: '{{ headers.x-api-key }}', description: 'Inbound request header' },
      { variable: '{{ query.token }}', description: 'Inbound query param' },
      { variable: '{{ pre.key }}', description: 'Value set by the pre-action (use your key)' },
    ],
  };
}

function toggleSubVarPanel() {
  const panel = $('#subVarPanel');
  const vars = varCache.variables || fallbackVariables();
  if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
  const group = (title, items) => items?.length
    ? `<div class="var-group"><div class="var-title">${title}</div>${items.map(v => `<button type="button" class="var-pill" data-var="${esc(v.variable)}" title="${esc(v.description || '')}${v.sample ? ' — e.g. ' + esc(String(v.sample)) : ''}">${esc(v.variable)}</button>`).join('')}</div>`
    : '';
  panel.innerHTML = `<div class="var-help">Click a variable to insert it into the last-focused URL / header / JSON field. Fallbacks: <code>{{ body.plan || "free" }}</code></div>`
    + `<div class="var-note muted">Showing sample fields — per-event payloads are not stored. Variables resolve per event at delivery time.</div>`
    + group('Always available', vars.base) + group('From latest event', vars.dynamic);
  panel.classList.remove('hidden');
  panel.querySelectorAll('.var-pill').forEach(b => b.onclick = () => {
    const v = b.dataset.var;
    const scope = $('#page-subedit');
    if (lastTemplateField && scope.contains(lastTemplateField)) {
      const el = lastTemplateField;
      const start = el.selectionStart ?? el.value.length;
      el.value = el.value.slice(0, start) + v + el.value.slice(el.selectionEnd ?? start);
      el.focus();
    } else {
      copyText(v, 'Variable copied');
    }
  });
}

function collectActions() {
  // Single pre-action only, held in editingPre state (edited on page-preedit).
  const p = editingPre || {};
  if (!p.code || !String(p.code).trim()) return [];
  return [{ id: p.id || undefined, name: (p.name || '').trim(), enabled: p.enabled !== 0, phase: 'pre', code: p.code }];
}

async function previewSingleSubscription() {
  const box = $('#subPreviewBox');
  box.classList.remove('hidden');
  box.innerHTML = '<div class="muted">Rendering…</div>';
  const sub = collectSubEditor();
  if (!sub.target_url) { box.innerHTML = '<div class="preview-err">Enter a target URL first.</div>'; return; }
  if (!editingId) {
    box.innerHTML = '<div class="muted">Save the webhook first, then preview renders against the latest event. URL / header <code>{{ }}</code> variables will be resolved per event at delivery time.</div>';
    return;
  }
  try {
    const d = await api('/api/webhooks/' + editingId + '/subscriptions/preview', { method: 'POST', body: JSON.stringify({ subscription: subToApi(sub) }) });
    const r = d.rendered;
    box.innerHTML = `${d.preError ? `<div class="preview-err">Pre-action: ${esc(d.preError)}</div>` : ''}`
      + `${r.errors?.length ? `<div class="preview-err">${r.errors.map(esc).join('<br/>')}</div>` : '<div class="preview-ok">Rendered OK</div>'}`
      + `<div class="preview-grid"><div><span>METHOD</span><code>${esc(r.method)}</code></div><div><span>URL</span><code>${esc(r.url)}</code></div></div>`
      + `${Object.keys(r.headers || {}).length ? `<div><span>HEADERS</span><pre>${esc(JSON.stringify(r.headers, null, 2))}</pre></div>` : '<div class="muted">No custom headers.</div>'}`
      + `<div><span>BODY</span><pre>${esc((r.bodyText || '').slice(0, 2000))}</pre></div>`;
  } catch (err) { box.innerHTML = `<div class="preview-err">${esc(err.message)}</div>`; }
}

async function persistSubscriptionsAfterSubSave() {
  // One-by-one UX with immediate persistence for existing webhooks.
  // Include current name/status/actions so unsaved edits elsewhere aren't lost.
  if (!editingId) return null;
  const payload = {
    name: $('#webhookName').value.trim() || undefined,
    status: $('#webhookStatus').value,
    actions: collectActions(),
    subscriptions: editingSubs.filter(s => s.target_url).map(subToApi),
  };
  return api('/api/webhooks/' + editingId, { method: 'PUT', body: JSON.stringify(payload) });
}

['#newWebhookBtn', '#newWebhookBtn2'].forEach(id => { const e = $(id); if (e) e.onclick = openCreate; });
const preEditBtn = $('#preEditBtn'); if (preEditBtn) preEditBtn.onclick = () => openPreEditor();
const backToEditFromPre = $('#backToEditFromPre'); if (backToEditFromPre) backToEditFromPre.onclick = closePreEditor;
const cancelPreEdit = $('#cancelPreEdit'); if (cancelPreEdit) cancelPreEdit.onclick = closePreEditor;
$('#addSubBtn').onclick = () => openSubEditor(-1);
$('#cancelEdit').onclick = cancelEdit;
$('#backToWebhooks').onclick = cancelEdit;
$('#backToEdit').onclick = closeSubEditor;
$('#cancelSubEdit').onclick = closeSubEditor;
$('#backToListBtn').onclick = () => showPage('webhooks');
$('#detailEditBtn').onclick = () => { if (currentDetailId) openEdit(currentDetailId); };
$('#subAddHdr').onclick = () => $('#subHeadersBox').append(headerEditorRow('', ''));
$('#subPayloadMode').onchange = syncSubPayloadMode;
$('#subVarsBtn').onclick = toggleSubVarPanel;
$('#subPreviewBtn').onclick = previewSingleSubscription;
['#subTargetUrl', '#subPayloadTemplate'].forEach(id => { const el = $(id); if (el) el.addEventListener('focus', e => lastTemplateField = e.target); });
$('#subEditForm').onsubmit = async e => {
  e.preventDefault();
  const draft = collectSubEditor();
  if (!draft.target_url) { toast('Target URL is required', true); return; }
  try {
    if (editingSubIndex === -1) {
      editingSubs.push({ ...draft, secret: draft.secret || '', has_secret: draft.secret ? 1 : 0 });
    } else {
      const prev = editingSubs[editingSubIndex] || {};
      editingSubs[editingSubIndex] = { ...draft, id: prev.id, has_secret: draft.secret ? 1 : (prev.has_secret || 0) };
    }
    if (editingId) {
      const saved = await persistSubscriptionsAfterSubSave();
      if (saved?.subscriptions) editingSubs = saved.subscriptions.map(normalizeSubForEditor);
      toast(editingSubIndex === -1 ? 'Subscription added' : 'Subscription saved');
    } else {
      toast(editingSubIndex === -1 ? 'Subscription added — save webhook to create' : 'Subscription updated');
    }
    editingSubIndex = null;
    renderSubList();
    showPage('edit');
  } catch (err) { toast(err.message, true); }
};
const preEditForm = $('#preEditForm');
if (preEditForm) preEditForm.onsubmit = async e => {
  e.preventDefault();
  const draft = collectPreEditor();
  editingPre = { ...draft, id: (editingPre && editingPre.id) || undefined };
  if (editingId) {
    try {
      const saved = await persistSubscriptionsAfterSubSave();
      if (saved?.actions) editingPre = normalizePreForEditor(saved.actions[0] || editingPre);
      toast(editingPre.code && String(editingPre.code).trim() ? 'Pre-action saved' : 'Pre-action cleared');
    } catch (err) { toast(err.message, true); return; }
  } else {
    toast('Pre-action updated — save webhook to apply');
  }
  renderPreSummary();
  showPage('edit');
};
$('#webhookForm').onsubmit = async e => {
  e.preventDefault();
  const body = { name: $('#webhookName').value.trim(), status: $('#webhookStatus').value, actions: collectActions(), subscriptions: editingSubs.filter(s => s.target_url).map(subToApi) };
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
  $('#statsGrid').innerHTML = [['Events', s.total || 0, 'Accepted into the queue'], ['Processed', s.processed || 0, 'Pre-action ran, fanned out'], ['Pending', s.pending || 0, 'Queued or in flight'], ['Failed', s.failed || 0, 'Failed deliveries']].map(([l, v, sub]) => `<div class="stat"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${sub}</div></div>`).join('');
}
async function loadDashboard() {
  try {
    const d = await api('/api/dashboard');
    renderStats(d.stats);
    $('#dashboardWebhooks').innerHTML = d.webhooks?.length ? `<div class="hook-list">${d.webhooks.slice(0, 6).map(w => `<div class="hook-row"><div><strong>${esc(w.name)}</strong><small>${w.events || 0} events · ${w.status}</small></div><button class="ghost" onclick="openWebhook(${w.id})">Open</button></div>`).join('')}</div>` : '<div class="empty">Create your first webhook.</div>';
  } catch (err) { toast(err.message, true); }
}
async function loadWebhooks() {
  try {
    const d = await api('/api/webhooks');
    $('#webhooksTable').innerHTML = d.webhooks?.length ? `<table class="table"><thead><tr><th>Name</th><th>Endpoint</th><th>Events</th><th>Status</th><th></th></tr></thead><tbody>${d.webhooks.map(w => `<tr><td><strong>${esc(w.name)}</strong></td><td class="mono">/webhooks/${w.token.slice(0, 12)}…</td><td>${w.events ?? 0}</td><td><span class="badge ${w.status === 'active' ? 'processed' : 'failed'}">${esc(w.status || 'active')}</span></td><td><button class="ghost" onclick="openWebhook(${w.id})">Inspect</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No webhooks yet.</div>';
  } catch (err) { toast(err.message, true); }
}
async function openWebhook(id) {
  currentDetailId = Number(id);
  showPage('detail');
  $('#detailName').textContent = 'Loading…';
  $('#webhookDetail').innerHTML = '<div class="empty">Loading webhook…</div>';
  try {
    const d = await api('/api/webhooks/' + id);
    currentWebhook = d.webhook;
    $('#detailName').textContent = currentWebhook.name;
    $('#detailSub').textContent = `${currentWebhook.url} · ${d.stats.total || 0} events received`;
    $('#webhookDetail').innerHTML = `<div class="detail-title"><div><div class="url-box"><code>${esc(currentWebhook.url)}</code><button type="button" class="ghost" onclick="copyWebhookUrl()">Copy URL</button></div><div class="curl-box"><div class="curl-head"><span>Test with curl</span><button type="button" class="ghost sm" onclick="copyWebhookCurl()">Copy curl</button></div><pre class="curl-code"><code>${esc(buildCurl(currentWebhook.url))}</code></pre></div></div></div>`
      + `<div class="detail-stats">${[['Received', d.stats.total || 0], ['Processed', d.stats.processed || 0], ['Delivered', d.stats.delivered_ok || 0], ['Failed', d.stats.failed || 0]].map(x => `<div class="detail-stat"><div class="n">${x[1]}</div><div class="l">${x[0]}</div></div>`).join('')}</div>`
      + `<div class="panel-head"><div><h3>Pre-action</h3><p>Sets a key-value <code>pre</code> object — subscriptions use <code>{{ pre.key }}</code>.</p></div><span class="count-pill">${d.actions.length}</span></div><div class="action-list">${d.actions.length ? (() => { const a = d.actions[0]; return `<div class="action-item"><strong>${esc(a.name || 'Pre-action')}</strong><small>${a.enabled ? 'enabled' : 'disabled'}</small><pre>${esc(a.code)}</pre></div>`; })() : '<div class="empty">No pre-action configured.</div>'}</div>`
      + `<div class="panel-head" style="margin-top:18px"><div><h3>Subscriptions</h3><p>Templated forwards — URL, headers and JSON body render per event with {{ body }}, {{ pre }}, etc.</p></div><span class="count-pill">${d.subscriptions.length}</span></div><div class="action-list">${d.subscriptions.length ? d.subscriptions.map(s => `<div class="action-item"><strong>${esc(s.name)}</strong><small class="mono">${esc(s.http_method || 'POST')} ${esc(s.target_url)}</small><small>${s.enabled ? 'enabled' : 'disabled'} · ${s.payload_mode === 'custom' ? 'custom JSON' : 'passthrough'}${s.has_secret ? ' · signed' : ''}${s.headers && Object.keys(s.headers).length ? ` · ${Object.keys(s.headers).length} header${Object.keys(s.headers).length === 1 ? '' : 's'}` : ''}</small>${s.payload_mode === 'custom' && s.payload_template ? `<pre>${esc(s.payload_template)}</pre>` : ''}</div>`).join('') : '<div class="empty">No subscriptions — events are queued and processed only.</div>'}</div>`;
  } catch (err) { toast(err.message, true); }
}
function esc(s) { return String(s ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
window.openWebhook = openWebhook; window.openEdit = openEdit;
window.toast = toast; window.copyWebhookUrl = copyWebhookUrl; window.copyWebhookCurl = copyWebhookCurl;
window.copyText = copyText; window.buildCurl = buildCurl;
bootstrap();
