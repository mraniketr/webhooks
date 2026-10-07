const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let currentPage = 'dashboard', currentWebhook = null, user = null;
let editingId = null;
let editingPre = null;
let editingFilter = '';
let editingSubs = [];
let editingSubIndex = null; // null | number ('new' uses -1)
let varCache = { wid: null, variables: null, hasSample: false };
let lastTemplateField = null;
let currentDetailId = null;
let currentSubscriptionId = null;
let currentSubscriptionWebhookId = null;

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
  const navFor = ['detail', 'edit', 'subedit', 'preedit', 'filteredit', 'subscription'].includes(page) ? 'webhooks' : page;
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === navFor));
  const titles = {
    dashboard: ['Overview', 'Webhook health at a glance'],
    webhooks: ['Webhooks', 'All Webhooks'],
    plans: ['Billing', 'Plans'],
    detail: ['All Webhooks', 'Webhook details'],
    subscription: ['All Webhooks', 'Subscription details'],
    edit: ['All Webhooks', 'Create or edit endpoint'],
    subedit: ['All Webhooks', 'Edit one subscription'],
    preedit: ['All Webhooks', 'Edit pre-action'],
    filteredit: ['All Webhooks', 'Edit webhook filter'],
  };
  const [eyebrow, title] = titles[page] || titles.webhooks;
  $('#pageEyebrow').textContent = eyebrow;
  $('#pageTitle').textContent = title;
  const newBtn = $('#newWebhookBtn');
  if (newBtn) newBtn.classList.toggle('hidden', page !== 'webhooks');
  if (page === 'dashboard') loadDashboard(); else if (page === 'webhooks') loadWebhooks(); else if (page === 'plans') loadPlans();
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
  try {
    const cfg = await api('/api/auth/config');
    const btn = $('#googleBtn'), note = $('#ssoDisabled');
    if (cfg.googleEnabled) btn?.classList.remove('hidden');
    else { btn?.classList.add('hidden'); note?.classList.remove('hidden'); }
  } catch {}
  try { const d = await api('/api/me'); user = d.user; showApp(); } catch { showAuth(); }
}
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
  const stats = s.stats || {};
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
    filter_code: s.filter_code || '',
    stats: {
      enqueued: Number(stats.enqueued ?? s.enqueued ?? 0),
      delivered_ok: Number(stats.delivered_ok ?? s.delivered_ok ?? 0),
      delivered_failed: Number(stats.delivered_failed ?? s.delivered_failed ?? 0),
      pending: Number(stats.pending ?? Math.max(0, Number(stats.enqueued ?? s.enqueued ?? 0) - Number(stats.delivered_ok ?? s.delivered_ok ?? 0) - Number(stats.delivered_failed ?? s.delivered_failed ?? 0))),
    },
  };
}
function openCreate() {
  editingId = null; varCache = { wid: null, variables: null, hasSample: false };
  editingPre = normalizePreForEditor({}); editingFilter = ''; editingSubs = []; editingSubIndex = null;
  $('#editEyebrow').textContent = 'NEW ENDPOINT';
  $('#editTitle').textContent = 'Create webhook';
  $('#webhookSubmit').textContent = 'Create webhook';
  $('#webhookName').value = ''; $('#webhookStatus').value = 'active';
  renderPreSummary();
  renderFilterSummary();
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
    editingFilter = d.webhook?.filter_code || '';
    renderFilterSummary();
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

function renderFilterSummary() {
  const box = $('#filterSummary');
  if (!box) return;
  const code = (editingFilter || '').trim();
  if (!code) {
    box.innerHTML = '<div class="empty">No filter — all events pass. Edit to add a boolean expression.</div>';
    return;
  }
  const preview = String(editingFilter).slice(0, 220);
  box.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'hook-row sub-list-row';
  row.innerHTML = `<div><strong>Webhook filter</strong>`
    + `<small class="mono">${esc(preview)}${String(editingFilter).length > 220 ? '…' : ''}</small>`
    + `<small>falsy drops the whole event · empty allows all</small></div>`
    + `<div style="display:flex;gap:8px"><button type="button" class="ghost sm">Edit</button></div>`;
  row.querySelector('button').onclick = () => openFilterEditor();
  box.append(row);
}

function openFilterEditor() {
  $('#filterCode').value = editingFilter || '';
  const tb = $('#filterTestBox');
  if (tb) { tb.classList.add('hidden'); tb.innerHTML = ''; }
  showPage('filteredit');
}

function closeFilterEditor() {
  showPage('edit');
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
    const st = s.stats || {};
    const statBits = `${st.enqueued ?? 0} queued · ${st.delivered_ok ?? 0} ok · ${st.delivered_failed ?? 0} failed`;
    const row = document.createElement('div');
    row.className = 'hook-row sub-list-row clickable';
    row.innerHTML = `<div><strong>${esc(s.name || s.target_url || 'Untitled subscription')}</strong>`
      + `<small class="mono">${esc(s.http_method || 'POST')} ${esc(s.target_url || '—')}</small>`
      + `<small>${s.enabled ? 'enabled' : 'disabled'} · ${s.payload_mode === 'custom' ? 'custom JSON' : 'passthrough'}${s.has_secret ? ' · signed' : ''}${hdrCount ? ` · ${hdrCount} header${hdrCount === 1 ? '' : 's'}` : ''}${s.filter_code && String(s.filter_code).trim() ? ' · filtered' : ''}</small>`
      + `<small class="mono">${esc(statBits)} · click for details</small></div>`
      + `<div style="display:flex;gap:8px"><button type="button" class="ghost sm">Edit</button></div>`;
    row.querySelector('button').onclick = (e) => { e.stopPropagation(); openSubEditor(i); };
    row.onclick = () => { if (s.id) openSubscription(s.id); else openSubEditor(i); };
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
  $('#subFilterCode').value = s.filter_code || '';
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
    filter_code: ($('#subFilterCode')?.value || '').slice(0, 20000),
    stats: prev.stats || { enqueued: 0, delivered_ok: 0, delivered_failed: 0, pending: 0 },
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
    filter_code: s.filter_code || '',
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
    const d = await api('/api/webhooks/' + editingId + '/subscriptions/preview', { method: 'POST', body: JSON.stringify({ subscription: subToApi(sub), webhook_filter_code: editingFilter || '' }) });
    const r = d.rendered;
    const wf = d.webhookFilter;
    const sf = d.subscriptionFilter;
    const filterBits = `${wf ? `<div class="${wf.allow ? 'preview-ok' : 'preview-err'}">Webhook filter: ${wf.error ? 'error — ' + esc(wf.error) + ' (fail open, allows)' : (wf.allow ? 'ALLOW' : 'DROP event')}</div>` : ''}`
      + `${sf ? `<div class="${sf.allow ? 'preview-ok' : 'preview-err'}">Subscription filter: ${sf.error ? 'error — ' + esc(sf.error) + ' (fail open, allows)' : (sf.allow ? 'ALLOW' : 'SKIP this subscription')}</div>` : ''}`;
    box.innerHTML = `${d.preError ? `<div class="preview-err">Pre-action: ${esc(d.preError)}</div>` : ''}`
      + filterBits
      + `${r.errors?.length ? `<div class="preview-err">${r.errors.map(esc).join('<br/>')}</div>` : '<div class="preview-ok">Rendered OK</div>'}`
      + `<div class="preview-grid"><div><span>METHOD</span><code>${esc(r.method)}</code></div><div><span>URL</span><code>${esc(r.url)}</code></div></div>`
      + `${Object.keys(r.headers || {}).length ? `<div><span>HEADERS</span><pre>${esc(JSON.stringify(r.headers, null, 2))}</pre></div>` : '<div class="muted">No custom headers.</div>'}`
      + `<div><span>BODY</span><pre>${esc((r.bodyText || '').slice(0, 2000))}</pre></div>`;
  } catch (err) { box.innerHTML = `<div class="preview-err">${esc(err.message)}</div>`; }
}

