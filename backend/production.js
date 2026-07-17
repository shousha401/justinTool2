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

const { postRpc, withRetry } = require('./swarmbox');
const { tollRate, parseCustomer, ROOM_LABEL } = require('./tollRates');
const manualRates = require('./manualRates');
const classOverrides = require('./classOverrides');
const customerOverrides = require('./customerOverrides');
const priceOverrides = require('./priceOverrides');
const costOverrides = require('./costOverrides');
const itemSpecs = require('./itemSpecs');
const dbStore = require('./db');

const TTL_MS = Number(process.env.PRODUCTION_CACHE_TTL_MS) || 5 * 60 * 1000; // 5 min
const RECENT_WINDOW_DAYS = 45;      // how far back the date picker / period comparisons look
const SUMMARY_VERSION = 9;          // bump when the stored summary shape OR the numbers behind it change (forces re-backfill)
                                    // v8: chained-batch netting (cutting→packaging same-item double-count)
                                    // v9: chained-draw re-costing (WIP blended-average dilution)
const TOLL_IC_PER_LB = 0.10;        // batch avg input cost below this ⇒ customer-supplied meat ⇒ toll
const TOLL_LOOKBACK_DAYS = Number(process.env.TOLL_LOOKBACK_DAYS) || 90; // freshness window for the live toll price

// Manual supplement to the AUTO-detection of internal intermediates (see
// buildReport): codes we always want treated as input-cost-only even if a given
// day's input feed doesn't catch them. Auto-detection (an output line that is also
// consumed as a component that day AND has no sale of its own — e.g. 662139 grind →
// patties) handles new intermediates with no list to maintain; this is the fallback.
const INTERNAL_CODES = new Set(['662523']);

