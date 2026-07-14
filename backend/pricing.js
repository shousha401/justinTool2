// pricing.js — last selling price per item, split by company tier, from Swarmbox
// `sales_order_lines`.
//
// The business is two-tier:
//   - CMP -> JD : we produce here and sell to JD (the internal / production
//     price). These lines have company = "CMP", buyer "JD Food".
//   - JD -> customer : JD resells to outside customers (the street price).
//     These lines have company = "JD".
// Each order line carries a `company` field, so we track BOTH tiers per item and
// report the newest real (price > 0) sale in each. (A single "most recent sale"
// would mix the two — for many produced items the newest line is a CMP->JD
// transfer, which is a different number than JD's street price.)
//
// Performance (thousands of codes): batched p_items, ?select= projection,
// parallel (bounded by swarmbox.js's semaphore), tiered windows (price a short
// recent window first, widen to the full 360d only for items still missing a
// tier), and split-on-timeout retry. Read-only.

const { postRpc, normalizeItemCode, withRetry, isTimeout, isTransient } = require('./swarmbox');

const MAX_LOOKBACK_DAYS = 360;           // Swarmbox caps item-filtered queries here
const TIER_WINDOWS = [60, MAX_LOOKBACK_DAYS]; // try 60 days first, then widen
const MIN_SPLIT = 8;                      // stop splitting a failing batch below this
const SELECT = 'item,delivery_date,price,price_uom,order_uom,company,customer_name,sales_order';
// Passing the select via the RPC name keeps swarmbox.js untouched: it builds the
// URL as `${BASE}/rpc/${name}`, so this yields `.../rpc/sales_order_lines?select=...`.
const RPC = `sales_order_lines?select=${SELECT}`;

// LOCAL calendar date, not UTC — toISOString() rolls over to tomorrow every
// afternoon (5pm Pacific = next day UTC), which shifts the whole sales window by a
// day. Matches valuation.js's snapshot key, which was already local.
function ymd(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// Which price tier a line belongs to:
//   'cmp' — CMP -> JD (company CMP, internal/production price)
//   'jd'  — JD -> customer (company JD, street price)
//   null  — ignore (blank company, or a JD line billed back to "JD Food")
function tierOf(row) {
  const company = String(row.company || '').trim().toUpperCase();
  if (company === 'CMP') return 'cmp';
  if (company === 'JD') {
    const cust = String(row.customer_name || '').trim().toUpperCase();
    if (cust.startsWith('JD FOOD')) return null; // internal, not a street sale
    return 'jd';
  }
  return null;
}

// Keep the newest real sale per tier for an item.
function record(out, item, tier, row, price) {
  let rec = out.get(item);
  if (!rec) { rec = { cmp: null, jd: null }; out.set(item, rec); }
  const date = String(row.delivery_date || '');
  const cur = rec[tier];
  if (!cur || date > cur.lastSoldDate) {
    rec[tier] = {
      price,
      priceUom: row.price_uom || null,
      orderUom: row.order_uom || null,
      lastSoldDate: date,
      customer: row.customer_name || null,
      salesOrder: row.sales_order != null ? String(row.sales_order) : null,
    };
  }
}

// Stop widening an item only once BOTH tiers are found. Stopping at the first
// tier (the old behavior) silently dropped the slower tier for any item that
// sells fast in one tier but slow in the other — e.g. a produced good billed
// CMP->JD weekly but resold JD->customer every ~90 days would keep its CMP value
// and never query 360d for its street price. The cost of "both": items that
// genuinely sell in only one tier never complete, so they fall through to the
// widest window — correct, just not free.
const hasBothPrices = (rec) => !!(rec && rec.cmp && rec.jd);

// Fetch lines for `codes` in one window. Never throws.
//
// Like catalog.js, this splits ONLY on a timeout — the one failure that can mean
// "this batch has too much history to serve in time", where halving genuinely
// helps. Any other failure is retried in place with backoff; splitting a batch
// because Swarmbox returned a 500 just doubles the load on an API that is already
// failing.
//
// Codes we ultimately cannot read are reported in `lost`, NOT silently dropped.
// A dropped code looks exactly like "this item has no recent sale" downstream —
// which is a wrong answer presented as a fact.
async function fetchLines(codes, startYmd, endYmd, lost) {
  const res = await withRetry(
    () => postRpc(RPC, { p_items: codes, p_start_delivery_date: startYmd, p_end_delivery_date: endYmd }),
    {
      attempts: 3,
      label: `pricing ${codes.length} items`,
      // Don't retry a timeout — halving the batch is the fix for "too much history
      // to serve in 30s", and re-requesting the same heavy batch twice more just
      // burns another 60s before we halve it anyway.
      retryOn: (r) => isTransient(r) && !isTimeout(r),
    },
  );
  if (res.ok) return res.data;

  if (isTimeout(res) && codes.length > MIN_SPLIT) {
    const mid = Math.ceil(codes.length / 2);
    const [a, b] = await Promise.all([
      fetchLines(codes.slice(0, mid), startYmd, endYmd, lost),
      fetchLines(codes.slice(mid), startYmd, endYmd, lost),
    ]);
    return a.concat(b);
  }

  console.error(`[Pricing] lost ${codes.length}-item slice (${res.status || 'err'}): ${(res.text || '').slice(0, 100)}`);
  for (const c of codes) lost.add(c);
  return [];
}

// Price `codes` against one time window, merging both tiers into `out`.
async function priceWindow(codes, days, out, lost) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const startYmd = ymd(start);
  const endYmd = ymd(end);

  const chunkSize = days <= 60 ? 100 : 40;
  const chunks = [];
  for (let i = 0; i < codes.length; i += chunkSize) chunks.push(codes.slice(i, i + chunkSize));

  const rowsPerChunk = await Promise.all(chunks.map((chunk) => fetchLines(chunk, startYmd, endYmd, lost)));

  for (const rows of rowsPerChunk) {
    for (const r of rows) {
      const item = String(r.item || '').trim();
      if (!item) continue;
      const price = r.price != null ? Number(r.price) : null;
      if (!(price > 0)) continue;        // ignore $0 / null-price lines
      const tier = tierOf(r);
      if (!tier) continue;               // ignore blank-company / internal-JD lines
      record(out, item, tier, r, price);
    }
  }
}

