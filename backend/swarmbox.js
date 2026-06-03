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

// Process-wide semaphore. Each route call makes one Swarmbox RPC, so this only
// matters when concurrent route calls land (multi-tab, future parallelism),
// but it's a cheap guardrail that keeps the back end bounded.
let inFlight = 0;
const waiters = [];
function acquireSlot() {
  if (inFlight < CONCURRENCY) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}
function releaseSlot() {
  const next = waiters.shift();
  if (next) { next(); return; }
  inFlight--;
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
async function postRpc(rpcName, body) {
  await acquireSlot();
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

    return result;
  } finally {
    releaseSlot();
  }
}

// GET a PostgREST table/view (e.g. "sales_demand?item=in.(...)"). Same no-auth,
// same timeout + concurrency guardrail as postRpc. Never throws — returns
// { ok, status, data?, text? }.
async function getRows(pathAndQuery) {
  await acquireSlot();
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
      return { ok: false, status: response.status, text };
    }
    const data = await response.json();
    return { ok: true, status: response.status, data: Array.isArray(data) ? data : [] };
  } catch (err) {
    return { ok: false, status: 0, text: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
    releaseSlot();
  }
}

module.exports = { postRpc, getRows, normalizeItemCode, mapWithConcurrency };
