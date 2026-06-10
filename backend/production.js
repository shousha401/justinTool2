// production.js — daily production margin report from Swarmbox.
//
// For a given production day, Swarmbox's `production_output_cost` RPC returns one
// row per finished-good line with cases, pounds, input (raw-material) cost, and
// sell value already computed. We classify each line as TOLL (we processed a
// customer's own meat for a fee — input cost ~$0) or OWN (we own the meat and
// sell it), compute gross profit, and roll it up by room and by customer.
//
//   - OWN  : revenue = sell value (total_sales_cost), cost = input cost.
//   - TOLL : revenue = contract toll rate × lbs (see tollRates.js), cost = $0.
//
// Read-only. Reuses the Swarmbox client verbatim. Cached per date so repeat loads
// don't re-hit the API (short TTL — today's numbers move during the shift).

const { postRpc } = require('./swarmbox');
const { tollRate, parseCustomer, ROOM_LABEL } = require('./tollRates');

const TTL_MS = Number(process.env.PRODUCTION_CACHE_TTL_MS) || 5 * 60 * 1000; // 5 min
const RECENT_WINDOW_DAYS = 21;      // how far back the date picker looks
const TOLL_IC_PER_LB = 0.10;        // batch avg input cost below this ⇒ customer-supplied meat ⇒ toll

const num = (v) => (v == null ? 0 : Number(v) || 0);
function ymd(d) { return d.toISOString().slice(0, 10); }

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

// ── Report build ─────────────────────────────────────────────────────────────
function buildReport(date, lines, yieldByBatch) {
  // Batch-level input cost & pounds → toll detection (customer-supplied meat
  // records ~$0 input cost). Per-item daily pounds → contract rate volume tier.
  const batchAgg = new Map(); // batch -> { ic, lbs }
  const itemLbs = new Map();  // item  -> total lbs that day
  for (const r of lines) {
    const b = batchAgg.get(r.batch) || { ic: 0, lbs: 0 };
    b.ic += num(r.total_inventory_cost);
    b.lbs += num(r.cost_quantity);
    batchAgg.set(r.batch, b);
    itemLbs.set(r.item, (itemLbs.get(r.item) || 0) + num(r.cost_quantity));
  }

  const rows = lines.map((r) => {
    const cs = num(r.base_quantity);
    const lbs = num(r.cost_quantity);
    const sellVal = num(r.total_sales_cost);
    const inputCostRaw = num(r.total_inventory_cost);
    const customer = parseCustomer(r.batch_notes);
    const agg = batchAgg.get(r.batch) || { ic: 0, lbs: 0 };
    const batchAvgIC = agg.lbs ? agg.ic / agg.lbs : 0;
    const isToll = customer !== 'CMP' && batchAvgIC < TOLL_IC_PER_LB;

    let revenue, inputCost, rate, source, missingRate = false;
    if (isToll) {
      const { rate: rt, source: src } = tollRate(r.item, itemLbs.get(r.item) || lbs);
      rate = rt;
      revenue = rt != null ? rt * lbs : 0;
      source = rt != null ? src : null;
      inputCost = 0;
      missingRate = rt == null;
    } else {
      revenue = sellVal;
      inputCost = inputCostRaw;
      rate = lbs ? revenue / lbs : null;
      source = 'own: sell value';
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
      source, missingRate,
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

  const report = buildReport(day, lines, yieldByBatch);
  reportCache.set(day, { report, builtAt: Date.now() });
  console.log(`[Production] ${day}: ${report.rows.length} FG lines, GP $${Math.round(report.totals.gp).toLocaleString()}`);
  return report;
}

module.exports = { getProductionReport, recentDates, mostRecentDate };
