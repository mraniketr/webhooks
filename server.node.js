const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const vm = require('node:vm');

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'webhook-service.db');
const APP_SECRET = process.env.APP_SECRET || 'change-me-in-production';
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 60);
const RATE_LIMIT_BURST = Number(process.env.RATE_LIMIT_BURST || 20);
const WEBHOOK_BODY_LIMIT = 256 * 1024;
// Idle session timeout in ms. Configurable via SESSION_TTL_MINUTES
// (preferred) or SESSION_TTL_MS. Defaults to 10 minutes of inactivity.
const SESSION_TTL_MS = (() => {
  const minutesRaw = process.env.SESSION_TTL_MINUTES;
  if (minutesRaw !== undefined && String(minutesRaw).trim() !== "") {
    const minutes = Number(minutesRaw);
    if (Number.isFinite(minutes) && minutes > 0) return Math.floor(minutes * 60 * 1000);
  }
  const msRaw = process.env.SESSION_TTL_MS;
  if (msRaw !== undefined && String(msRaw).trim() !== "") {
    const ms = Number(msRaw);
    if (Number.isFinite(ms) && ms > 0) return Math.floor(ms);
  }
  return 10 * 60 * 1000;
})();

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id INTEGER NOT NULL,
  phase TEXT NOT NULL DEFAULT 'pre' CHECK(phase IN ('pre')),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  payload_json TEXT,
  raw_body TEXT,
  ip TEXT,
  status TEXT NOT NULL DEFAULT 'accepted',
  error TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  FOREIGN KEY(webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  locked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_events_webhook_received ON events(webhook_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status_available ON jobs(status, available_at);
`);

const statements = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT id, email, name, created_at FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users (email,name,password_hash,password_salt,created_at) VALUES (?,?,?,?,?)'),
  insertWebhook: db.prepare('INSERT INTO webhooks (user_id,name,token,created_at) VALUES (?,?,?,?)'),
  webhookByToken: db.prepare("SELECT * FROM webhooks WHERE token = ? AND status = 'active'"),
  webhookById: db.prepare('SELECT * FROM webhooks WHERE id = ? AND user_id = ?'),
  webhooks: db.prepare(`SELECT w.id,w.name,w.token,w.status,w.created_at,
      COUNT(e.id) AS events,
      SUM(CASE WHEN e.status='processed' THEN 1 ELSE 0 END) AS processed,
      SUM(CASE WHEN e.status='failed' THEN 1 ELSE 0 END) AS failed
    FROM webhooks w LEFT JOIN events e ON e.webhook_id=w.id
    WHERE w.user_id=? GROUP BY w.id ORDER BY w.id DESC`),
  actionsForWebhook: db.prepare("SELECT * FROM actions WHERE webhook_id=? AND phase='pre' ORDER BY sort_order, id"),
  insertAction: db.prepare('INSERT INTO actions (webhook_id,phase,name,code,sort_order,enabled) VALUES (?,?,?,?,?,?)'),
  deleteActions: db.prepare('DELETE FROM actions WHERE webhook_id=?'),
  insertEvent: db.prepare(`INSERT INTO events (webhook_id,method,headers_json,payload_json,raw_body,ip,received_at) VALUES (?,?,?,?,?,?,?)`),
  insertJob: db.prepare('INSERT INTO jobs (event_id,available_at,created_at) VALUES (?,?,?)'),
  claimJob: db.prepare(`UPDATE jobs SET status='processing',locked_at=?,attempts=attempts+1
    WHERE id=(SELECT id FROM jobs WHERE status='queued' AND available_at<=? ORDER BY id LIMIT 1)
    RETURNING *`),
  jobEvent: db.prepare('SELECT * FROM events WHERE id=?'),
  markEventStatus: db.prepare('UPDATE events SET status=?,error=?,processed_at=? WHERE id=?'),
  markJobDone: db.prepare('UPDATE jobs SET status=?,last_error=? WHERE id=?'),
  requeueJob: db.prepare("UPDATE jobs SET status='queued', available_at=?, locked_at=NULL, last_error=? WHERE id=?"),
  eventById: db.prepare('SELECT e.*,w.name AS webhook_name,w.token FROM events e JOIN webhooks w ON w.id=e.webhook_id WHERE e.id=? AND w.user_id=?'),
  events: db.prepare(`SELECT e.id,e.method,e.ip,e.status,e.error,e.received_at,e.processed_at,
      substr(COALESCE(e.payload_json,e.raw_body,''),1,140) AS payload_preview
    FROM events e JOIN webhooks w ON w.id=e.webhook_id
    WHERE e.webhook_id=? AND w.user_id=? ORDER BY e.id DESC LIMIT ? OFFSET ?`),
  eventCount: db.prepare('SELECT COUNT(*) AS count FROM events e JOIN webhooks w ON w.id=e.webhook_id WHERE e.webhook_id=? AND w.user_id=?'),
  stats: db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN e.status='processed' THEN 1 ELSE 0 END) AS processed,
      SUM(CASE WHEN e.status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN e.status='accepted' THEN 1 ELSE 0 END) AS pending,
      MAX(e.received_at) AS last_event
    FROM events e JOIN webhooks w ON w.id=e.webhook_id
    WHERE w.id=? AND w.user_id=?`),
  allStats: db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN e.status='processed' THEN 1 ELSE 0 END) AS processed,
      SUM(CASE WHEN e.status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN e.status='accepted' THEN 1 ELSE 0 END) AS pending
    FROM events e JOIN webhooks w ON w.id=e.webhook_id WHERE w.user_id=?`),
  recentEvents: db.prepare(`SELECT e.id,e.method,e.status,e.received_at,w.name AS webhook_name
    FROM events e JOIN webhooks w ON w.id=e.webhook_id WHERE w.user_id=? ORDER BY e.id DESC LIMIT 8`)
};

function now() { return new Date().toISOString(); }
function json(res, status, body, headers={}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...headers, 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}
function html(res, status, body) { res.writeHead(status, {'Content-Type':'text/html; charset=utf-8'}); res.end(body); }
function notFound(res) { json(res, 404, {error:'Not found'}); }
function randomToken(bytes=24) { return crypto.randomBytes(bytes).toString('base64url'); }
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function hashPassword(password, salt=crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, salt, expected) {
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual,'hex'), Buffer.from(expected,'hex'));
}
function signSession(userId) {
  const body = Buffer.from(JSON.stringify({uid:userId, exp:Date.now()+SESSION_TTL_MS})).toString('base64url');
  const sig = crypto.createHmac('sha256', APP_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function sessionCookie(value) {
  return `sid=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS/1000)}`;
}
function readSession(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|; )sid=([^;]+)/);
  if (!m) return null;
  const [body,sig] = m[1].split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', APP_SECRET).update(body).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(body,'base64url').toString());
    if (p.exp < Date.now()) return null;
    return statements.userById.get(p.uid) || null;
  } catch { return null; }
}
function getPublicIp(req) { return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim(); }
async function readBody(req, limit=WEBHOOK_BODY_LIMIT) {
  return await new Promise((resolve, reject) => {
    let data='', size=0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('Payload too large'), {status:413})); req.destroy(); return; }
      data += chunk.toString('utf8');
    });
    req.on('end', ()=>resolve(data));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const body = await readBody(req, 1024*1024);
  try { return body ? JSON.parse(body) : {}; } catch { throw Object.assign(new Error('Invalid JSON'), {status:400}); }
}
function auth(req,res) {
  const user=readSession(req);
  if (!user) { json(res,401,{error:'Authentication required'}); return null; }
  // Sliding inactivity expiry: refresh the cookie on every authenticated call.
  res.setHeader('Set-Cookie', sessionCookie(signSession(user.id)));
  return user;
}

// Simple per-user token bucket. In production use a shared Redis limiter for multiple instances.
const buckets = new Map();
function rateLimit(userId) {
  const t = Date.now();
  let b = buckets.get(userId);
  if (!b) { b={tokens:RATE_LIMIT_BURST, last:t}; }
  const refill = ((t-b.last)/60000)*RATE_LIMIT_PER_MIN;
  b.tokens = Math.min(RATE_LIMIT_BURST, b.tokens + refill);
  b.last = t;
  if (b.tokens < 1) { buckets.set(userId,b); return {ok:false, retryAfter: Math.ceil((1-b.tokens)*(60000/RATE_LIMIT_PER_MIN)/1000)}; }
  b.tokens -= 1; buckets.set(userId,b); return {ok:true, remaining:Math.floor(b.tokens)};
}

function parsePayload(req, raw) {
  const ct=(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();
  if (!raw) return null;
  if (ct==='application/json' || ct.endsWith('+json')) {
    try { return JSON.parse(raw); } catch { return { _raw: raw }; }
  }
  return { _raw: raw };
}

function sanitizeUser(user){ return {id:user.id,name:user.name,email:user.email,created_at:user.created_at}; }
function sanitizeWebhook(w){ return {id:w.id,name:w.name,url:`${PUBLIC_BASE}/webhooks/${w.token}`,token:w.token,status:w.status,created_at:w.created_at}; }

function runScript(action, event) {
  // Single pre-action contract: script may assign `pre` (a key-value object).
  // Subscriptions access it by key as {{ pre.key }}.
  const logs=[];
  const context={
    event: JSON.parse(JSON.stringify(event)),
    pre: {},
    log: (...args)=>logs.push(args.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' ')),
    setStatus: s=>{ context.event.statusOverride=String(s); },
  };
  vm.createContext(context);
  const script = new vm.Script(`"use strict";\n${action.code}`);
  script.runInContext(context,{timeout:500});
  const pre = (context.pre && typeof context.pre === 'object' && !Array.isArray(context.pre)) ? context.pre : {};
  return {event:context.event, pre, logs};
}

async function processOneJob() {
  const job=statements.claimJob.get(now(), now());
  if (!job) return;
  const event=statements.jobEvent.get(job.event_id);
  if (!event) return;
  try {
    const webhook=db.prepare('SELECT * FROM webhooks WHERE id=?').get(event.webhook_id);
    const actions=statements.actionsForWebhook.all(webhook.id).filter(a=>a.enabled);
    let mutableEvent={
      id:event.id, webhookId:event.webhook_id, payload:event.payload_json?JSON.parse(event.payload_json):event.raw_body,
      headers:JSON.parse(event.headers_json||'{}'), ip:event.ip, receivedAt:event.received_at
    };
    // Single pre-action only.
    const preAction = actions.filter(x=>x.phase==='pre')[0];
    if (preAction) {
      const r=runScript(preAction, mutableEvent);
      mutableEvent=r.event;
    }
    const override=mutableEvent.statusOverride;
    const finalStatus=override==='failed'?'failed':'processed';
    statements.markEventStatus.run(finalStatus, null, now(), event.id);
    statements.markJobDone.run('done', null, job.id);
  } catch (e) {
    statements.markEventStatus.run('failed', e.message, now(), event.id);
    if (job.attempts < 3) {
      statements.requeueJob.run(new Date(Date.now()+Math.min(30000,1000*2**job.attempts)).toISOString(), e.message, job.id);
    } else {
      statements.markJobDone.run('dead', e.message, job.id);
    }
  }
}
setInterval(()=>{ processOneJob().catch(()=>{}); }, 250).unref();

function sendFile(res, file) {
  const ext=path.extname(file).toLowerCase();
  const type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}[ext]||'text/plain; charset=utf-8';
  fs.readFile(file,(err,data)=>{ if(err) return notFound(res); res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'}); res.end(data); });
}

async function router(req,res) {
  const url = new URL(req.url, PUBLIC_BASE);
  const p = url.pathname;

  if (req.method==='GET' && p==='/') return sendFile(res,path.join(__dirname,'public/index.html'));
  if (req.method==='GET' && (p==='/app.js'||p==='/styles.css')) return sendFile(res,path.join(__dirname,'public',p.slice(1)));

  if (req.method==='POST' && p==='/api/auth/signup') {
    try {
      const b=await readJson(req); const email=String(b.email||'').trim().toLowerCase(); const name=String(b.name||'').trim(); const pw=String(b.password||'');
      if (!email || !email.includes('@') || !name || pw.length<8) return json(res,400,{error:'Name, valid email and password (8+ chars) are required'});
      if (statements.userByEmail.get(email)) return json(res,409,{error:'Account already exists'});
      const {hash,salt}=hashPassword(pw); const created=now(); const r=statements.insertUser.run(email,name,hash,salt,created); const user=statements.userById.get(r.lastInsertRowid);
      res.setHeader('Set-Cookie',sessionCookie(signSession(user.id)));
      return json(res,201,{user:sanitizeUser(user)});
    } catch(e){ return json(res,e.status||500,{error:e.message}); }
  }
  if (req.method==='POST' && p==='/api/auth/login') {
    try {
      const b=await readJson(req); const email=String(b.email||'').trim().toLowerCase(); const pw=String(b.password||''); const u=statements.userByEmail.get(email);
      if (!u || !verifyPassword(pw,u.password_salt,u.password_hash)) return json(res,401,{error:'Invalid email or password'});
      res.setHeader('Set-Cookie',sessionCookie(signSession(u.id)));
      return json(res,200,{user:sanitizeUser(u)});
    } catch(e){ return json(res,500,{error:e.message}); }
  }
  if (req.method==='POST' && p==='/api/auth/logout') {
    res.setHeader('Set-Cookie','sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0'); return json(res,200,{ok:true});
  }
  if (req.method==='GET' && p==='/api/me') {
    const u=auth(req,res); if(!u)return; return json(res,200,{user:sanitizeUser(u),rateLimit:{perMinute:RATE_LIMIT_PER_MIN,burst:RATE_LIMIT_BURST}});
  }
  if (req.method==='GET' && p==='/api/dashboard') {
    const u=auth(req,res); if(!u)return; const s=statements.allStats.get(u.id); const hooks=statements.webhooks.all(u.id); const recent=statements.recentEvents.all(u.id);
    return json(res,200,{stats:{total:Number(s.total||0),processed:Number(s.processed||0),failed:Number(s.failed||0),pending:Number(s.pending||0)},webhooks:hooks.map(sanitizeWebhook),recent});
  }
  if (req.method==='GET' && p==='/api/webhooks') {
    const u=auth(req,res); if(!u)return; return json(res,200,{webhooks:statements.webhooks.all(u.id).map(sanitizeWebhook)});
  }
  if (req.method==='POST' && p==='/api/webhooks') {
    const u=auth(req,res); if(!u)return;
    try {
      const b=await readJson(req); const name=String(b.name||'').trim() || 'Untitled webhook';
      const token=randomToken(24); const created=now(); const r=statements.insertWebhook.run(u.id,name,token,created); const id=r.lastInsertRowid;
      const actions=Array.isArray(b.actions)?b.actions.slice(0,1):[];
      actions.forEach((a,i)=>{ if(!a.code) return; statements.insertAction.run(id,'pre',String(a.name||`Pre-action`),String(a.code),i, a.enabled===false?0:1); });
      const w=statements.webhookById.get(id,u.id); return json(res,201,{webhook:sanitizeWebhook(w),actions:statements.actionsForWebhook.all(id)});
    } catch(e){ return json(res,e.status||500,{error:e.message}); }
  }
  const webhookMatch=p.match(/^\/api\/webhooks\/(\d+)$/);
  if (req.method==='GET' && webhookMatch) {
    const u=auth(req,res); if(!u)return; const id=Number(webhookMatch[1]); const w=statements.webhookById.get(id,u.id); if(!w)return notFound(res);
    return json(res,200,{webhook:sanitizeWebhook(w),stats:statements.stats.get(id,u.id),actions:statements.actionsForWebhook.all(id),rateLimit:{perMinute:RATE_LIMIT_PER_MIN,burst:RATE_LIMIT_BURST}});
  }
  const eventMatch=p.match(/^\/api\/webhooks\/(\d+)\/events$/);
  if (req.method==='GET' && eventMatch) {
    const u=auth(req,res); if(!u)return; const wid=Number(eventMatch[1]); if(!statements.webhookById.get(wid,u.id))return notFound(res); const limit=Math.min(100,Math.max(1,Number(url.searchParams.get('limit')||25))); const offset=Math.max(0,Number(url.searchParams.get('offset')||0));
    return json(res,200,{events:statements.events.all(wid,u.id,limit,offset),total:Number(statements.eventCount.get(wid,u.id).count)});
  }
  const oneEvent=p.match(/^\/api\/events\/(\d+)$/);
  if (req.method==='GET' && oneEvent) {
    const u=auth(req,res); if(!u)return; const e=statements.eventById.get(Number(oneEvent[1]),u.id); if(!e)return notFound(res); return json(res,200,{event:{...e,headers:JSON.parse(e.headers_json||'{}'),payload:e.payload_json?JSON.parse(e.payload_json):e.raw_body}});
  }

  // Public webhook endpoint
  const publicMatch=p.match(/^\/webhooks\/([^/]+)$/);
  if (publicMatch && ['POST','PUT','PATCH'].includes(req.method)) {
    const token=publicMatch[1]; const w=statements.webhookByToken.get(token); if(!w)return json(res,404,{error:'Webhook not found'});
    const rl=rateLimit(w.user_id); if(!rl.ok) return json(res,429,{error:'Rate limit exceeded',retryAfterSeconds:rl.retryAfter},{'Retry-After':String(rl.retryAfter)});
    try {
      const raw=await readBody(req); const payload=parsePayload(req,raw); const received=now();
      const r=db.prepare(`INSERT INTO events (webhook_id,method,headers_json,payload_json,raw_body,ip,received_at) VALUES (?,?,?,?,?,?,?)`).run(
        w.id,req.method,JSON.stringify(req.headers),payload===null?null:JSON.stringify(payload),raw,getPublicIp(req),received
      );
      db.prepare('INSERT INTO jobs (event_id,available_at,created_at) VALUES (?,?,?)').run(r.lastInsertRowid,received,received);
      return json(res,202,{accepted:true,eventId:Number(r.lastInsertRowid),status:'queued',rateLimitRemaining:rl.remaining});
    } catch(e){ return json(res,e.status||500,{error:e.message}); }
  }
  notFound(res);
}

const server=http.createServer((req,res)=>{ router(req,res).catch(e=>json(res,e.status||500,{error:e.message||'Internal server error'})); });
server.listen(PORT,()=>console.log(`Webhook service running at ${PUBLIC_BASE}`));
