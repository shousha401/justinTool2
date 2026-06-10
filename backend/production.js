// production.js — daily production margin report from Swarmbox.
//
// For a given production day, Swarmbox's `production_output_cost` RPC returns one
// row per finished-good line with cases, pounds, input (raw-material) cost, and
// sell value already computed. We classify each line as TOLL (we processed a
// customer's own meat for a fee — input cost ~$0) or OWN (we own the meat and
// sell it), compute gross profit, and roll it up by room and by customer.
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

const TTL_MS = Number(process.env.PRODUCTION_CACHE_TTL_MS) || 5 * 60 * 1000; // 5 min
const RECENT_WINDOW_DAYS = 21;      // how far back the date picker looks
const TOLL_IC_PER_LB = 0.10;        // batch avg input cost below this ⇒ customer-supplied meat ⇒ toll
const TOLL_LOOKBACK_DAYS = Number(process.env.TOLL_LOOKBACK_DAYS) || 90; // freshness window for the live toll price

const num = (v) => (v == null ? 0 : Number(v) || 0);
function ymd(d) { return d.toISOString().slice(0, 10); }
const shortCust = (c) => String(c || '').split(/[(,]/)[0].trim();

// ── Live toll rate ───────────────────────────────────────────────────────────
// The toll fee billed to the customer who owns the meat = the item's most recent
// real CMP-tier sale ($/lb, price > 0) to an EXTERNAL customer. Internal lines
// (JD Food transfers, CMP itself) are not toll billings — including them would
// pick up product/transfer prices (e.g. $7/lb) instead of the toll fee.
const TOLL_SELECT = 'item,delivery_date,price,price_uom,company,customer_name';
const TOLL_RPC = `sales_order_lines?select=${TOLL_SELECT}`;
const isInternalCustomer = (name) => {
  const n = String(name || '').toUpperCase();
  return n.startsWith('JD FOOD') || n.includes('CERTIFIED MEAT');
};

// Returns Map<item, { price, lastSoldDate, customer }> — newest external toll
// billing per item within the freshness window. Never throws.
async function fetchTollRates(codes) {
  const out = new Map();
  if (!codes.length) return out;
  const end = new Date();
  const startYmd = ymd(new Date(end.getTime() - TOLL_LOOKBACK_DAYS * 86400000));
  const endYmd = ymd(end);
  const CHUNK = 100;
  for (let i = 0; i < codes.length; i += CHUNK) {
    const res = await postRpc(TOLL_RPC, {
      p_items: codes.slice(i, i + CHUNK),
      p_start_delivery_date: startYmd,
      p_end_delivery_date: endYmd,
    });
    if (!res.ok) continue;
    for (const r of res.data) {
      if (String(r.company || '').toUpperCase() !== 'CMP') continue;     // toll billings are CMP-company
      const price = num(r.price);
      if (!(price > 0)) continue;                                        // skip $0 / internal-zero lines
      if (String(r.price_uom || 'LB').toUpperCase() !== 'LB') continue;  // rate must be per-lb
      if (isInternalCustomer(r.customer_name)) continue;                 // exclude internal transfers
      const date = String(r.delivery_date || '');
      const cur = out.get(r.item);
      if (!cur || date > cur.lastSoldDate) out.set(r.item, { price, lastSoldDate: date, customer: r.customer_name });
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
      isToll: customer !== 'CMP' && batchAvgIC < TOLL_IC_PER_LB,
    };
  });
  return { base, itemLbs };
}

// ── Report build ─────────────────────────────────────────────────────────────
// livePrices: Map<item, { price, lastSoldDate, customer }> — most recent CMP-tier
// toll sale within the lookback window.
function buildReport(date, base, itemLbs, yieldByBatch, livePrices) {
  const counts = { live: 0, contract: 0, missing: 0 };

  const rows = base.map(({ r, cs, lbs, sellVal, inputCostRaw, customer, isToll }) => {
    let revenue, inputCost, rate, source, missingRate = false, priceBasis;

    if (isToll) {
      inputCost = 0;
      const live = livePrices.get(r.item);
      if (live && live.price > 0) {
        rate = live.price;
        revenue = rate * lbs;
        source = `live $${rate.toFixed(2)}/lb · ${shortCust(live.customer)} ${live.lastSoldDate || ''}`.trim();
        priceBasis = 'live';
        counts.live++;
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
      revenue = sellVal;
      inputCost = inputCostRaw;
      rate = lbs ? revenue / lbs : null;
      source = 'own: sell value';
      priceBasis = 'own';
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
    tollPricing: counts, // { live, contract, missing } line counts
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

  // Pull the live toll rate (most recent external CMP-tier sale) for the day's toll items.
  const tollCodes = [...new Set(base.filter((b) => b.isToll).map((b) => b.r.item))];
  const livePrices = await fetchTollRates(tollCodes);

  const report = buildReport(day, base, itemLbs, yieldByBatch, livePrices);
  reportCache.set(day, { report, builtAt: Date.now() });
  const c = report.tollPricing;
  console.log(`[Production] ${day}: ${report.rows.length} lines, GP $${Math.round(report.totals.gp).toLocaleString()} (toll rates: ${c.live} live, ${c.contract} contract, ${c.missing} missing)`);
  return report;
}

module.exports = { getProductionReport, recentDates, mostRecentDate };
