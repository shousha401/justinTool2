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

const TTL_MS = Number(process.env.PRODUCTION_CACHE_TTL_MS) || 5 * 60 * 1000; // 5 min
const RECENT_WINDOW_DAYS = 21;      // how far back the date picker looks
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
    const customer = parseCustomer(r.batch_notes);
    const agg = batchAgg.get(r.batch) || { ic: 0, lbs: 0 };
    const batchAvgIC = agg.lbs ? agg.ic / agg.lbs : 0;
    return {
      r,
      cs: num(r.base_quantity),
      lbs: num(r.cost_quantity),
      sellVal: num(r.total_sales_cost),
      inputCostRaw: num(r.total_inventory_cost),
      customer,
      // Preliminary signal: the batch barely had input cost ⇒ customer supplied
      // the meat. Finalized in getProductionReport (a real toll price also counts).
      lowInputCost: customer !== 'CMP' && batchAvgIC < TOLL_IC_PER_LB,
      isToll: false,
    };
  });
  return { base, itemLbs };
}

// ── Report build ─────────────────────────────────────────────────────────────
// livePrices: Map<item, { price, lastSoldDate, customer }> — most recent CMP-tier
// toll sale within the lookback window.
function buildReport(date, base, itemLbs, yieldByBatch, sales) {
  const counts = { live: 0, manual: 0, contract: 0, missing: 0 };
  const ownCounts = { sale: 0, standard: 0 };

  const rows = base.map(({ r, cs, lbs, sellVal, inputCostRaw, customer, isToll, autoToll, override }) => {
    let revenue, inputCost, rate, source, missingRate = false, priceBasis;
    const rec = sales.get(r.item);

    if (isToll) {
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
        if (rt != null) {
          rate = rt;
          revenue = rt * lbs;
          source = `contract $${rt.toFixed(2)}/lb (no live sale)`;
          priceBasis = 'contract';
          counts.contract++;
        } else {
          rate = null; revenue = 0; source = null; missingRate = true; priceBasis = 'none';
          counts.missing++;
        }
      }
    } else {
      inputCost = inputCostRaw;
      const sale = rec && rec.any;
      if (sale && sale.price > 0) {
        // Real revenue = the price CMP last actually billed for this item.
        rate = sale.price;
        revenue = rate * lbs;
        source = `sale $${rate.toFixed(2)}/lb · ${shortCust(sale.customer)} ${sale.lastSoldDate || ''}`.trim();
        priceBasis = 'own';
        ownCounts.sale++;
      } else {
        // No recent sale — fall back to the production module's sell value.
        revenue = sellVal;
        rate = lbs ? revenue / lbs : null;
        source = 'production value';
        priceBasis = 'own';
        ownCounts.standard++;
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
      isToll,
      autoToll: !!autoToll,
      override: override || null,
      cs, lbs, rate, revenue, inputCost, gp,
      source, missingRate, priceBasis,
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
    const auto = b.customer !== 'CMP' && (b.lowInputCost || !!(rec && rec.toll));
    const ov = classOverrides.getMode(b.r.item);
    b.autoToll = auto;
    b.override = ov || null;
    b.isToll = ov ? ov === 'toll' : auto;
  }

  const report = buildReport(day, base, itemLbs, yieldByBatch, sales);
  reportCache.set(day, { report, builtAt: Date.now() });
  const c = report.tollPricing;
  console.log(`[Production] ${day}: ${report.rows.length} lines, GP $${Math.round(report.totals.gp).toLocaleString()} (toll rates: ${c.live} live, ${c.contract} contract, ${c.missing} missing)`);
  return report;
}

// Drop cached reports so the next request recomputes (e.g. after a manual rate
// change). Cheap — a day's report is a single Swarmbox call.
function clearCache() { reportCache.clear(); }

module.exports = { getProductionReport, recentDates, mostRecentDate, clearCache };
