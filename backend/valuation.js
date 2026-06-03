// valuation.js — join the in-stock catalog with last-sold prices into the
// value table, and cache the result so page loads don't trigger a fresh sweep.
//
//   value = most recent selling price (any customer) within the lookback window.
//   Items with no sale in the window get value=null ("no recent sale") — we never
//   substitute a number that isn't an actual selling price.
//
// A single in-flight build is shared by concurrent callers so a burst of requests
// (or a refresh mid-load) can't kick off two simultaneous sweeps.

const { sweepCatalog } = require('./catalog');
const { lastPrices } = require('./pricing');

const TTL_MS = Number(process.env.VALUE_CACHE_TTL_MS) || 6 * 60 * 60 * 1000;
const LOOKBACK_DAYS = Number(process.env.VALUE_LOOKBACK_DAYS) || 360;

let cache = null;      // { rows, builtAt, lookbackDays, itemCount, pricedCount }
let building = null;   // Promise<cache> while a build is in flight

async function build() {
  const startedAt = Date.now();
  const catalog = await sweepCatalog();                 // [{ item, description }]
  const prices = await lastPrices(catalog.map((c) => c.item), LOOKBACK_DAYS);

  let pricedCount = 0;
  const rows = catalog.map((c) => {
    const p = prices.get(c.item);
    const hasRecentSale = !!(p && p.price != null);
    if (hasRecentSale) pricedCount++;
    return {
      productCode: c.item,
      description: c.description || '',
      value: hasRecentSale ? p.price : null,
      valueUom: hasRecentSale ? (p.priceUom || null) : null,
      orderUom: p ? (p.orderUom || null) : null,
      lastSoldDate: p ? (p.lastSoldDate || null) : null,
      customer: p ? (p.customer || null) : null,
      salesOrder: p ? (p.salesOrder || null) : null,
      hasRecentSale,
    };
  });

  cache = {
    rows,
    builtAt: Date.now(),
    buildMs: Date.now() - startedAt,
    lookbackDays: LOOKBACK_DAYS,
    itemCount: rows.length,
    pricedCount,
  };
  console.log(`[Valuation] built ${rows.length} rows (${pricedCount} priced) in ${cache.buildMs}ms`);
  return cache;
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

module.exports = { getValues };
