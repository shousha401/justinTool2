// catalog.js — discover every in-stock product code via a Swarmbox wildcard sweep.
//
// Swarmbox's `inventory_detail` RPC accepts a SQL LIKE wildcard on p_item
// (e.g. "05%"), and every returned lot row carries its own `item` + `description`.
// So sweeping by code prefix and de-duping the `item` column gives us the live
// universe of product codes that currently have stock — no hardcoded item list.
//
// We sweep all two-digit prefixes ("00".."99"), bounded by swarmbox.js's
// process-wide concurrency semaphore. Each call is projected to just
// `item,description` to stay light.
//
// SUBDIVIDE ONLY WHEN THE SLICE IS TOO BIG — NOT WHEN THE CALL FAILED.
// A prefix is split into its ten finer children when it comes back oversized
// (>= ROW_BUDGET rows), or when it times out — a timeout genuinely can mean "too
// many rows to serve in time". Any OTHER failure (5xx, connection reset, 4xx) is
// retried in place with backoff and, if it still won't come back, recorded as a
// failed slice.
//
// Splitting on a plain failure is a request storm: the ten children hit the same
// unhealthy API, and when they fail too each spawns ten more. From a 2-digit seed
// down to MAX_DEPTH that is 10 + 100 + 1,000 + 10,000 = 11,110 calls from ONE bad
// prefix — and ~1.1M if all 100 seeds are failing. It is also self-reinforcing:
// the harder we hit a struggling Swarmbox, the more calls time out, the more we
// fan out. CALL_BUDGET is the backstop if the logic above is ever wrong again.
//
// A sweep that loses slices returns degraded:true, so valuation.js can refuse to
// overwrite a good snapshot with a partial catalog. Read-only.

const { getRows, withRetry, isTimeout, isTransient } = require('./swarmbox');

const ROW_BUDGET = Number(process.env.CATALOG_ROW_BUDGET) || 40000;
const MAX_DEPTH = 6;  // product codes are 6 digits — never subdivide past that
const ATTEMPTS = Number(process.env.CATALOG_ATTEMPTS) || 3;      // tries per prefix before it's a failed slice
const CALL_BUDGET = Number(process.env.CATALOG_CALL_BUDGET) || 1500; // hard ceiling on calls per sweep

function twoDigitSeeds() {
  const seeds = [];
  for (let a = 0; a <= 9; a++) for (let b = 0; b <= 9; b++) seeds.push(`${a}${b}`);
  return seeds; // "00".."99"
}

// One prefix, with in-place retry on a genuine error. Never throws.
//
// Timeouts are deliberately NOT retried here: a timeout is the signal that this
// slice may be too heavy to serve, and the caller's response to that is to SPLIT
// it. Retrying the same oversized slice twice more just burns 60s before we split
// anyway. Every other transient failure (5xx, reset) is retried in place.
//
// `used` = actual HTTP calls made, so the caller can budget against real traffic
// rather than prefix count.
async function sweepPrefix(prefix) {
  const q = `rpc/inventory_detail?p_item=${encodeURIComponent(prefix + '%')}&select=item,description`;
  let used = 0;
  const res = await withRetry(
    // background: nobody is waiting on the sweep, and it fires ~120 calls at once —
    // it must not be allowed to occupy every Swarmbox slot and starve the pages.
    () => { used++; return getRows(q, { background: true }); },
    { attempts: ATTEMPTS, label: `catalog ${prefix}%`, retryOn: (r) => isTransient(r) && !isTimeout(r) },
  );
  return { prefix, res, used };
}

// Returns { items: [{ item, description }], degraded, failed, calls }.
// `degraded` = at least one slice of the code space could not be read, so the
// item list is INCOMPLETE and must not be treated as the authoritative universe.
// Never throws.
async function sweepCatalog() {
  const found = new Map(); // item code -> description (first seen wins)
  const failed = [];       // prefixes we could not read at all
  let queue = twoDigitSeeds();
  let calls = 0;
  let budgetHit = false;

  while (queue.length && !budgetHit) {
    // One round: all queued prefixes fire together; the semaphore bounds how many
    // actually hit Swarmbox at once. `queue.length` is the floor on the calls this
    // round will make (one per prefix, more only if a prefix retries) — refuse to
    // start a round we already can't afford. Only the fan-out path grows the queue,
    // and that path never retries, so the floor is exact where it matters.
    if (calls + queue.length > CALL_BUDGET) {
      console.error(`[Catalog] call budget ${CALL_BUDGET} would be exceeded (${calls} used, ${queue.length} queued) — aborting sweep`);
      failed.push(...queue);
      budgetHit = true;
      break;
    }

    const results = await Promise.all(queue.map(sweepPrefix));
    for (const r of results) calls += r.used;   // real HTTP calls, not prefix count
    const next = [];

    for (const { prefix, res } of results) {
      const canSplit = prefix.length < MAX_DEPTH;

      if (res.ok) {
        if (res.data.length >= ROW_BUDGET && canSplit) {
          // Genuinely too dense to trust as one slice — split it. Children cover
          // the same codes, so nothing is lost by not reading this slice's rows.
          for (let d = 0; d <= 9; d++) next.push(prefix + d);
          continue;
        }
        for (const r of res.data) {
          const item = String(r.item || '').trim();
          if (item && !found.has(item)) found.set(item, r.description || '');
        }
        continue;
      }

      // Failed.
      if (isTimeout(res) && canSplit) {
        // A timeout is the one failure that may mean "this slice is too heavy to
        // serve in 30s". Splitting is a real fix here, and it's bounded by depth
        // and by CALL_BUDGET.
        console.warn(`[Catalog] ${prefix}% timed out — splitting (slice may be too heavy)`);
        for (let d = 0; d <= 9; d++) next.push(prefix + d);
        continue;
      }

      // Swarmbox is erroring on this slice (or we're at max depth). Splitting would
      // only multiply the load without fixing anything — record the loss instead.
      failed.push(prefix);
      console.error(`[Catalog] ${prefix}% unreadable (${res.status || 'err'}): ${(res.text || '').slice(0, 80)}`);
    }
    queue = next;
  }

  const items = [...found.entries()]
    .map(([item, description]) => ({ item, description }))
    .sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));

  const degraded = failed.length > 0;
  console.log(
    `[Catalog] swept ${calls} prefixes → ${items.length} distinct in-stock items`
    + (degraded ? ` — DEGRADED: ${failed.length} slice(s) unreadable (${failed.slice(0, 8).join(', ')}${failed.length > 8 ? '…' : ''})` : '')
  );
  return { items, degraded, failed, calls };
}

module.exports = { sweepCatalog };
