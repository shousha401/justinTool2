// production.js — daily production margin report from Swarmbox.
//
// For a given production day, Swarmbox's `production_output_cost` RPC returns one
// row per finished-good line with cases, pounds, input (raw-material) cost, and
// sell value already computed. We classify each line as TOLL (we processed a
// customer's own meat for a fee — the batch shows ~$0 input cost, OR the item has
// a real external toll price) or OWN (we own the meat and sell it), compute gross
// profit, and roll it up by room and by customer.
//
//   - OWN  : revenue = sell value (total_sales_cost), cost = input cost.
//   - TOLL : revenue = toll rate × lbs, cost = $0.
//
// Toll rate is pulled LIVE: the item's most recent real CMP-tier sale price
// (company "CMP", price > 0) from sales_order_lines IS the toll fee billed to the
// toll customer (One World, Sugar Mountain, Gourmet, Diestel…). We reuse the
// values tab's pricing engine for that. Items with no recent toll sale fall back
// to the contract rate tables in tollRates.js (clearly labeled), so nothing
// silently drops.
//
// Read-only. Cached per date (short TTL — today's numbers move during the shift).

const { postRpc } = require('./swarmbox');
const { tollRate, parseCustomer, ROOM_LABEL } = require('./tollRates');
const manualRates = require('./manualRates');
const classOverrides = require('./classOverrides');
const customerOverrides = require('./customerOverrides');
const priceOverrides = require('./priceOverrides');
const itemSpecs = require('./itemSpecs');
const dbStore = require('./db');

const TTL_MS = Number(process.env.PRODUCTION_CACHE_TTL_MS) || 5 * 60 * 1000; // 5 min
const RECENT_WINDOW_DAYS = 45;      // how far back the date picker / period comparisons look
const SUMMARY_VERSION = 5;          // bump when the stored summary shape OR the numbers behind it change (forces re-backfill)
const TOLL_IC_PER_LB = 0.10;        // batch avg input cost below this ⇒ customer-supplied meat ⇒ toll
const TOLL_LOOKBACK_DAYS = Number(process.env.TOLL_LOOKBACK_DAYS) || 90; // freshness window for the live toll price

