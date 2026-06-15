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
//
// The built table is persisted to SQLite (backend/db.js): on boot we load the
// last snapshot so the app serves instantly instead of cold-rebuilding, and we
// serve that (even if a day old) while a fresh build runs in the background — so
// no page load ever waits on the 2–3 min sweep once there's any saved data.

const { sweepCatalog } = require('./catalog');
const { lastPrices } = require('./pricing');
const { getCodes: discontinuedCodes } = require('./discontinued');
const valueOverrides = require('./valueOverrides');
const dbStore = require('./db');

const TTL_MS = Number(process.env.VALUE_CACHE_TTL_MS) || 6 * 60 * 60 * 1000;
const LOOKBACK_DAYS = Number(process.env.VALUE_LOOKBACK_DAYS) || 360;

let cache = null;      // { rows, builtAt, buildMs, lookbackDays, itemCount, pricedJd, pricedCmp }
let building = null;   // Promise<cache> while a build is in flight

// Local YYYY-MM-DD — the snapshot key (the build day in the VM's own clock).
function localYmd(d = new Date()) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// Overlay any manual value-override onto a row, per tier. The raw Swarmbox values
// are captured once (cmpRaw/jdRaw…) so we can show them alongside and flip back to
// them without a rebuild; the displayed cmpValue/jdValue become the *chosen*
// source (manual when picked, else the live last-sale). Idempotent — safe to
// re-run whenever an override changes. The DB snapshot stores the raw values
// (saved before this runs), so price history stays real-sales-only.
function decorate(row) {
  if (row.cmpRaw === undefined) {
    row.cmpRaw = row.cmpValue ?? null;
    row.cmpRawUom = row.cmpValueUom ?? null;
    row.cmpRawLastSold = row.cmpLastSoldDate ?? null;
    row.jdRaw = row.jdValue ?? null;
    row.jdRawUom = row.jdValueUom ?? null;
    row.jdRawLastSold = row.jdLastSoldDate ?? null;
    row.jdRawCustomer = row.jdCustomer ?? null;
  }
  const ov = valueOverrides.get(row.productCode);

  // CMP → JD (internal)
  const cmpManual = ov && ov.cmpManual > 0 ? ov.cmpManual : null;
  const useCmpManual = cmpManual != null && (!ov || ov.cmpUse !== 'swarmbox');
  if (useCmpManual) {
    row.cmpValue = cmpManual;
    row.cmpValueUom = (ov && ov.cmpUom) || 'LB';
    row.cmpLastSoldDate = null;
    row.cmpSource = 'manual';
  } else {
    row.cmpValue = row.cmpRaw;
    row.cmpValueUom = row.cmpRawUom;
    row.cmpLastSoldDate = row.cmpRawLastSold;
    row.cmpSource = 'swarmbox';
  }
  row.cmpManual = cmpManual;
  row.cmpManualUom = (ov && ov.cmpUom) || 'LB';
  row.cmpUse = useCmpManual ? 'manual' : 'swarmbox';

  // JD → customer (street)
  const jdManual = ov && ov.jdManual > 0 ? ov.jdManual : null;
  const useJdManual = jdManual != null && (!ov || ov.jdUse !== 'swarmbox');
  if (useJdManual) {
    row.jdValue = jdManual;
    row.jdValueUom = (ov && ov.jdUom) || 'LB';
    row.jdLastSoldDate = null;
    row.jdCustomer = null;
    row.jdSource = 'manual';
  } else {
    row.jdValue = row.jdRaw;
    row.jdValueUom = row.jdRawUom;
    row.jdLastSoldDate = row.jdRawLastSold;
    row.jdCustomer = row.jdRawCustomer;
    row.jdSource = 'swarmbox';
  }
  row.jdManual = jdManual;
  row.jdManualUom = (ov && ov.jdUom) || 'LB';
  row.jdUse = useJdManual ? 'manual' : 'swarmbox';

  row.ovNote = (ov && ov.note) || '';
  row.hasCmp = row.cmpValue != null;
  row.hasJd = row.jdValue != null;
  return row;
}

function recomputeCounts(c) {
  let cmp = 0, jd = 0;
  for (const r of c.rows) { if (r.hasCmp) cmp++; if (r.hasJd) jd++; }
  c.itemCount = c.rows.length;
  c.pricedCmp = cmp;
  c.pricedJd = jd;
}

// Re-apply one item's override to the live cache so an edit takes effect instantly
// (no 2–3 min rebuild). Returns the updated row, or null if it isn't in the cache.
function reapplyValueOverride(code) {
  if (!cache) return null;
  const row = cache.rows.find((r) => r.productCode === String(code).trim());
  if (!row) return null;
  decorate(row);
  recomputeCounts(cache);
  return row;
}

// Boot: seed the in-memory cache from the last saved snapshot (instant). It may
// be stale (yesterday's) — getValues serves it and refreshes in the background.
try {
  const snap = dbStore.loadLatest();
  if (snap) {
    const disc = discontinuedCodes();
    if (disc.size) {
      snap.rows = snap.rows.filter((r) => !disc.has(r.productCode));
      snap.discontinued = disc.size;
    }
    for (const r of snap.rows) decorate(r);   // overlay manual value-overrides
    recomputeCounts(snap);
    cache = snap;
    console.log(`[Valuation] loaded snapshot ${snap.snapshotDate} from db (${snap.itemCount} items)`);
  }
} catch (e) {
  console.error('[Valuation] db load failed (will build fresh):', e && e.message);
}

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

  // Persist this build as today's snapshot (history) using the RAW Swarmbox
  // values — overrides are a serve-time overlay, so price history stays
  // real-sales-only. A DB hiccup must never fail the build.
  try {
    dbStore.saveSnapshot(localYmd(), rows, cache);
  } catch (e) {
    console.error('[Valuation] snapshot save failed:', e && e.message);
  }

  // Now overlay manual value-overrides onto the live cache and recount.
  for (const r of cache.rows) decorate(r);
  recomputeCounts(cache);
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

function startBuild() {
  if (!building) building = build().finally(() => { building = null; });
  return building;
}

// Returns the value table. `force` always rebuilds and waits. Otherwise: if we
// have a cached table, return it instantly — kicking off a background refresh if
// it's gone stale — so a page load never blocks on the sweep once data exists.
// Only the very first build ever (empty DB) makes a caller wait.
async function getValues({ force = false } = {}) {
  if (force) return startBuild();
  if (cache) {
    if (Date.now() - cache.builtAt >= TTL_MS && !building) {
      startBuild().catch((e) => console.error('[Valuation] background refresh failed:', e && e.message));
    }
    return cache;
  }
  return startBuild();
}

module.exports = { getValues, getCachedRows, dropFromCache, reapplyValueOverride, priceHistory: dbStore.priceHistory };
