// valuation.js — join the in-stock catalog with last-sold prices (both tiers)
// into the value table, and cache the result so page loads don't trigger a fresh
// sweep.
//
// Each row carries two prices, both = most recent real sale (price > 0) in the
// lookback window:
//   - cmpValue : CMP -> JD     (internal / production price)
//   - jdValue  : JD -> customer (street price)
// Either may be null ("no recent sale" in that tier). We never substitute a
// number that isn't an actual selling price.
//
// A single in-flight build is shared by concurrent callers so a burst of
// requests (or a refresh mid-load) can't kick off two simultaneous sweeps.

const { sweepCatalog } = require('./catalog');
const { lastPrices } = require('./pricing');
const { getCodes: discontinuedCodes } = require('./discontinued');

const TTL_MS = Number(process.env.VALUE_CACHE_TTL_MS) || 6 * 60 * 60 * 1000;
const LOOKBACK_DAYS = Number(process.env.VALUE_LOOKBACK_DAYS) || 360;

let cache = null;      // { rows, builtAt, buildMs, lookbackDays, itemCount, pricedJd, pricedCmp }
let building = null;   // Promise<cache> while a build is in flight

async function build() {
  const startedAt = Date.now();
  const catalog = await sweepCatalog();                 // [{ item, description }]
  // Drop discontinued codes BEFORE pricing — they never hit the price API.
  const disc = discontinuedCodes();
  const active = disc.size ? catalog.filter((c) => !disc.has(c.item)) : catalog;
  const prices = await lastPrices(active.map((c) => c.item), LOOKBACK_DAYS);

  let pricedJd = 0;
  let pricedCmp = 0;
  const rows = active.map((c) => {
    const p = prices.get(c.item);
    const jd = p && p.jd;
    const cmp = p && p.cmp;
    if (jd) pricedJd++;
    if (cmp) pricedCmp++;
    return {
      productCode: c.item,
      description: c.description || '',
      // CMP -> JD (internal / production price)
      cmpValue: cmp ? cmp.price : null,
      cmpValueUom: cmp ? (cmp.priceUom || null) : null,
      cmpLastSoldDate: cmp ? (cmp.lastSoldDate || null) : null,
      // JD -> customer (street price)
      jdValue: jd ? jd.price : null,
      jdValueUom: jd ? (jd.priceUom || null) : null,
      jdLastSoldDate: jd ? (jd.lastSoldDate || null) : null,
      jdCustomer: jd ? (jd.customer || null) : null,
      hasCmp: !!cmp,
      hasJd: !!jd,
    };
  });

  cache = {
    rows,
    builtAt: Date.now(),
    buildMs: Date.now() - startedAt,
    lookbackDays: LOOKBACK_DAYS,
    itemCount: rows.length,
    pricedJd,
    pricedCmp,
    discontinued: disc.size,
  };
  console.log(`[Valuation] built ${rows.length} rows (JD-priced ${pricedJd}, CMP-priced ${pricedCmp}, ${disc.size} discontinued skipped) in ${cache.buildMs}ms`);
  return cache;
}

// Live-cache helpers so a discontinue action takes effect instantly without
// waiting for a full rebuild.
function getCachedRows() { return cache ? cache.rows : null; }

function dropFromCache(codes) {
  if (!cache) return 0;
  const before = cache.rows.length;
  cache.rows = cache.rows.filter((r) => !codes.has(r.productCode));
  const removed = before - cache.rows.length;
  if (removed) {
    let jd = 0, cmp = 0;
    for (const r of cache.rows) { if (r.hasJd) jd++; if (r.hasCmp) cmp++; }
    cache.itemCount = cache.rows.length;
    cache.pricedJd = jd;
    cache.pricedCmp = cmp;
  }
  return removed;
}

// Returns the cached value table, rebuilding if stale or forced. Concurrent
// callers share one build.
async function getValues({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.builtAt < TTL_MS) return cache;
  if (!building) {
    building = build().finally(() => { building = null; });
  }
  return building;
}

module.exports = { getValues, getCachedRows, dropFromCache };
