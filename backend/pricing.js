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

const { postRpc, normalizeItemCode } = require('./swarmbox');

const MAX_LOOKBACK_DAYS = 360;           // Swarmbox caps item-filtered queries here
const TIER_WINDOWS = [60, MAX_LOOKBACK_DAYS]; // try 60 days first, then widen
const MIN_SPLIT = 8;                      // stop splitting a failing batch below this
const SELECT = 'item,delivery_date,price,price_uom,order_uom,company,customer_name,sales_order';
// Passing the select via the RPC name keeps swarmbox.js untouched: it builds the
// URL as `${BASE}/rpc/${name}`, so this yields `.../rpc/sales_order_lines?select=...`.
const RPC = `sales_order_lines?select=${SELECT}`;

function ymd(d) {
  return d.toISOString().slice(0, 10);
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

// Stop widening an item once it has ANY recent sale. The widest window then only
// runs for items with no recent sale at all, so heavy active sellers (already
// priced) are never re-fetched over the full 360 days. The rare cost: an item
// whose two tiers straddle the first-window boundary can miss its older tier —
// but active items sell in both tiers well within 60 days.
const hasAnyPrice = (rec) => !!(rec && (rec.cmp || rec.jd));

// Fetch lines for `codes` in one window; split-and-retry on failure so a few
// huge-history items can't time out a batch or silently drop data. Never throws.
async function fetchLines(codes, startYmd, endYmd) {
  const res = await postRpc(RPC, {
    p_items: codes,
    p_start_delivery_date: startYmd,
    p_end_delivery_date: endYmd,
  });
  if (res.ok) return res.data;
  if (codes.length <= MIN_SPLIT) {
    console.error(`[Pricing] giving up on ${codes.length}-item slice (${res.status}): ${(res.text || '').slice(0, 100)}`);
    return [];
  }
  const mid = Math.ceil(codes.length / 2);
  const [a, b] = await Promise.all([
    fetchLines(codes.slice(0, mid), startYmd, endYmd),
    fetchLines(codes.slice(mid), startYmd, endYmd),
  ]);
  return a.concat(b);
}

// Price `codes` against one time window, merging both tiers into `out`.
async function priceWindow(codes, days, out) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const startYmd = ymd(start);
  const endYmd = ymd(end);

  const chunkSize = days <= 60 ? 100 : 40;
  const chunks = [];
  for (let i = 0; i < codes.length; i += chunkSize) chunks.push(codes.slice(i, i + chunkSize));

  const rowsPerChunk = await Promise.all(chunks.map((chunk) => fetchLines(chunk, startYmd, endYmd)));

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

// codes: array of item codes. Returns Map<item, { cmp: {...}|null, jd: {...}|null }>
// — the newest real sale in each tier within the lookback window. Never throws.
async function lastPrices(codes, lookbackDays) {
  const maxDays = Math.min(MAX_LOOKBACK_DAYS, Math.max(1, Number(lookbackDays) || MAX_LOOKBACK_DAYS));
  const tiers = [...new Set(TIER_WINDOWS.filter((w) => w < maxDays).concat(maxDays))].sort((a, b) => a - b);

  const all = [...new Set(codes.map(normalizeItemCode).filter((c) => c && c !== '000000'))];
  const out = new Map();
  let remaining = all;

  for (const days of tiers) {
    if (remaining.length === 0) break;
    await priceWindow(remaining, days, out);
    // Widen for any item still missing a tier. An item that only ever sells in
    // one tier never "completes" and falls through to the widest window — which
    // is correct; we just can't stop early for it.
    remaining = remaining.filter((c) => !hasAnyPrice(out.get(c)));
    let cmp = 0, jd = 0;
    for (const rec of out.values()) { if (rec.cmp) cmp++; if (rec.jd) jd++; }
    console.log(`[Pricing] ${days}d window: JD-priced ${jd}, CMP-priced ${cmp} of ${all.length} (${remaining.length} with no recent sale)`);
  }

  return out;
}

module.exports = { lastPrices };
