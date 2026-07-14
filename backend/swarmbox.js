// Swarmbox PostgREST client.
//
// Mirrors the ShoushaBox inventory.js patterns: no-auth fetch, AbortController
// per-request timeout, rolling-worker concurrency utility, and a process-wide
// concurrency guardrail so multi-tab use can't pile connections on Swarmbox.
// Routes never throw — they get back { ok, data } and decide whether to surface
// the failure or return a graceful empty.

const SWARMBOX_BASE_URL = process.env.SWARMBOX_BASE_URL || 'https://jdfood.swarmbox.com:443/pg-api';
const FETCH_TIMEOUT_MS = Number(process.env.SWARMBOX_TIMEOUT_MS) || 30000;
const CONCURRENCY = Number(process.env.SWARMBOX_CONCURRENCY) || 4;

// ── Failure classification ───────────────────────────────────────────────────
// Callers must be able to tell these apart, because the right response differs:
//
//   timeout   — the request ran out of time. This is the ONE failure where the slice
//               may genuinely be too heavy to serve, so splitting it into smaller
//               slices is a legitimate response.
//   transient — Swarmbox is unhealthy (5xx, 429, connection reset). Retry the SAME
//               request with backoff. Do NOT split: more calls against a struggling
//               API is exactly how a blip turns into an outage.
//   permanent — 4xx. The request is malformed or the data isn't there. Retrying or
//               splitting changes nothing; give up and report it.
//
// Conflating "failed" with "too big" is what let a single timeout fan out into
// thousands of calls (see catalog.js).
//
// "Ran out of time" arrives in three disguises, and missing any of them means a
// heavy slice gets dropped instead of split:
//   - status 0 + abort  — OUR AbortController fired (exceeded SWARMBOX_TIMEOUT_MS).
//   - 504 / 408         — Swarmbox's own gateway gave up on the query first. Very
//                         common on wide 360-day pricing batches.
//   - 500 + "statement timeout" — Postgres cancelled the query server-side.
const isTimeout = (res) =>
  (res.status === 0 && /abort/i.test(res.text || ''))
  || res.status === 504 || res.status === 408
  || /statement timeout|canceling statement|query timeout/i.test(res.text || '');
const isTransient = (res) =>
  res.status === 0 || res.status === 429 || (res.status >= 500 && res.status <= 599);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry a Swarmbox call on transient failure with exponential backoff + jitter.
// Returns the last result — success or not — so callers keep their { ok, ... }
// contract and never see a throw.
//
// `retryOn` lets a caller opt out of retrying a failure it has a better answer for.
// catalog.js passes one that excludes timeouts: when a slice is too heavy to serve
// in 30s, re-requesting the SAME heavy slice twice more just burns another 60s
// before splitting it anyway — the split is the fix, so go there immediately.
async function withRetry(fn, { attempts = 3, baseMs = 500, label = '', retryOn = isTransient } = {}) {
  let res = await fn();
  for (let i = 1; i < attempts && !res.ok && retryOn(res) && !breakerOpen(); i++) {
    const wait = Math.round(baseMs * 2 ** (i - 1) * (0.75 + Math.random() * 0.5));
    console.warn(`[Swarmbox] ${label || 'call'} failed (${res.status || 'err'}) — retry ${i}/${attempts - 1} in ${wait}ms`);
    await sleep(wait);
    res = await fn();
  }
  return res;
}

// ── Circuit breaker ──────────────────────────────────────────────────────────
// Last line of defence: if Swarmbox is failing consistently, stop calling it for a
// cooldown instead of letting every module retry into a brownout. Any single
// success resets it. Generous threshold — this should only ever trip in a real
// outage, never on normal intermittent errors.
const BREAKER_FAILS = Number(process.env.SWARMBOX_BREAKER_FAILS) || 40;
const BREAKER_COOLDOWN_MS = Number(process.env.SWARMBOX_BREAKER_COOLDOWN_MS) || 60000;
const BREAKER_ENABLED = process.env.SWARMBOX_BREAKER !== 'off';
let consecutiveFails = 0;
let breakerUntil = 0;

function breakerOpen() {
  return BREAKER_ENABLED && Date.now() < breakerUntil;
}
function noteResult(ok) {
  if (!BREAKER_ENABLED) return;
  if (ok) { consecutiveFails = 0; return; }
  if (++consecutiveFails >= BREAKER_FAILS && !breakerOpen()) {
    breakerUntil = Date.now() + BREAKER_COOLDOWN_MS;
    consecutiveFails = 0;
    console.error(`[Swarmbox] CIRCUIT OPEN — ${BREAKER_FAILS} consecutive failures; pausing all calls for ${BREAKER_COOLDOWN_MS}ms`);
  }
}
const BREAKER_RESULT = { ok: false, status: 0, text: 'circuit open (Swarmbox failing — calls paused)' };

// Some product codes arrive short ("18", "601") and Swarmbox stores them
// 6-digit zero-padded. Normalize before every call.
function normalizeItemCode(code) {
  return String(code ?? '').trim().padStart(6, '0');
}