async function persistSubscriptionsAfterSubSave() {
  // One-by-one UX with immediate persistence for existing webhooks.
  // Include current name/status/actions/filter so unsaved edits elsewhere aren't lost.
  if (!editingId) return null;
  const payload = {
    name: $('#webhookName').value.trim() || undefined,
    status: $('#webhookStatus').value,
    filter_code: editingFilter || '',
    actions: collectActions(),
    subscriptions: editingSubs.filter(s => s.target_url).map(subToApi),
  };
  return api('/api/webhooks/' + editingId, { method: 'PUT', body: JSON.stringify(payload) });
}

async function testWebhookFilter() {
  const box = $('#filterTestBox');
  box.classList.remove('hidden');
  box.innerHTML = '<div class="muted">Evaluating…</div>';
  const code = $('#filterCode').value;
  if (!editingId) {
    box.innerHTML = '<div class="muted">Save the webhook first to test against its sample event.</div>';
    return;
  }
  try {
    const d = await api('/api/webhooks/' + editingId + '/filter/preview', { method: 'POST', body: JSON.stringify({ code }) });
    box.innerHTML = d.error
      ? `<div class="preview-err">Error: ${esc(d.error)} (fail open — event would be allowed)</div>`
      : `<div class="${d.allow ? 'preview-ok' : 'preview-err'}">Result: ${d.allow ? 'ALLOW — event passes' : 'DROP — event would be rejected'}</div>`;
  } catch (err) { box.innerHTML = `<div class="preview-err">${esc(err.message)}</div>`; }
}

