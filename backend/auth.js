// auth.js — one shared password in front of the whole app (pages AND API).
//
// The margin data is company-sensitive and the app sat open on the LAN. This is
// a deliberate, minimal gate: one password (APP_PASSWORD in .env — never in git),
// an HttpOnly session cookie, and everything except the login screen requires it —
// including /api/*, because the sensitive part IS the JSON. A client-side blur
// would protect the pixels and leave the money one curl away.
//
// Sessions are in-memory: a pm2 restart logs everyone out (acceptable for a LAN
// tool — you type the password again). Sliding 12h expiry. No new dependencies.
//
// APP_PASSWORD unset ⇒ the gate is OFF (loud boot warning), so a missing .env
// line degrades to the old open behavior instead of locking everyone out with a
// password nobody set.

const crypto = require('crypto');

const PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 12 * 60 * 60 * 1000; // 12h sliding
const COOKIE = 'vt_session';
const FAIL_DELAY_MS = 600; // slow down guessing without a lockout table

const sessions = new Map(); // token -> expiry (epoch ms)

// Constant-time compare — hash both sides first so lengths always match.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readToken(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

function prune() {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp <= now) sessions.delete(t);
}

// Everything goes through here. Exemptions: the login page and the login call
// itself (otherwise nobody could ever get in).
function middleware(req, res, next) {
  if (!PASSWORD) return next(); // gate off — warned at boot
  if (req.path === '/login.html' || req.path === '/api/login') return next();

  const token = readToken(req);
  const exp = token && sessions.get(token);
  if (exp && exp > Date.now()) {
    sessions.set(token, Date.now() + SESSION_TTL_MS); // sliding expiry
    return next();
  }
  if (token) sessions.delete(token);

  // API callers get a machine answer; page loads get sent to the login screen,
  // remembering where they were headed. Only same-site relative paths — a full
  // URL or protocol-relative //host in ?next would be an open redirect.
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'auth required' });
  const dest = req.originalUrl && req.originalUrl.startsWith('/') && !req.originalUrl.startsWith('//')
    ? req.originalUrl : '/';
  res.redirect('/login.html?next=' + encodeURIComponent(dest));
}

// POST /api/login { password } → session cookie.
function login(req, res) {
  const supplied = String((req.body && req.body.password) || '');
  if (!PASSWORD || !safeEqual(supplied, PASSWORD)) {
    setTimeout(() => res.status(401).json({ error: 'Wrong password' }), FAIL_DELAY_MS);
    return;
  }
  prune();
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  res.json({ ok: true });
}

// POST /api/logout → drop the session.
function logout(req, res) {
  const token = readToken(req);
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
}

const enabled = () => !!PASSWORD;

module.exports = { middleware, login, logout, enabled };