// Rolling worker pool — keeps at most `limit` calls in flight at once
// (better than fixed chunks: a slow item can't stall the next batch).
async function mapWithConcurrency(list, limit, worker) {
  const out = new Array(list.length);
  let cursor = 0;
  const runner = async () => {
    while (cursor < list.length) {
      const i = cursor++;
      out[i] = await worker(list[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, runner));
  return out;
}

// Process-wide semaphore, with a reserved lane for user-facing calls.
//
// This used to be one FIFO queue on the assumption that "each route call makes one
// Swarmbox RPC, so this only matters when concurrent route calls land". That is no
// longer true: the catalog sweep fires ~120 calls at once and the price build
// hundreds more. With a single queue, a page that needs one fresh call (e.g.
// /api/production/dates) lands BEHIND the entire multi-minute build and just spins
// — the background rebuild starves the interactive pages.
//
// So calls are split into two classes:
//   foreground (default) — someone is waiting on it. Served first, may use every slot.
//   background           — the sweep / price build / summary backfill. Capped at
//                          CONCURRENCY - RESERVED so at least one slot is ALWAYS
//                          free for a user request, no matter how big the build is.
const RESERVED = Math.min(
  Number(process.env.SWARMBOX_RESERVED_SLOTS) || 1,
  Math.max(1, CONCURRENCY - 1),
);
const BG_LIMIT = Math.max(1, CONCURRENCY - RESERVED);

let inFlight = 0;
let bgInFlight = 0;
const fgWaiters = [];
const bgWaiters = [];

const canRun = (bg) => inFlight < CONCURRENCY && (!bg || bgInFlight < BG_LIMIT);

function take(bg) {
  inFlight++;
  if (bg) bgInFlight++;
}

function acquireSlot(bg) {
  if (canRun(bg)) { take(bg); return Promise.resolve(); }
  return new Promise((resolve) => (bg ? bgWaiters : fgWaiters).push(resolve));
}

// Hand the freed slot on, foreground first — a waiting page must never sit behind
// the remainder of a background build.
function pump() {
  while (fgWaiters.length && canRun(false)) { take(false); fgWaiters.shift()(); }
  while (bgWaiters.length && canRun(true)) { take(true); bgWaiters.shift()(); }
}

function releaseSlot(bg) {
  inFlight--;
  if (bg) bgInFlight--;
  pump();
}

// p_items wire format. Swagger documents a JSON string array; some PostgREST
// setups want a Postgres array-literal string instead. Probe on first call
// (one extra round trip on cold start) then cache.
let pItemsFormat = null; // 'json' | 'pg-literal' | null
function toPgArrayLiteral(items) {
  return '{' + items.map((c) => `"${String(c).replace(/"/g, '\\"')}"`).join(',') + '}';
}
function applyPItemsFormat(body) {
  if (Array.isArray(body && body.p_items) && pItemsFormat === 'pg-literal') {
    return { ...body, p_items: toPgArrayLiteral(body.p_items) };
  }
  return body;
}

// One POST attempt. Never throws — returns { ok, status, data?, text? }.
async function postOnce(rpcName, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${SWARMBOX_BASE_URL}/rpc/${rpcName}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ok: false, status: response.status, text };
    }
    const data = await response.json();
    return { ok: true, status: response.status, data: Array.isArray(data) ? data : [] };
  } catch (err) {
    return { ok: false, status: 0, text: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

// POST to a PostgREST RPC. Never throws.
// On first call with an array p_items, if PostgREST rejects the function
// signature, retries once with the Postgres array-literal form and caches
// the working format for the rest of the process.
//
// Pass { background: true } for bulk work nobody is waiting on (the sweep, the
// price build, the summary backfill) so it can't consume the slots a page needs.
async function postRpc(rpcName, body, { background = false } = {}) {
  if (breakerOpen()) return BREAKER_RESULT;
  await acquireSlot(background);
  try {
    const hasArrayItems = Array.isArray(body && body.p_items);
    let result = await postOnce(rpcName, applyPItemsFormat(body));

    if (!result.ok && hasArrayItems && pItemsFormat === null) {
      const sigError =
        result.status === 404 ||
        /PGRST20[02]|could not find the function|function .* does not exist|signature/i.test(result.text || '');
      if (sigError) {
        pItemsFormat = 'pg-literal';
        console.log('[Swarmbox] p_items: falling back to Postgres array-literal');
        result = await postOnce(rpcName, { ...body, p_items: toPgArrayLiteral(body.p_items) });
      }
    } else if (result.ok && hasArrayItems && pItemsFormat === null) {
      pItemsFormat = 'json';
      console.log('[Swarmbox] p_items: using JSON array');
    }

    noteResult(result.ok);
    return result;
  } finally {
    releaseSlot(background);
  }
}

// GET a PostgREST table/view (e.g. "sales_demand?item=in.(...)"). Same no-auth,
// same timeout + concurrency guardrail as postRpc. Never throws — returns
// { ok, status, data?, text? }.
async function getRows(pathAndQuery, { background = false } = {}) {
  if (breakerOpen()) return BREAKER_RESULT;
  await acquireSlot(background);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${SWARMBOX_BASE_URL}/${pathAndQuery}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      noteResult(false);
      return { ok: false, status: response.status, text };
    }
    const data = await response.json();
    noteResult(true);
    return { ok: true, status: response.status, data: Array.isArray(data) ? data : [] };
  } catch (err) {
    noteResult(false);
    return { ok: false, status: 0, text: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
    releaseSlot(background);
  }
}

module.exports = {
  postRpc, getRows, normalizeItemCode, mapWithConcurrency,
  withRetry, isTimeout, isTransient, breakerOpen,
};