['#newWebhookBtn', '#newWebhookBtn2'].forEach(id => { const e = $(id); if (e) e.onclick = openCreate; });
const preEditBtn = $('#preEditBtn'); if (preEditBtn) preEditBtn.onclick = () => openPreEditor();
const backToEditFromPre = $('#backToEditFromPre'); if (backToEditFromPre) backToEditFromPre.onclick = closePreEditor;
const cancelPreEdit = $('#cancelPreEdit'); if (cancelPreEdit) cancelPreEdit.onclick = closePreEditor;
const filterEditBtn = $('#filterEditBtn'); if (filterEditBtn) filterEditBtn.onclick = () => openFilterEditor();
const backToEditFromFilter = $('#backToEditFromFilter'); if (backToEditFromFilter) backToEditFromFilter.onclick = closeFilterEditor;
const cancelFilterEdit = $('#cancelFilterEdit'); if (cancelFilterEdit) cancelFilterEdit.onclick = closeFilterEditor;
const filterTestBtn = $('#filterTestBtn'); if (filterTestBtn) filterTestBtn.onclick = testWebhookFilter;
$('#addSubBtn').onclick = () => openSubEditor(-1);
$('#cancelEdit').onclick = cancelEdit;
$('#backToWebhooks').onclick = cancelEdit;
$('#backToEdit').onclick = closeSubEditor;
$('#cancelSubEdit').onclick = closeSubEditor;
$('#backToListBtn').onclick = () => showPage('webhooks');
$('#detailEditBtn').onclick = () => { if (currentDetailId) openEdit(currentDetailId); };
$('#backToWebhookBtn').onclick = () => { if (currentSubscriptionWebhookId) openWebhook(currentSubscriptionWebhookId); else if (currentDetailId) openWebhook(currentDetailId); else showPage('webhooks'); };
$('#subDetailEditBtn').onclick = () => { if (currentSubscriptionWebhookId) openEdit(currentSubscriptionWebhookId); };
$('#subAddHdr').onclick = () => $('#subHeadersBox').append(headerEditorRow('', ''));
$('#subPayloadMode').onchange = syncSubPayloadMode;
$('#subVarsBtn').onclick = toggleSubVarPanel;
$('#subPreviewBtn').onclick = previewSingleSubscription;
['#subTargetUrl', '#subPayloadTemplate'].forEach(id => { const el = $(id); if (el) el.addEventListener('focus', e => lastTemplateField = e.target); });
const _subFilterEl = $('#subFilterCode'); if (_subFilterEl) _subFilterEl.addEventListener('focus', e => lastTemplateField = e.target);
$('#subEditForm').onsubmit = async e => {
  e.preventDefault();
  const draft = collectSubEditor();
  if (!draft.target_url) { toast('Target URL is required', true); return; }
  try {
    if (editingSubIndex === -1) {
      editingSubs.push({ ...draft, secret: draft.secret || '', has_secret: draft.secret ? 1 : 0, stats: draft.stats || { enqueued: 0, delivered_ok: 0, delivered_failed: 0, pending: 0 } });
    } else {
      const prev = editingSubs[editingSubIndex] || {};
      editingSubs[editingSubIndex] = { ...draft, id: prev.id, has_secret: draft.secret ? 1 : (prev.has_secret || 0), stats: prev.stats || draft.stats };
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
const filterEditForm = $('#filterEditForm');
if (filterEditForm) filterEditForm.onsubmit = async e => {
  e.preventDefault();
  editingFilter = $('#filterCode').value || '';
  if (editingId) {
    try {
      const saved = await api('/api/webhooks/' + editingId, { method: 'PUT', body: JSON.stringify({
        name: $('#webhookName').value.trim() || undefined,
        status: $('#webhookStatus').value,
        filter_code: editingFilter,
        actions: collectActions(),
        subscriptions: editingSubs.filter(s => s.target_url).map(subToApi),
      }) });
      if (saved?.webhook) editingFilter = saved.webhook.filter_code || '';
      toast(editingFilter && editingFilter.trim() ? 'Filter saved' : 'Filter cleared (allow all)');
    } catch (err) { toast(err.message, true); return; }
  } else {
    toast('Filter updated — save webhook to apply');
  }
  renderFilterSummary();
  showPage('edit');
};
$('#webhookForm').onsubmit = async e => {
  e.preventDefault();
  const body = { name: $('#webhookName').value.trim(), status: $('#webhookStatus').value, filter_code: editingFilter || '', actions: collectActions(), subscriptions: editingSubs.filter(s => s.target_url).map(subToApi) };
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
  $('#statsGrid').innerHTML = [['Queued', s.enqueued || 0, 'Deliveries fanned out to subscriptions'], ['Delivered', s.delivered_ok || 0, 'Successful forwards'], ['Pending', s.pending || 0, 'Queued or in flight'], ['Failed', s.delivered_failed || 0, 'Failed deliveries']].map(([l, v, sub]) => `<div class="stat"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${sub}</div></div>`).join('');
}
async function loadDashboard() {
  try {
    const d = await api('/api/dashboard');
    renderStats(d.stats);
    $('#dashboardWebhooks').innerHTML = d.webhooks?.length ? `<div class="hook-list">${d.webhooks.slice(0, 6).map(w => `<div class="hook-row clickable" onclick="openWebhook(${w.id})"><div><strong>${esc(w.name)}</strong><small>${w.subscription_count || 0} subscription${(w.subscription_count || 0) === 1 ? '' : 's'} · ${w.delivered_ok || 0} delivered · ${w.status}</small></div><button class="ghost" onclick="event.stopPropagation();openWebhook(${w.id})">Open</button></div>`).join('')}</div>` : '<div class="empty">Create your first webhook.</div>';
  } catch (err) { toast(err.message, true); }
}
async function loadWebhooks() {
  try {
    const d = await api('/api/webhooks');
    $('#webhooksTable').innerHTML = d.webhooks?.length ? `<table class="table"><thead><tr><th>Name</th><th>Endpoint</th><th>Subscriptions</th><th>Delivered</th><th>Failed</th><th>Status</th><th></th></tr></thead><tbody>${d.webhooks.map(w => `<tr class="clickable" onclick="openWebhook(${w.id})"><td><strong>${esc(w.name)}</strong></td><td class="mono">/webhooks/${w.token.slice(0, 12)}…</td><td>${w.subscription_count ?? 0}</td><td>${w.delivered_ok ?? 0}</td><td>${w.delivered_failed ?? 0}</td><td><span class="badge ${w.status === 'active' ? 'processed' : 'failed'}">${esc(w.status || 'active')}</span></td><td><button class="ghost" onclick="event.stopPropagation();openWebhook(${w.id})">Inspect</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No webhooks yet.</div>';
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
    $('#detailSub').textContent = `${currentWebhook.url} · ${d.subscriptions.length} subscription${d.subscriptions.length === 1 ? '' : 's'}`;
    $('#webhookDetail').innerHTML = `<div class="detail-title"><div><div class="url-box"><code>${esc(currentWebhook.url)}</code><button type="button" class="ghost" onclick="copyWebhookUrl()">Copy URL</button></div><div class="curl-box"><div class="curl-head"><span>Test with curl</span><button type="button" class="ghost sm" onclick="copyWebhookCurl()">Copy curl</button></div><pre class="curl-code"><code>${esc(buildCurl(currentWebhook.url))}</code></pre></div></div></div>`
      + `<div class="detail-stats">${[['Queued', d.stats.enqueued || 0], ['Delivered', d.stats.delivered_ok || 0], ['Failed', d.stats.delivered_failed || 0], ['Pending', d.stats.pending || 0]].map(x => `<div class="detail-stat"><div class="n">${x[1]}</div><div class="l">${x[0]}</div></div>`).join('')}</div>`
      + `<div class="panel-head"><div><h3>Pre-action</h3><p>Sets a key-value <code>pre</code> object — subscriptions use <code>{{ pre.key }}</code>.</p></div><span class="count-pill">${d.actions.length}</span></div><div class="action-list">${d.actions.length ? (() => { const a = d.actions[0]; return `<div class="action-item"><strong>${esc(a.name || 'Pre-action')}</strong><small>${a.enabled ? 'enabled' : 'disabled'}</small><pre>${esc(a.code)}</pre></div>`; })() : '<div class="empty">No pre-action configured.</div>'}</div>`
      + `<div class="panel-head" style="margin-top:18px"><div><h3>Webhook filter</h3><p>Boolean expression — falsy drops the whole event. Empty allows all.</p></div></div><div class="action-list">${currentWebhook.filter_code && String(currentWebhook.filter_code).trim() ? `<div class="action-item"><strong>Filter active</strong><pre>${esc(currentWebhook.filter_code)}</pre></div>` : '<div class="empty">No filter — all events pass.</div>'}</div>`
      + `<div class="panel-head" style="margin-top:18px"><div><h3>Subscriptions</h3><p>Click a subscription for its delivery stats. Templated forwards — URL, headers and JSON body render per event with {{ body }}, {{ pre }}, etc.</p></div><span class="count-pill">${d.subscriptions.length}</span></div><div class="action-list">${d.subscriptions.length ? d.subscriptions.map(s => { const st = s.stats || {}; const enq = st.enqueued ?? s.enqueued ?? 0; const ok = st.delivered_ok ?? s.delivered_ok ?? 0; const fail = st.delivered_failed ?? s.delivered_failed ?? 0; return `<div class="action-item clickable" onclick="openSubscription(${s.id})"><strong>${esc(s.name)}</strong><small class="mono">${esc(s.http_method || 'POST')} ${esc(s.target_url)}</small><small>${s.enabled ? 'enabled' : 'disabled'} · ${s.payload_mode === 'custom' ? 'custom JSON' : 'passthrough'}${s.has_secret ? ' · signed' : ''}${s.headers && Object.keys(s.headers).length ? ` · ${Object.keys(s.headers).length} header${Object.keys(s.headers).length === 1 ? '' : 's'}` : ''}${s.filter_code && String(s.filter_code).trim() ? ' · filtered' : ''}</small><small class="mono">${enq} queued · ${ok} delivered · ${fail} failed — click for details</small>${s.payload_mode === 'custom' && s.payload_template ? `<pre>${esc(s.payload_template)}</pre>` : ''}${s.filter_code && String(s.filter_code).trim() ? `<small class="mono">filter: ${esc(s.filter_code)}</small>` : ''}</div>`; }).join('') : '<div class="empty">No subscriptions — events are queued and processed only.</div>'}</div>`;
  } catch (err) { toast(err.message, true); }
}
async function openSubscription(id) {
  currentSubscriptionId = Number(id);
  showPage('subscription');
  $('#subDetailName').textContent = 'Loading…';
  $('#subscriptionDetail').innerHTML = '<div class="empty">Loading subscription…</div>';
  try {
    const d = await api('/api/subscriptions/' + id);
    const s = d.subscription;
    currentSubscriptionWebhookId = d.webhook?.id || null;
    const st = s.stats || {};
    const enq = st.enqueued ?? s.enqueued ?? 0;
    const ok = st.delivered_ok ?? s.delivered_ok ?? 0;
    const fail = st.delivered_failed ?? s.delivered_failed ?? 0;
    const pending = st.pending ?? Math.max(0, enq - ok - fail);
    $('#subDetailName').textContent = s.name || 'Subscription';
    $('#subDetailSub').textContent = `${d.webhook?.name ? esc(d.webhook.name) + ' · ' : ''}${esc(s.http_method || 'POST')} ${esc(s.target_url)}`;
    $('#subDetailSub').innerHTML = `${s.enabled ? 'enabled' : 'disabled'} · <span class="mono">${esc(s.http_method || 'POST')} ${esc(s.target_url)}</span>`;
    const dailyRows = (d.daily || []).map(r => `<tr><td class="mono">${esc(r.day)}</td><td>${r.enqueued ?? 0}</td><td>${r.delivered_ok ?? 0}</td><td>${r.delivered_failed ?? 0}</td></tr>`).join('');
    $('#subscriptionDetail').innerHTML = `<div class="detail-stats">${[['Queued', enq], ['Delivered', ok], ['Failed', fail], ['Pending', pending]].map(x => `<div class="detail-stat"><div class="n">${x[1]}</div><div class="l">${x[0]}</div></div>`).join('')}</div>`
      + `<div class="panel-head"><div><h3>Configuration</h3><p>How this subscription forwards events.</p></div></div><div class="action-list"><div class="action-item"><strong>Target</strong><small class="mono">${esc(s.http_method || 'POST')} ${esc(s.target_url)}</small><small>${s.enabled ? 'enabled' : 'disabled'} · ${s.payload_mode === 'custom' ? 'custom JSON' : 'passthrough'}${s.has_secret ? ' · signed' : ''}</small>${s.headers && Object.keys(s.headers).length ? `<pre>${esc(JSON.stringify(s.headers, null, 2))}</pre>` : ''}${s.payload_mode === 'custom' && s.payload_template ? `<pre>${esc(s.payload_template)}</pre>` : ''}${s.filter_code && String(s.filter_code).trim() ? `<small><b>Filter:</b></small><pre>${esc(s.filter_code)}</pre><small class="muted">Falsy skips only this subscription.</small>` : '<small class="muted">No filter — all events delivered.</small>'}</div></div>`
      + `<div class="panel-head" style="margin-top:18px"><div><h3>Daily breakdown</h3><p>Per-day delivery counts for the last 30 days.</p></div><span class="count-pill">${(d.daily || []).length}</span></div>${(d.daily || []).length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Day</th><th>Queued</th><th>Delivered</th><th>Failed</th></tr></thead><tbody>${dailyRows}</tbody></table></div>` : '<div class="empty">No deliveries yet.</div>'}`;
  } catch (err) { toast(err.message, true); }
}
function fmtQuota(v) { return v === null || v === undefined ? 'Unlimited' : Number(v).toLocaleString(); }
function tpsLabel(plan) {
  const tps = Number(plan.tps_limit || 0), win = Math.max(1, Number(plan.window_seconds || 60));
  const perSec = tps / win;
  const txt = perSec >= 10 ? String(Math.round(perSec)) : String(Math.round(perSec * 100) / 100);
  return `${txt} TPS (≈${Number(tps).toLocaleString()}/${win}s)`;
}
async function loadPlans() {
  const grid = $('#plansGrid'), usageEl = $('#plansUsage');
  if (grid) grid.innerHTML = '<div class="empty">Loading plans…</div>';
  try {
    const d = await api('/api/plans');
    const current = d.currentPlan || user?.plan || 'free';
    if (usageEl) usageEl.textContent = `Current plan: ${current} · ${d.usage?.webhooks ?? 0} webhook(s) · ${d.usage?.dailyUsed ?? 0} event(s) today`;
    if (!grid) return;
    grid.innerHTML = '';
    (d.plans || []).forEach(p => {
      const isCurrent = p.plan === current;
      const card = document.createElement('div');
      card.className = 'plan-card' + (isCurrent ? ' current' : '');
      card.innerHTML = `<div class="plan-infra">${esc(p.infra || 'shared')} infra</div>`
        + `<h3>${esc(p.plan)}</h3>`
        + `<div class="plan-price">${esc(p.price_display || '$0')}</div>`
        + `<div class="plan-desc">${esc(p.description || '')}</div>`
        + (isCurrent ? '<div class="plan-current-pill">Current plan</div>' : '')
        + `<ul class="plan-feats">`
        + `<li>⚡ <span><b>Push rate:</b> ${esc(tpsLabel(p))}</span></li>`
        + `<li>📅 <span><b>Daily events:</b> ${esc(fmtQuota(p.daily_limit))}</span></li>`
        + `<li>◌ <span><b>Webhooks:</b> ${esc(fmtQuota(p.max_webhooks))}</span></li>`
        + `<li>🔗 <span><b>Subscriptions / webhook:</b> ${esc(fmtQuota(p.max_subs_per_webhook))}</span></li>`
        + `</ul>`
        + (p.plan === 'dedicated' && !isCurrent ? '<div class="hint">Dedicated uses isolated queues — provisioned by an admin after you select it. Deliveries fall back to shared until then.</div>' : '');
      const btn = document.createElement('button');
      btn.className = isCurrent ? 'ghost full' : 'primary full';
      btn.textContent = isCurrent ? 'Current plan' : `Select ${p.plan}`;
      btn.disabled = isCurrent;
      if (!isCurrent) btn.onclick = () => selectPlan(p.plan, btn);
      card.append(btn);
      grid.append(card);
    });
  } catch (err) {
    if (grid) grid.innerHTML = `<div class="empty">Could not load plans: ${esc(err.message)}</div>`;
  }
}
async function selectPlan(plan, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Switching…'; }
  try {
    const d = await api('/api/plan', { method: 'PUT', body: JSON.stringify({ plan }) });
    if (d.user) user = d.user;
    toast(d.unchanged ? `Already on ${plan}` : `Switched to ${plan}` + (d.notice ? ' — ' + d.notice : ''));
    loadPlans();
  } catch (err) { toast(err.message, true); if (btn) { btn.disabled = false; btn.textContent = `Select ${plan}`; } }
}
const plansRefreshBtn = $('#plansRefreshBtn'); if (plansRefreshBtn) plansRefreshBtn.onclick = loadPlans;
function esc(s) { return String(s ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
window.openWebhook = openWebhook; window.openEdit = openEdit; window.openSubscription = openSubscription;
window.toast = toast; window.copyWebhookUrl = copyWebhookUrl; window.copyWebhookCurl = copyWebhookCurl;
window.copyText = copyText; window.buildCurl = buildCurl;
bootstrap();