// codes: array of item codes. Returns { prices, lost }:
//   prices — Map<item, { cmp: {...}|null, jd: {...}|null }>, the newest real sale
//            in each tier within the lookback window.
//   lost   — Set<item> whose price lookup FAILED. These are NOT "no recent sale";
//            we simply don't know. Callers must not record a blank for them.
// Never throws.
async function lastPrices(codes, lookbackDays) {
  const maxDays = Math.min(MAX_LOOKBACK_DAYS, Math.max(1, Number(lookbackDays) || MAX_LOOKBACK_DAYS));
  const tiers = [...new Set(TIER_WINDOWS.filter((w) => w < maxDays).concat(maxDays))].sort((a, b) => a - b);

  const all = [...new Set(codes.map(normalizeItemCode).filter((c) => c && c !== '000000'))];
  const out = new Map();
  const lost = new Set();
  let remaining = all;

  for (const days of tiers) {
    if (remaining.length === 0) break;
    const windowLost = new Set();
    await priceWindow(remaining, days, out, windowLost);
    // A code lost in this window may still be read in the next (wider) one, so
    // only hold it as lost while it stays unread. Anything still lost after the
    // final window is genuinely unknown.
    for (const c of windowLost) lost.add(c);
    for (const c of out.keys()) lost.delete(c);

    // Widen for any item still missing EITHER tier. An item that only ever sells
    // in one tier never "completes" and falls through to the widest window —
    // which is correct; we just can't stop early for it.
    remaining = remaining.filter((c) => !hasBothPrices(out.get(c)));
    let cmp = 0, jd = 0;
    for (const rec of out.values()) { if (rec.cmp) cmp++; if (rec.jd) jd++; }
    console.log(`[Pricing] ${days}d window: JD-priced ${jd}, CMP-priced ${cmp} of ${all.length} (${remaining.length} with no recent sale)`);
  }

  if (lost.size) console.error(`[Pricing] ${lost.size} item(s) could not be priced (Swarmbox failed) — they will NOT be recorded as "no sale"`);
  return { prices: out, lost };
}

module.exports = { lastPrices };