const num = (v) => (v == null ? 0 : Number(v) || 0);
function ymd(d) { return d.toISOString().slice(0, 10); }
const shortCust = (c) => String(c || '').split(/[(,]/)[0].trim();

// ── Live sale prices ─────────────────────────────────────────────────────────
// We read each item's most recent real CMP-tier sale ($/lb, price > 0) from
// sales_order_lines and split it two ways:
//   any  — newest sale to ANY customer → used as OWN-product revenue. The
//          production module's own sell value (total_sales_cost) is often a flat
//          standard (e.g. 661922 is stamped $1.00/lb on every batch), so the real
//          last sale price is far more accurate; we fall back to the standard only
//          when there's no recent sale.
//   toll — newest sale to a TOLL-arrangement customer → used as the TOLL rate.
//          Toll accounts are tagged "(…-TOLL)" (One World, Sugar Mountain) plus
//          known partners without the tag (Gourmet, Diestel). We must NOT treat
//          meat-account ("…-MEAT"), street, or internal lines as toll fees — their
//          prices are product prices ($5–$49/lb). (Add a new toll partner here.)
const SALE_SELECT = 'item,delivery_date,price,price_uom,company,customer_name';
const SALE_RPC = `sales_order_lines?select=${SALE_SELECT}`;
const isTollCustomer = (name) => {
  const n = String(name || '').toUpperCase();
  return n.includes('TOLL') || n.startsWith('GOURMET BEEF') || n.startsWith('DIESTEL');
};

// Returns Map<item, { any, toll }> — newest CMP-tier sale to any / to a toll
// customer, each { price, lastSoldDate, customer } or null. Never throws.
async function fetchCmpSales(codes) {
  const out = new Map();
  if (!codes.length) return out;
  const end = new Date();
  const startYmd = ymd(new Date(end.getTime() - TOLL_LOOKBACK_DAYS * 86400000));
  const endYmd = ymd(end);
  const CHUNK = 100;
  for (let i = 0; i < codes.length; i += CHUNK) {
    const res = await postRpc(SALE_RPC, {
      p_items: codes.slice(i, i + CHUNK),
      p_start_delivery_date: startYmd,
      p_end_delivery_date: endYmd,
    });
    if (!res.ok) continue;
    for (const r of res.data) {
      if (String(r.company || '').toUpperCase() !== 'CMP') continue;     // CMP's own billings (not JD-tier street)
      const price = num(r.price);
      if (!(price > 0)) continue;                                        // skip $0 / placeholder lines
      if (String(r.price_uom || 'LB').toUpperCase() !== 'LB') continue;  // need a per-lb price
      const date = String(r.delivery_date || '');
      let rec = out.get(r.item);
      if (!rec) { rec = { any: null, toll: null }; out.set(r.item, rec); }
      const sale = { price, lastSoldDate: date, customer: r.customer_name };
      if (!rec.any || date > rec.any.lastSoldDate) rec.any = sale;
      if (isTollCustomer(r.customer_name) && (!rec.toll || date > rec.toll.lastSoldDate)) rec.toll = sale;
    }
  }
  return out;
}

// ── Date discovery ───────────────────────────────────────────────────────────
// Distinct production days in the recent window, newest first, with batch counts.
// Drives the picker and the "most recent day" default. Never throws.
let datesCache = null; // { list, builtAt }
async function recentDates() {
  if (datesCache && Date.now() - datesCache.builtAt < TTL_MS) return datesCache.list;
  const end = new Date();
  const start = new Date(end.getTime() - RECENT_WINDOW_DAYS * 86400000);
  const res = await postRpc('production_batch_summary', { p_start_date: ymd(start), p_end_date: ymd(end) });
  const counts = new Map();
  if (res.ok) for (const r of res.data) {
    const d = String(r.production_date || '').slice(0, 10);
    if (d) counts.set(d, (counts.get(d) || 0) + 1);
  }
  const list = [...counts.entries()]
    .map(([date, batches]) => ({ date, batches }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // newest first
  datesCache = { list, builtAt: Date.now() };
  return list;
}

async function mostRecentDate() {
  const list = await recentDates();
  return list.length ? list[0].date : ymd(new Date());
}

// ── Classification (per line, no revenue yet) ────────────────────────────────
// Toll detection (customer-supplied meat records ~$0 input cost) needs batch-
// level aggregates; the live rate's volume tier needs per-item daily pounds.
function classify(lines) {
  const batchAgg = new Map(); // batch -> { ic, lbs }
  const itemLbs = new Map();  // item  -> total lbs that day
  for (const r of lines) {
    const b = batchAgg.get(r.batch) || { ic: 0, lbs: 0 };
    b.ic += num(r.total_inventory_cost);
    b.lbs += num(r.cost_quantity);
    batchAgg.set(r.batch, b);
    itemLbs.set(r.item, (itemLbs.get(r.item) || 0) + num(r.cost_quantity));
  }
  const base = lines.map((r) => {
    // Customer attribution chain: a manual transfer (per item) wins; then the
    // authoritative spec-sheet customer; then the notes/description guess.
    const autoCustomer = parseCustomer(r.batch_notes, r.description);
    const specCustomer = itemSpecs.getCustomer(r.item) || null;
    const customerOverride = customerOverrides.getCustomer(r.item) || null;
    const customer = customerOverride || specCustomer || autoCustomer;
    const agg = batchAgg.get(r.batch) || { ic: 0, lbs: 0 };
    const batchAvgIC = agg.lbs ? agg.ic / agg.lbs : 0;
    return {
      r,
      cs: num(r.base_quantity),
      lbs: num(r.cost_quantity),
      sellVal: num(r.total_sales_cost),
      inputCostRaw: num(r.total_inventory_cost),
      customer, autoCustomer, specCustomer, customerOverride,
      // Preliminary signal: the batch barely had input cost ⇒ customer supplied
      // the meat. Finalized in getProductionReport (a real toll price also counts).
      // "JD Food" is our own in-house production (the old "CMP" bucket) — never toll.
      lowInputCost: customer !== 'JD Food' && batchAvgIC < TOLL_IC_PER_LB,
      isToll: false,
    };
  });
  return { base, itemLbs };
}

// ── Report build ─────────────────────────────────────────────────────────────
// livePrices: Map<item, { price, lastSoldDate, customer }> — most recent CMP-tier
// toll sale within the lookback window.
function buildReport(date, base, itemLbs, yieldByBatch, sales) {
  const counts = { live: 0, manual: 0, contract: 0, sale: 0, missing: 0 };
  const ownCounts = { sale: 0, manual: 0, standard: 0, none: 0 };
  let forcedCount = 0, flaggedCount = 0;

  const rows = base.map(({ r, cs, lbs, sellVal, inputCostRaw, customer, autoCustomer, specCustomer, customerOverride, isToll, autoToll, override }) => {
    let revenue, inputCost, rate, source, missingRate = false, priceBasis;
    const rec = sales.get(r.item);
    const forced = priceOverrides.get(r.item); // authoritative correction (wins over Swarmbox)
    if (forced && forced.flagged) flaggedCount++;

    if (forced && forced.rate > 0) {
      // A typed correction WINS over everything Swarmbox pulls (live/own/sale/
      // contract/standard) — this is the "Swarmbox is wrong; here's the right
      // number" override on the Prices Today page.
      rate = forced.rate;
      inputCost = isToll ? 0 : inputCostRaw;
      revenue = rate * lbs;
      source = `forced $${rate.toFixed(2)}/lb${forced.note ? ' · ' + forced.note : ''}`;
      priceBasis = 'forced';
      forcedCount++;
    } else if (isToll) {
      inputCost = 0;
      const live = rec && rec.toll;
      const manual = manualRates.getRate(r.item);
      if (live && live.price > 0) {
        rate = live.price;
        revenue = rate * lbs;
        source = `live $${rate.toFixed(2)}/lb · ${shortCust(live.customer)} ${live.lastSoldDate || ''}`.trim();
        priceBasis = 'live';
        counts.live++;
      } else if (manual != null && manual > 0) {
        rate = manual;
        revenue = manual * lbs;
        source = `manual $${manual.toFixed(2)}/lb`;
        priceBasis = 'manual';
        counts.manual++;
      } else {
        const { rate: rt } = tollRate(r.item, itemLbs.get(r.item) || lbs);
        const sale = rec && rec.any;
        if (rt != null) {
          rate = rt;
          revenue = rt * lbs;
          source = `contract $${rt.toFixed(2)}/lb (no live sale)`;
          priceBasis = 'contract';
          counts.contract++;
        } else if (sale && sale.price > 0) {
          // No toll fee on file, but the item has a real sale — use it so the line
          // isn't a phantom $0 (and a Toll/Own flip always keeps a number).
          rate = sale.price;
          revenue = rate * lbs;
          source = `sale $${rate.toFixed(2)}/lb · ${shortCust(sale.customer)} (no toll rate)`;
          priceBasis = 'sale';
          counts.sale++;
        } else {
          rate = null; revenue = 0; source = null; missingRate = true; priceBasis = 'none';
          counts.missing++;
        }
      }
    } else {
      inputCost = inputCostRaw;
      const sale = rec && rec.any;
      const manual = manualRates.getRate(r.item);
      if (sale && sale.price > 0) {
        // Real revenue = the price CMP last actually billed for this item.
        rate = sale.price;
        revenue = rate * lbs;
        source = `sale $${rate.toFixed(2)}/lb · ${shortCust(sale.customer)} ${sale.lastSoldDate || ''}`.trim();
        priceBasis = 'own';
        ownCounts.sale++;
      } else if (manual != null && manual > 0) {
        // A hand-entered price fills the gap until a real sale appears.
        rate = manual;
        revenue = manual * lbs;
        source = `manual $${manual.toFixed(2)}/lb`;
        priceBasis = 'manual';
        ownCounts.manual++;
      } else if (sellVal > 0) {
        // No sale or manual — fall back to the production module's sell value.
        revenue = sellVal;
        rate = lbs ? revenue / lbs : null;
        source = 'production value';
        priceBasis = 'own';
        ownCounts.standard++;
      } else {
        // Nothing anywhere — show $0 with an editable box (saved, used until a sale appears).
        rate = null; revenue = 0; source = null; missingRate = true; priceBasis = 'none';
        ownCounts.none++;
      }
    }
    const gp = revenue - inputCost;

    return {
      batch: r.batch,
      item: r.item,
      description: r.description || '',
      room: ROOM_LABEL[r.production_room] || r.production_room || '',
      process: r.production_process || '',
      notes: r.batch_notes || '',
      customer,
      autoCustomer,
      specCustomer: specCustomer || null,
      customerOverride: customerOverride || null,
      isToll,
      autoToll: !!autoToll,
      override: override || null,
      cs, lbs, rate, revenue, inputCost, gp,
      source, missingRate, priceBasis,
      // Price-override surface for the Prices Today page.
      forced: !!(forced && forced.rate > 0),
      flagged: !!(forced && forced.flagged),
      wrongBasis: forced ? forced.wrongBasis : null,
      wrongSource: forced ? forced.wrongSource : null,
      forcedNote: forced ? forced.note : '',
      yieldPct: yieldByBatch.get(r.batch) ?? null,
    };
  });

  // Rollups
  const roomMap = new Map();
  const custMap = new Map();
  const totals = { cs: 0, lbs: 0, rev: 0, ic: 0, gp: 0, tollRev: 0, ownRev: 0 };
  const missingSet = new Set();
  for (const r of rows) {
    const rm = roomMap.get(r.room) || { room: r.room, cs: 0, lbs: 0, rev: 0, ic: 0, gp: 0 };
    rm.cs += r.cs; rm.lbs += r.lbs; rm.rev += r.revenue; rm.ic += r.inputCost; rm.gp += r.gp;
    roomMap.set(r.room, rm);

    const cm = custMap.get(r.customer) || { customer: r.customer, isToll: r.isToll, cs: 0, lbs: 0, rev: 0, ic: 0, gp: 0 };
    cm.cs += r.cs; cm.lbs += r.lbs; cm.rev += r.revenue; cm.ic += r.inputCost; cm.gp += r.gp;
    custMap.set(r.customer, cm);

    totals.cs += r.cs; totals.lbs += r.lbs; totals.rev += r.revenue;
    totals.ic += r.inputCost; totals.gp += r.gp;
    totals[r.isToll ? 'tollRev' : 'ownRev'] += r.revenue;
    if (r.missingRate) missingSet.add(`${r.customer}/${r.item}`);
  }

  return {
    date,
    builtAt: Date.now(),
    totals,
    tollPricing: counts,       // toll line counts: { live, manual, contract, missing }
    ownPricing: ownCounts,     // own line counts: { sale, standard }
    forcedCount, flaggedCount, // price-override line counts (Prices Today page)
    rooms: [...roomMap.values()].sort((a, b) => (a.room < b.room ? -1 : a.room > b.room ? 1 : 0)),
    customers: [...custMap.values()].sort((a, b) => b.rev - a.rev),
    rows,
    missing: [...missingSet],
  };
}

// ── Public API (cached per date) ─────────────────────────────────────────────
const reportCache = new Map(); // date -> { report, builtAt }

async function getProductionReport({ date, force = false } = {}) {
  const day = date || (await mostRecentDate());
  const hit = reportCache.get(day);
  if (!force && hit && Date.now() - hit.builtAt < TTL_MS) return hit.report;

  const [outRes, sumRes] = await Promise.all([
    postRpc('production_output_cost', { p_date: day, p_product_designation: 'Finished Good' }),
    postRpc('production_batch_summary', { p_date: day }),
  ]);
  const lines = outRes.ok ? outRes.data : [];
  const yieldByBatch = new Map();
  if (sumRes.ok) for (const s of sumRes.data) {
    if (s.batch != null) yieldByBatch.set(s.batch, s.yield_pct != null ? Number(s.yield_pct) : null);
  }

  const { base, itemLbs } = classify(lines);

  // One sales lookup for every item that day → real prices for both toll (toll
  // rate) and own (actual revenue, vs the production standard sell value).
  const allCodes = [...new Set(base.map((b) => b.r.item))];
  const sales = await fetchCmpSales(allCodes);

  // Finalize toll classification. A manual Toll/Own override wins; otherwise a
  // non-CMP line is toll if the customer supplied the meat (≈$0 input) OR the item
  // has a recent real toll price. autoToll records what the rule alone would say
  // (so the UI can show "Auto (Toll/Own)").
  for (const b of base) {
    const rec = sales.get(b.r.item);
    const hasToll = !!(rec && rec.toll);
    const hasSale = !!(rec && rec.any);
    // Low input cost flags a likely toll job — but only when the item has no
    // ordinary sale. If there's a real CMP sale (to a non-toll customer), it's an
    // own product that merely recorded ~$0 input this batch, not a toll job.
    const auto = b.customer !== 'JD Food' && (hasToll || (b.lowInputCost && !hasSale));
    const ov = classOverrides.getMode(b.r.item);
    b.autoToll = auto;
    b.override = ov || null;
    b.isToll = ov ? ov === 'toll' : auto;
  }

  const report = buildReport(day, base, itemLbs, yieldByBatch, sales);
  report.unavailable = !outRes.ok; // Swarmbox errored for this day — not a real $0
  reportCache.set(day, { report, builtAt: Date.now() });
  // Only persist days that actually loaded — never store a misleading $0 for a
  // day whose output fetch errored (e.g. Swarmbox's intermittent 400 on some days).
  if (outRes.ok) {
    try { dbStore.saveProdSummary(summarize(report)); } catch (e) { console.error('[Production] summary save failed:', e && e.message); }
  }
  const c = report.tollPricing;
  console.log(`[Production] ${day}: ${outRes.ok ? report.rows.length + ' lines' : 'UNAVAILABLE (Swarmbox error)'}, GP $${Math.round(report.totals.gp).toLocaleString()} (toll: ${c.live} live, ${c.contract} contract, ${c.missing} missing)`);
  return report;
}

// A cheap fingerprint of all user overrides (manual rates, toll/own class,
// customer transfers, price corrections). Stored alongside each daily summary so
// that changing ANY override marks the affected days stale — the Dashboard and
// Customers tab then recompute them, so a transfer/correction "updates
// everything", not just today's live report.
function overrideSignature() {
  const lists = [manualRates.getList(), classOverrides.getList(), customerOverrides.getList(), priceOverrides.getList()];
  let total = 0, latest = '';
  for (const list of lists) {
    total += list.length;
    for (const r of list) if (r.updatedAt && r.updatedAt > latest) latest = r.updatedAt;
  }
  // Fold in the spec-sheet dataset so a re-import (new item-specs.json) also
  // marks stored summaries stale and triggers a recompute.
  return `${total}@${latest}|${itemSpecs.fingerprint}`;
}

// Condense a day's report into a stored summary for the Owner's Dashboard and the
// Customers tab: per customer { totals, toll/own split, and their per-item rollup }.
function summarize(report) {
  const custMap = new Map();
  for (const r of report.rows) {
    let c = custMap.get(r.customer);
    if (!c) { c = { customer: r.customer, lbs: 0, rev: 0, ic: 0, gp: 0, tollRev: 0, ownRev: 0, _items: new Map() }; custMap.set(r.customer, c); }
    c.lbs += r.lbs; c.rev += r.revenue; c.ic += r.inputCost; c.gp += r.gp;
    if (r.isToll) c.tollRev += r.revenue; else c.ownRev += r.revenue;
    let it = c._items.get(r.item);
    if (!it) { it = { item: r.item, description: r.description, lbs: 0, rev: 0, ic: 0, gp: 0 }; c._items.set(r.item, it); }
    it.lbs += r.lbs; it.rev += r.revenue; it.ic += r.inputCost; it.gp += r.gp;
  }
  const customers = [...custMap.values()].map(({ _items, ...rest }) => ({ ...rest, items: [..._items.values()] }));
  return { date: report.date, builtAt: report.builtAt, lines: report.rows.length, v: SUMMARY_VERSION, ov: overrideSignature(), totals: report.totals, customers };
}

// Ensure the last `days` production days have a CURRENT-version stored summary
// (computes any missing or out-of-date — building a day saves its summary).
async function backfillSummaries(days = 30) {
  const dates = (await recentDates()).slice(0, days).map((d) => d.date);
  if (!dates.length) return { requested: 0, filled: 0 };
  const sig = overrideSignature();
  const stored = new Map(dbStore.loadProdSummaries(dates[dates.length - 1], dates[0]).map((s) => [s.date, s]));
  // Recompute a day if it's missing, built by an older code version, or built
  // before the current set of overrides (a transfer/correction since then).
  const todo = dates.filter((d) => { const s = stored.get(d); return !s || s.v !== SUMMARY_VERSION || s.ov !== sig; });
  for (const d of todo) {
    try { await getProductionReport({ date: d }); } catch (e) { /* keep going */ }
  }
  if (todo.length) console.log(`[Production] backfilled ${todo.length} day summaries`);
  return { requested: dates.length, filled: todo.length };
}

// Drop cached reports so the next request recomputes (e.g. after a manual rate
// change). Cheap — a day's report is a single Swarmbox call.
function clearCache() { reportCache.clear(); }

// Rebuild the recent stored daily summaries in the background after an override
// change, so the Dashboard/Customers tab reflect it without the user waiting.
// Debounced + coalesced: only one rebuild runs at a time; edits during a run
// queue exactly one more pass. (The dashboards also self-heal on load via the
// override-signature check, so this is just to get there sooner.)
let refreshing = false, refreshQueued = false;
function refreshSummariesInBackground(days = 30) {
  if (refreshing) { refreshQueued = true; return; }
  refreshing = true;
  (async () => {
    try {
      do {
        refreshQueued = false;
        await backfillSummaries(days);
      } while (refreshQueued);
    } catch (e) {
      console.error('[Production] background summary refresh failed:', e && e.message);
    } finally {
      refreshing = false;
    }
  })();
}

module.exports = { getProductionReport, recentDates, mostRecentDate, clearCache, backfillSummaries, refreshSummariesInBackground };