const num = (v) => (v == null ? 0 : Number(v) || 0);
// LOCAL calendar date, not UTC. toISOString() would roll over to tomorrow every
// afternoon (5pm Pacific = next day UTC), so "today" — and every window that ends
// at today — would silently point at a production day that hasn't happened yet.
function ymd(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
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

// Returns { sales, ok }.
//   sales — Map<item, { any, toll }>, newest CMP-tier sale to any / to a toll
//           customer, each { price, lastSoldDate, customer } or null.
//   ok    — false if ANY chunk failed after retries.
//
// `ok` is not cosmetic. This map does not just decorate the report — it DRIVES it:
// classification reads hasToll/hasSale from it, and the rate falls out of it. A
// silently-dropped chunk therefore does two expensive things at once:
//   1. Toll lines flip to OWN (no toll sale visible ⇒ auto-toll says "own"), which
//      un-zeroes their input cost and craters the margin.
//   2. Own lines lose their real sale price and fall back to the production
//      standard sell value — often a flat placeholder ($1.00/lb).
// Both produce a plausible-looking report full of wrong money. So a failure here
// must fail the DAY, not quietly reshape it. Never throws.
async function fetchCmpSales(codes, background = false) {
  const out = new Map();
  if (!codes.length) return { sales: out, ok: true };
  const end = new Date();
  const startYmd = ymd(new Date(end.getTime() - TOLL_LOOKBACK_DAYS * 86400000));
  const endYmd = ymd(end);
  const CHUNK = 100;
  const chunks = [];
  for (let i = 0; i < codes.length; i += CHUNK) chunks.push(codes.slice(i, i + CHUNK));

  // Parallel (the swarmbox semaphore still caps real concurrency), each chunk
  // retried on transient failure rather than abandoned on the first blip.
  const results = await Promise.all(chunks.map((chunk) => withRetry(
    () => postRpc(SALE_RPC, { p_items: chunk, p_start_delivery_date: startYmd, p_end_delivery_date: endYmd }, { background }),
    { attempts: 3, label: `sales ${chunk.length} items` },
  )));

  let failed = 0;
  for (const res of results) {
    if (!res.ok) { failed++; continue; }
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
  if (failed) {
    console.error(`[Production] ${failed}/${chunks.length} sales chunk(s) unreadable after retries — this day's margin cannot be trusted`);
  }
  return { sales: out, ok: failed === 0 };
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
      batchAvgIC,
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
// Where a line's "raw material (input cost)" actually comes from.
//
// Swarmbox hands us total_inventory_cost on the output line — we do NOT compute it.
// It equals (this line's lbs) × (the batch's average input $/lb), so it only charges
// the pounds that came OUT. The pounds that went in but didn't come out — yield loss —
// carry real cost that lands on no product line and is therefore subtracted from
// nobody's gross profit. Surface it rather than charging it: changing it would move
// every GP number in the app, and that's a business decision, not a bug fix.
function rawMaterialTrace(r, inputCost, lbs, batchInputs, batchOutputs, costOv, replacedCost) {
  const bin = batchInputs && batchInputs.get(r.batch);
  const bout = batchOutputs && batchOutputs.get(r.batch);
  const trace = {
    charged: inputCost,                       // what THIS line carries
    perLb: lbs ? inputCost / lbs : null,      // derived for display — NOT a source number
    // Set when a manual cost override is in effect — charged above is the forced
    // rate × lbs; replaced* is what the line would otherwise carry (the chained
    // re-cost if one applied, else Swarmbox's number). The Swarmbox blended figure
    // stays visible via recost.blendedCharged when a re-cost also happened.
    override: costOv
      ? {
          rate: costOv.rate,
          batch: costOv.batch || null,        // null = applies to every batch of the item
          note: costOv.note || '',
          replacedCost,
          replacedPerLb: lbs ? replacedCost / lbs : null,
        }
      : null,
    // Set when this batch drew same-day WIP whose blended average hid the real
    // cost — absent a manual override, charged above is the re-costed number;
    // blended* is what Swarmbox said.
    recost: r._recostScale
      ? { blendedCharged: r._recostScale.blendedCost, blendedPerLb: lbs ? r._recostScale.blendedCost / lbs : null }
      : null,
    components: bin ? bin.components : null,  // what was actually consumed into the batch
    batch: null,
  };
  if (bin && bout) {
    const unallocated = bin.cost - bout.cost;
    trace.batch = {
      inputLbs: bin.lbs,
      inputCost: bin.cost,
      outputLbs: bout.lbs,
      outputCost: bout.cost,
      unallocatedCost: unallocated,
      unallocatedLbs: bin.lbs - bout.lbs,
      yieldPct: bin.lbs ? (bout.lbs / bin.lbs) * 100 : null,
      // This line's share of the batch's charged cost, so a multi-output batch
      // (patties flat + patties round) is legible.
      shareOfBatch: bout.cost ? (inputCost / bout.cost) * 100 : null,
    };
  }
  return trace;
}

function buildReport(date, base, itemLbs, yieldByBatch, sales, consumed, batchInputs, batchOutputs, outputsByItem) {
  const counts = { live: 0, manual: 0, contract: 0, sale: 0, missing: 0 };
  const ownCounts = { sale: 0, manual: 0, standard: 0, none: 0 };
  let forcedCount = 0, flaggedCount = 0, internalCount = 0, costForcedCount = 0;

  const rows = base.map(({ r, cs, lbs, sellVal, inputCostRaw, batchAvgIC, customer, autoCustomer, specCustomer, customerOverride, isToll, autoToll, override, hasTollSale, hasSale }) => {
    let revenue, inputCost, rate, source, missingRate = false, priceBasis, internal = false;
    const rec = sales.get(r.item);
    const forced = priceOverrides.get(r.item); // authoritative correction (wins over Swarmbox)
    // Manual raw-material correction (the cost-side twin of the forced price).
    // Precedence: manual cost override > chained re-cost > Swarmbox blended —
    // inputCostRaw already carries the re-cost when one applied, and the override
    // beats both. Money only: classification (batch avg IC) never sees it, and a
    // toll line still zeroes its cost below regardless.
    const costOv = costOverrides.get(r.item, r.batch);
    const inputCostEff = costOv ? costOv.rate * lbs : inputCostRaw;
    if (costOv && !isToll) costForcedCount++;
    // Internal intermediate: this item is consumed as a component into another batch
    // today AND has no sale value of its own (e.g. 662139 grind → patties). The static
    // INTERNAL_CODES list is a manual fallback. Either way it's input-cost-only and
    // kept OUT of the margin totals — its cost lands on the finished good downstream.
    const consumedRec = consumed && consumed.get(r.item);
    // Chained batches: cutting → packaging where BOTH batches record the same
    // finished good (Justin's 10152733/10152732 tenderloins — both billed $2.35/lb,
    // doubling the day's money). This line is the UPSTREAM copy when a DIFFERENT
    // batch consumed this item AND re-output it (a pass-through, not an ingredient
    // draw — an ingredient draw doesn't re-output the same code, and netting on
    // consumption alone would kill real revenue on items that also sell as-is).
    // The 60% coverage floor keeps a small side-stream draw from silently netting
    // a line that mostly shipped. Same-batch consumption (partial-case rescans,
    // Justin's other 12 notes) never counts: b !== this line's batch.
    let chainedLbs = 0;
    if (consumedRec && consumedRec.byBatch) {
      const outSet = outputsByItem && outputsByItem.get(r.item);
      for (const [b, l] of consumedRec.byBatch) {
        if (b !== String(r.batch) && outSet && outSet.has(b)) chainedLbs += l;
      }
    }
    const chainedUpstream = lbs > 0 && chainedLbs >= lbs * 0.6;
    const autoInternal = (!!consumedRec && !(sellVal > 0)) || chainedUpstream;
    const isInternal = INTERNAL_CODES.has(r.item) || autoInternal;
    if (forced && forced.flagged) flaggedCount++;

    if (isInternal) {
      // Internal intermediate (auto-detected as consumed-downstream-with-no-sale, or
      // on the static INTERNAL_CODES list). Value it at INPUT COST ONLY and keep it
      // out of the margin totals: its cost is realized on the finished good it feeds,
      // so counting it here too would double-count and show a phantom loss.
      // NOTE: this is checked BEFORE the forced price on purpose — a forced rate on a
      // consumed intermediate would add phantom revenue here while its cost still
      // lands on the finished good downstream (double-count). Forcing a price can't
      // turn an intermediate into a sold good; it stays input-cost-only.
      internal = true;
      internalCount++;
      inputCost = isToll ? 0 : inputCostEff;
      revenue = 0;
      rate = null;
      source = chainedUpstream
        ? 'chained into another batch · counted once on the final output'
        : autoInternal
          ? 'internal intermediate · input cost only (reused downstream)'
          : 'internal trim · input cost only';
      priceBasis = 'internal';
    } else if (forced && forced.rate > 0) {
      // A typed correction WINS over everything Swarmbox pulls (live/own/sale/
      // contract/standard) — this is the "Swarmbox is wrong; here's the right
      // number" override on the Prices Today page.
      rate = forced.rate;
      inputCost = isToll ? 0 : inputCostEff;
      revenue = rate * lbs;
      source = `forced $${rate.toFixed(2)}/lb${forced.note ? ' · ' + forced.note : ''}`;
      priceBasis = 'forced';
      forcedCount++;
    } else if (isToll) {
      inputCost = 0;
      const live = rec && rec.toll;
      const sale = rec && rec.any;
      const manual = manualRates.getRate(r.item);
      if (live && live.price > 0) {
        rate = live.price;
        revenue = rate * lbs;
        source = `live $${rate.toFixed(2)}/lb · ${shortCust(live.customer)} ${live.lastSoldDate || ''}`.trim();
        priceBasis = 'live';
        counts.live++;
      } else if (sale && sale.price > 0) {
        // Prefer the item's most recent REAL sale over the contract rate tables.
        // The contract sheets are a stale fallback ported from the old prototype;
        // the actual recent sale is the truth. Contract is used only when there is
        // no sale at all (below). This is why e.g. Miami 064718 now prices off its
        // real ~$0.79 sale instead of the blanket 064* "MRCC steak" $2.75 contract.
        rate = sale.price;
        revenue = rate * lbs;
        source = `sale $${rate.toFixed(2)}/lb · ${shortCust(sale.customer)} ${sale.lastSoldDate || ''}`.trim();
        priceBasis = 'sale';
        counts.sale++;
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
          source = `contract $${rt.toFixed(2)}/lb (no recent sale)`;
          priceBasis = 'contract';
          counts.contract++;
        } else {
          rate = null; revenue = 0; source = null; missingRate = true; priceBasis = 'none';
          counts.missing++;
        }
      }
    } else {
      inputCost = inputCostEff;
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
    // Internal intermediates are input-cost-only and excluded from the totals, so
    // their line shows no gain/loss (the real margin is on the finished good they feed).
    const gp = internal ? 0 : revenue - inputCost;

    // Full provenance for the per-line "how we got this number" drill-down: every
    // candidate considered for customer, Toll/Own, and the rate — not just the
    // winner — plus the arithmetic behind revenue/cost/GP.
    const liveToll = rec && rec.toll ? { price: rec.toll.price, customer: rec.toll.customer, date: rec.toll.lastSoldDate } : null;
    const anySale = rec && rec.any ? { price: rec.any.price, customer: rec.any.customer, date: rec.any.lastSoldDate } : null;
    const manualRate = manualRates.getRate(r.item);
    const contract = tollRate(r.item, itemLbs.get(r.item) || lbs);
    const trace = {
      customer: {
        chosen: customer,
        via: customerOverride ? 'transfer' : (specCustomer ? 'spec' : 'guess'),
        transfer: customerOverride || null,
        spec: specCustomer || null,
        guess: autoCustomer || null,
        notes: r.batch_notes || '',
        description: r.description || '',
      },
      type: {
        chosen: isToll ? 'toll' : 'own',
        via: override ? 'override' : 'auto',
        autoToll: !!autoToll,
        override: override || null,
        batchAvgIC,
        threshold: TOLL_IC_PER_LB,
        hasTollSale: !!hasTollSale,
        hasSale: !!hasSale,
        customerIsJdFood: customer === 'JD Food',
      },
      rate: {
        basis: priceBasis,
        chosen: rate,
        forced: forced && forced.rate > 0 ? forced.rate : null,
        live: liveToll,
        manual: manualRate != null && manualRate > 0 ? manualRate : null,
        contract: contract && contract.rate != null ? { rate: contract.rate, source: contract.source } : null,
        sale: anySale,
        productionValue: sellVal > 0 ? sellVal : null,
        internal: internal
          ? { auto: autoInternal, chained: chainedUpstream, chainedLbs: chainedUpstream ? chainedLbs : null, consumedLbs: consumedRec ? consumedRec.lbs : null }
          : null,
      },
      amounts: { cs, lbs, revenue, inputCost, inputCostRaw, gp, sellVal },
      // Provenance for "how did we get raw material?" — the components consumed into
      // this batch, and the yield loss that no product line carries. A toll line's
      // cost is $0 by definition, so a cost override is inert there (not passed).
      rawMaterial: rawMaterialTrace(r, inputCost, lbs, batchInputs, batchOutputs, isToll ? null : costOv, inputCostRaw),
    };

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
      internal,
      cs, lbs, rate, revenue, inputCost, gp,
      source, missingRate, priceBasis,
      // Cost-override surface (manual raw-material $/lb, set from the explainer).
      costForced: !isToll && !!costOv,
      // Price-override surface for the Prices Today page.
      forced: !!(forced && forced.rate > 0),
      flagged: !!(forced && forced.flagged),
      wrongBasis: forced ? forced.wrongBasis : null,
      wrongSource: forced ? forced.wrongSource : null,
      forcedNote: forced ? forced.note : '',
      yieldPct: yieldByBatch.get(r.batch) ?? null,
      trace,
    };
  });

  // Rollups
  const roomMap = new Map();
  const custMap = new Map();
  const totals = { cs: 0, lbs: 0, rev: 0, ic: 0, gp: 0, tollRev: 0, ownRev: 0 };
  const missingSet = new Set();
  for (const r of rows) {
    // Internal intermediates are input-cost-only — leave them out of every rollup and
    // total so their cost (already on the finished good they feed) isn't double-counted.
    if (r.internal) continue;
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

  // Day-level yield loss, rolled up per unique BATCH (a batch with two output lines
  // must not have its inputs counted twice). This is raw material that was consumed
  // but landed on no output line at all, so it is subtracted from nobody's gross
  // profit — GP is overstated by exactly this much. Reported, NOT charged: allocating
  // it would move every margin number in the app, which is a business decision.
  const rawMaterial = { consumed: 0, charged: 0, unallocated: 0, pct: null, batches: 0 };
  if (batchInputs && batchOutputs) {
    for (const [batch, out] of batchOutputs) {
      const inp = batchInputs.get(batch);
      if (!inp) continue;               // no recorded inputs (e.g. repack) — nothing to compare
      rawMaterial.consumed += inp.cost;
      rawMaterial.charged += out.cost;
      rawMaterial.batches++;
    }
    rawMaterial.unallocated = rawMaterial.consumed - rawMaterial.charged;
    rawMaterial.pct = rawMaterial.consumed ? (rawMaterial.unallocated / rawMaterial.consumed) * 100 : null;
  }

  return {
    date,
    builtAt: Date.now(),
    totals,
    rawMaterial,               // consumed vs charged: the yield loss no line carries
    tollPricing: counts,       // toll line counts: { live, manual, contract, missing }
    ownPricing: ownCounts,     // own line counts: { sale, standard }
    forcedCount, flaggedCount, // price-override line counts (Prices Today page)
    costForcedCount,           // lines whose raw-material cost is manually overridden
    internalCount,             // internal intermediates excluded from margin (input cost only)
    rooms: [...roomMap.values()].sort((a, b) => (a.room < b.room ? -1 : a.room > b.room ? 1 : 0)),
    customers: [...custMap.values()].sort((a, b) => b.rev - a.rev),
    rows,
    missing: [...missingSet],
  };
}

// ── Chained-draw re-costing ──────────────────────────────────────────────────
// Swarmbox costs a batch's DRAW of an item at that item's blended average — not at
// the cost of the sibling batch that actually produced it. When one WIP code pools
// customer-supplied ($0) and company-owned (real-cost) meat, the average dilutes:
// on 2026-07-15, 060269 (Mishima ground beef) was output by four grind batches —
// 780 lbs from CMP-owned trim at $4.71/lb and 7,008 lbs from Mishima's own $0
// trim — so every packaging batch drew it at the blended $0.47/lb. The own-meat
// chain was charged $368 instead of $3,673, the difference leaked onto the toll
// chains (whose input cost the report zeroes anyway), and the day's own-product GP
// was overstated ~$3.3k. The chained netting in buildReport assumes "the
// intermediate's cost is realized on the finished good downstream" — average
// costing breaks that promise; this pass restores it.
//
// Rule: a draw whose pounds match a SIBLING batch's same-day output of the same
// item (within 1%) is re-costed at that output line's actual cost, and the
// consuming batch's output lines are re-scaled off their ORIGINAL allocation (so
// Swarmbox's own by-weight split across multiple outputs is preserved). Anything
// ambiguous — no pounds match, competing producers at different $/lb, a partial
// draw — KEEPS the blended number: mis-attributing cost is worse than averaging
// it, so we only claim what the pounds prove. Runs to a fixpoint (≤3 passes) so a
// grind → blend → pack chain propagates; a batch never consumes its own output
// (same-batch rows are excluded), so it terminates.
//
// Mutates the fetched rows IN PLACE, before anything reads a cost — classification
// (batch avg IC), consumed/batchInputs/batchOutputs, and every line's inputCostRaw
// all flow from them. Originals are stashed on the rows (_recost on draws,
// _recostScale on outputs) so the explainer can show both numbers.
function recostChainedDraws(allOutputs, inputRows) {
  const lbsTol = (lbs) => Math.max(1, lbs * 0.01);

  // Producer side: every output line, claimable once — one batch's pounds can
  // only have fed one draw.
  const producersByItem = new Map(); // item -> [{ row, batch, lbs, claimed }]
  for (const r of allOutputs) {
    const lbs = num(r.cost_quantity);
    if (!(lbs > 0)) continue;
    const list = producersByItem.get(r.item) || [];
    list.push({ row: r, batch: String(r.batch), lbs, claimed: false });
    producersByItem.set(r.item, list);
  }

  // Match phase — by pounds, once. Costs can still move afterwards (a multi-hop
  // chain), so a match records WHO feeds the draw; the resolve phase below reads
  // the producer's then-current cost.
  const matches = [];
  for (const draw of inputRows) {
    const lbs = num(draw.cost_quantity);
    if (!(lbs > 0)) continue;
    const cands = (producersByItem.get(draw.item) || []).filter(
      (p) => !p.claimed && p.batch !== String(draw.batch) && Math.abs(p.lbs - lbs) <= lbsTol(lbs)
    );
    if (!cands.length) continue;
    // Two candidate producers telling different cost stories = we cannot know
    // which fed this draw — keep the blended number rather than guess.
    const perLb = cands.map((p) => num(p.row.total_inventory_cost) / p.lbs);
    if (Math.max(...perLb) - Math.min(...perLb) > 0.005) continue;
    cands[0].claimed = true;
    matches.push({ draw, producer: cands[0] });
  }
  if (!matches.length) return 0;

  // Originals — every re-scale derives from these, so repeated passes never compound.
  const origInputCost = new Map(); // batch -> input total as Swarmbox sent it
  const inputsByBatch = new Map(); // batch -> its draw rows
  for (const r of inputRows) {
    const b = String(r.batch);
    origInputCost.set(b, (origInputCost.get(b) || 0) + num(r.total_inventory_cost));
    const list = inputsByBatch.get(b) || [];
    list.push(r);
    inputsByBatch.set(b, list);
  }
  const outputsByBatch = new Map(); // batch -> its output rows
  for (const r of allOutputs) {
    const b = String(r.batch);
    const list = outputsByBatch.get(b) || [];
    list.push(r);
    outputsByBatch.set(b, list);
  }

  const recostedBatches = new Set();
  for (let pass = 0; pass < 3; pass++) {
    const dirty = new Set();
    for (const { draw, producer } of matches) {
      const actual = num(producer.row.total_inventory_cost);
      if (Math.abs(actual - num(draw.total_inventory_cost)) < 0.01) continue;
      if (!draw._recost) draw._recost = { blendedCost: num(draw.total_inventory_cost), fromBatch: producer.batch };
      draw.total_inventory_cost = actual;
      dirty.add(String(draw.batch));
      recostedBatches.add(String(draw.batch));
    }
    if (!dirty.size) break;
    // Re-spread each dirty batch's corrected input total over its outputs the way
    // Swarmbox allocates — scaled off the original allocation, preserving its
    // by-weight split (and its >100%-yield over-charge) exactly.
    for (const b of dirty) {
      const orig = origInputCost.get(b) || 0;
      if (!(orig > 0.005)) continue; // Swarmbox allocated nothing to outputs — nothing to re-scale
      const now = (inputsByBatch.get(b) || []).reduce((s, r) => s + num(r.total_inventory_cost), 0);
      const factor = now / orig;
      for (const row of outputsByBatch.get(b) || []) {
        if (!row._recostScale) row._recostScale = { blendedCost: num(row.total_inventory_cost) };
        row.total_inventory_cost = row._recostScale.blendedCost * factor;
        row._recostScale.factor = factor;
      }
    }
  }
  return recostedBatches.size;
}

// ── Public API (cached per date) ─────────────────────────────────────────────
const reportCache = new Map(); // date -> { report, builtAt }

// ── Failed-day backoff ───────────────────────────────────────────────────────
// A day whose Swarmbox fetch errors is (correctly) never persisted — but without
// this, "not persisted" reads as "missing" forever, and that spins a treadmill:
//
//   dashboard load → pendingSummaryDays sees the day missing → pending > 0
//   → refreshSummariesInBackground() → response says refreshing:true
//   → the page re-polls every few seconds → each poll sets refreshQueued
//   → the do/while in refreshSummariesInBackground never exits
//   → the broken day is re-fetched from Swarmbox every TTL, forever,
//     for as long as anyone has the tab open — and the UI says "updating…" forever.
//
// So: remember the days that failed, back off exponentially, and after
// MAX_DAY_ATTEMPTS stop retrying and report the day as genuinely unavailable.
// Any success clears the record.
const failedDays = new Map(); // date -> { attempts, retryAfter, givenUp }
const FAIL_BACKOFF_MS = [5 * 60e3, 15 * 60e3, 30 * 60e3, 60 * 60e3, 4 * 60 * 60e3];
const MAX_DAY_ATTEMPTS = Number(process.env.PRODUCTION_MAX_DAY_ATTEMPTS) || 6;

function noteDayFailed(day) {
  const f = failedDays.get(day) || { attempts: 0, retryAfter: 0, givenUp: false };
  f.attempts++;
  f.givenUp = f.attempts >= MAX_DAY_ATTEMPTS;
  const backoff = FAIL_BACKOFF_MS[Math.min(f.attempts - 1, FAIL_BACKOFF_MS.length - 1)];
  f.retryAfter = Date.now() + backoff;
  failedDays.set(day, f);
  console.warn(
    `[Production] ${day} unavailable (attempt ${f.attempts}/${MAX_DAY_ATTEMPTS})`
    + (f.givenUp ? ' — giving up; reporting it as unavailable' : ` — next retry in ${Math.round(backoff / 60e3)}m`)
  );
}
// May we (re)build this day right now? Retryable unless it's in backoff or we've
// given up on it entirely.
function dayRetryable(day) {
  const f = failedDays.get(day);
  if (!f) return true;
  if (f.givenUp) return false;
  return Date.now() >= f.retryAfter;
}
// `background: true` marks work nobody is waiting on (the 30-day summary backfill),
// so it can't occupy every Swarmbox slot and leave a page spinning. A report the
// Production tab actually asked for stays foreground.
async function getProductionReport({ date, force = false, background = false } = {}) {
  const day = date || (await mostRecentDate());
  const hit = reportCache.get(day);
  if (!force && hit && Date.now() - hit.builtAt < TTL_MS) return hit.report;

  const [outRes, sumRes, inRes] = await Promise.all([
    // NO p_product_designation filter. We still report only Finished Goods (filtered
    // below — verified to give byte-identical rows to the server-side filter), but we
    // need the OTHER outputs too: a batch also yields In-Process intermediates, and
    // those absorb raw-material cost. Without them we'd mistake "cost moved to the
    // intermediate" for "cost vanished". Same call count, strictly more truth.
    postRpc('production_output_cost', { p_date: day }, { background }),
    postRpc('production_batch_summary', { p_date: day }, { background }),
    postRpc('production_input_cost', { p_date: day }, { background }),
  ]);
  const allOutputs = outRes.ok ? outRes.data : [];
  // Undo WIP average-cost dilution FIRST — classification (batch avg IC), the
  // consumed/batchInputs/batchOutputs maps, and every line's inputCostRaw all read
  // these rows, so the correction has to land before any of them are built.
  const recostCount = inRes.ok && allOutputs.length ? recostChainedDraws(allOutputs, inRes.data) : 0;
  const isFinishedGood = (r) => String(r.product_designation || '').trim() === 'Finished Good';
  const lines = allOutputs.filter(isFinishedGood);

  // Items consumed as components today → drives auto-detection of internal
  // intermediates (an output that's reused into another batch with no sale of its own).
  // byBatch tracks WHO consumed it — chained-batch detection must ignore a batch
  // consuming its own item (partial-case rescans) and only count other batches.
  const consumed = new Map(); // item -> { lbs, cost, byBatch: Map(batch -> lbs) }
  // Per-BATCH raw material, so a line can show WHERE its cost came from instead of a
  // single opaque number. This is the provenance behind "raw material (input cost)".
  const batchInputs = new Map(); // batch -> { lbs, cost, components: [...] }
  if (inRes.ok) for (const r of inRes.data) {
    const c = consumed.get(r.item) || { lbs: 0, cost: 0, byBatch: new Map() };
    c.lbs += num(r.cost_quantity);
    c.cost += num(r.total_inventory_cost);
    c.byBatch.set(String(r.batch), (c.byBatch.get(String(r.batch)) || 0) + num(r.cost_quantity));
    consumed.set(r.item, c);

    const b = batchInputs.get(r.batch) || { lbs: 0, cost: 0, components: [] };
    const lbs = num(r.cost_quantity);
    const cost = num(r.total_inventory_cost);
    b.lbs += lbs;
    b.cost += cost;
    b.components.push({
      item: r.item,
      description: r.description || '',
      lbs,
      cost,
      perLb: lbs ? cost / lbs : null,
      // Set when this draw was re-costed past the item's blended average to the
      // producing batch's actual cost (see recostChainedDraws).
      recost: r._recost
        ? { fromBatch: r._recost.fromBatch, blendedCost: r._recost.blendedCost, blendedPerLb: lbs ? r._recost.blendedCost / lbs : null }
        : null,
    });
    batchInputs.set(r.batch, b);
  }

  // What each batch actually CHARGED to its outputs — every output, finished good or
  // not. The gap against batchInputs is raw material that landed on no product at all
  // (yield loss / shrink), and therefore is subtracted from nobody's gross profit.
  const batchOutputs = new Map(); // batch -> { lbs, cost }
  // Which batches output each item — the other half of chained-batch detection
  // (a batch that consumed an item AND re-output it is passing it through).
  const outputsByItem = new Map(); // item -> Set(batch)
  for (const r of allOutputs) {
    const b = batchOutputs.get(r.batch) || { lbs: 0, cost: 0 };
    b.lbs += num(r.cost_quantity);
    b.cost += num(r.total_inventory_cost);
    batchOutputs.set(r.batch, b);
    const s = outputsByItem.get(r.item) || new Set();
    s.add(String(r.batch));
    outputsByItem.set(r.item, s);
  }

  const yieldByBatch = new Map();
  if (sumRes.ok) for (const s of sumRes.data) {
    if (s.batch != null) yieldByBatch.set(s.batch, s.yield_pct != null ? Number(s.yield_pct) : null);
  }

  const { base, itemLbs } = classify(lines);

  // One sales lookup for every item that day → real prices for both toll (toll
  // rate) and own (actual revenue, vs the production standard sell value).
  const allCodes = [...new Set(base.map((b) => b.r.item))];
  const { sales, ok: salesOk } = await fetchCmpSales(allCodes, background);

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
    // Low input alone is NOT enough: an own product can legitimately record ~$0
    // input on a given batch (components issued on another batch/day, or a data
    // gap) with no sale in the window — flipping it to toll would silently zero
    // its real cost and overstate GP. Require a corroborating signal: the item is
    // a recognized toll family (has a contract rate). True toll jobs with no
    // contract rate and no toll sale stay Own (conservative) and can be forced via
    // the Toll/Own override.
    const hasContractRate = tollRate(b.r.item, itemLbs.get(b.r.item) || b.lbs).rate != null;
    const auto = b.customer !== 'JD Food' && (hasToll || (b.lowInputCost && !hasSale && hasContractRate));
    const ov = classOverrides.getMode(b.r.item);
    b.autoToll = auto;
    b.override = ov || null;
    b.isToll = ov ? ov === 'toll' : auto;
    b.hasTollSale = hasToll;
    b.hasSale = hasSale;
  }

  const report = buildReport(day, base, itemLbs, yieldByBatch, sales, consumed, batchInputs, batchOutputs, outputsByItem);
  report.recostCount = recostCount; // batches re-costed past a blended WIP average

  // A day is TRUSTWORTHY only if every input behind its money came back.
  //   - output fetch failed  ⇒ there are no lines at all (a false $0 day).
  //   - sales fetch failed   ⇒ there ARE lines, but their classification and rates
  //                            were computed from an incomplete sales map, so the
  //                            margin is silently wrong. This is the more dangerous
  //                            case precisely because the report still looks normal.
  // Previously only outRes gated persistence, so a failed sales fetch wrote bad
  // money straight into prod_summary, where the Dashboard served it as fact.
  report.unavailable = !outRes.ok;
  report.pricesIncomplete = outRes.ok && !salesOk;
  const trustworthy = outRes.ok && salesOk;

  reportCache.set(day, { report, builtAt: Date.now() });
  if (trustworthy) {
    failedDays.delete(day);
    try { dbStore.saveProdSummary(summarize(report)); } catch (e) { console.error('[Production] summary save failed:', e && e.message); }
  } else {
    noteDayFailed(day);
  }

  const c = report.tollPricing;
  const status = !outRes.ok ? 'UNAVAILABLE (Swarmbox error)'
    : !salesOk ? `${report.rows.length} lines — NOT SAVED (sales fetch incomplete; margin unreliable)`
    : `${report.rows.length} lines`;
  console.log(`[Production] ${day}: ${status}, GP $${Math.round(report.totals.gp).toLocaleString()} (toll: ${c.live} live, ${c.contract} contract, ${c.missing} missing${recostCount ? `; ${recostCount} batch(es) re-costed past blended WIP avg` : ''})`);
  return report;
}

// A cheap fingerprint of all user overrides (manual rates, toll/own class,
// customer transfers, price corrections, cost corrections). Stored alongside each daily summary so
// that changing ANY override marks the affected days stale — the Dashboard and
// Customers tab then recompute them, so a transfer/correction "updates
// everything", not just today's live report.
function overrideSignature() {
  const lists = [manualRates.getList(), classOverrides.getList(), customerOverrides.getList(), priceOverrides.getList(), costOverrides.getList()];
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
    if (r.internal) continue; // input-cost-only intermediates: excluded from stored margin too
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

// Is this day's stored summary missing or out of date?
const isStale = (stored, sig, d) => {
  const s = stored.get(d);
  return !s || s.v !== SUMMARY_VERSION || s.ov !== sig;
};

// Ensure the last `days` production days have a CURRENT-version stored summary
// (computes any missing or out-of-date — building a day saves its summary).
// Days that keep failing are skipped while they're in backoff, so a permanently
// broken day can't keep this running forever.
async function backfillSummaries(days = 30) {
  const dates = (await recentDates()).slice(0, days).map((d) => d.date);
  if (!dates.length) return { requested: 0, filled: 0, skipped: 0 };
  const sig = overrideSignature();
  const stored = new Map(dbStore.loadProdSummaries(dates[dates.length - 1], dates[0]).map((s) => [s.date, s]));
  // Recompute a day if it's missing, built by an older code version, or built
  // before the current set of overrides (a transfer/correction since then).
  const stale = dates.filter((d) => isStale(stored, sig, d));
  const todo = stale.filter(dayRetryable);
  const skipped = stale.length - todo.length;
  for (const d of todo) {
    // background: the backfill is bulk work behind an already-served page.
    try { await getProductionReport({ date: d, background: true }); } catch (e) { /* keep going */ }
  }
  if (todo.length) console.log(`[Production] backfilled ${todo.length} day summaries${skipped ? ` (${skipped} skipped — unavailable/backing off)` : ''}`);
  return { requested: dates.length, filled: todo.length, skipped };
}

// How many of the last `days` production days lack a CURRENT-version stored
// summary AND could actually be rebuilt right now — i.e. how many a backfill would
// really recompute. Cheap: reads stored summaries, no Swarmbox. Lets the
// dashboard/customers routes serve instantly and only kick a background refresh
// when something's actually stale.
//
// Days we've given up on are counted as `unavailable`, NOT `pending`. That
// distinction is what lets the page stop polling: `pending` is what drives the
// "updating…" state, and a day that will never build must not hold it open forever.
async function pendingSummaryDays(days = 30) {
  const dates = (await recentDates()).slice(0, days).map((d) => d.date);
  if (!dates.length) return { total: 0, pending: 0, unavailable: 0 };
  const sig = overrideSignature();
  const stored = new Map(dbStore.loadProdSummaries(dates[dates.length - 1], dates[0]).map((s) => [s.date, s]));
  const stale = dates.filter((d) => isStale(stored, sig, d));
  const pending = stale.filter(dayRetryable);
  // Stale but NOT retryable right now = we have no summary and aren't about to get
  // one (the day is in backoff, or we've given up on it). Say so, rather than
  // leaving a silent hole the user reads as "no production that day".
  const unavailable = stale.filter((d) => !dayRetryable(d));
  return {
    total: dates.length,
    pending: pending.length,
    stored: dates.length - stale.length,
    unavailable: unavailable.length,
    unavailableDates: unavailable,
  };
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

module.exports = { getProductionReport, recentDates, mostRecentDate, clearCache, backfillSummaries, refreshSummariesInBackground, pendingSummaryDays };
