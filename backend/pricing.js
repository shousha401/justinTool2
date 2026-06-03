// pricing.js — last selling price per item from Swarmbox `sales_order_lines`.
//
// Same RPC clayTool's /api/sales/orders uses, but tuned for thousands of codes:
//   - batched: `sales_order_lines` takes a `p_items` array and tags every row
//     with its `item`, so we price ~100 codes per call instead of one-at-a-time.
//   - projected: we ask PostgREST for only the 7 fields we need (`?select=...`),
//     dropping ~75% of the payload vs the full 28-field row.
//   - parallel: batches are fired together and bounded by swarmbox.js's
//     process-wide concurrency semaphore (SWARMBOX_CONCURRENCY).
//   - tiered windows: a full 360-day scan of every item returns an enormous
//     number of order lines (and can time out). Instead we price against a short
//     recent window first, then widen to the full window ONLY for items still
//     unpriced. Active sellers — the row-heavy ones — resolve in the cheap pass;
//     the wide pass only ever runs for quiet/never-sold codes, which return few
//     or no rows. Because the short window is the most recent slice of time, the
//     newest real sale always surfaces there if it exists, so this is identical
//     in result to one big 360-day scan — just far cheaper.
//
// For each item we keep the row with the newest `delivery_date` AND a real price
// (> 0). Zero / null price lines (internal production, samples, transfers) are
// ignored so they can't become a product's value. Read-only; failed batches are
// logged and skipped.

const { postRpc, normalizeItemCode } = require('./swarmbox');

const MAX_LOOKBACK_DAYS = 360;           // Swarmbox caps item-filtered queries here
const TIER_WINDOWS = [60, MAX_LOOKBACK_DAYS]; // try 60 days first, then widen
const MIN_SPLIT = 8;                      // stop splitting a failing batch below this
const SELECT = 'item,delivery_date,price,price_uom,order_uom,customer_name,sales_order';
// Passing the select via the RPC name keeps swarmbox.js untouched: it builds the
// URL as `${BASE}/rpc/${name}`, so this yields `.../rpc/sales_order_lines?select=...`.
const RPC = `sales_order_lines?select=${SELECT}`;

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

// Fetch sales lines for `codes` in one window. Never throws. On failure
// (timeout / error) with more than MIN_SPLIT codes, halves the set and retries
// each half — so a handful of items with huge order history can't time out the
// whole batch or silently drop data. Returns the combined row array.
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

// Price `codes` against a single time window, merging results into `out`
// (newest real-price sale wins). Returns how many items were newly priced.
async function priceWindow(codes, days, out) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const startYmd = ymd(start);
  const endYmd = ymd(end);

  // Wider windows mean more lines per item, so start with smaller chunks there;
  // fetchLines() still splits any chunk that turns out too heavy.
  const chunkSize = days <= 60 ? 100 : 40;
  const chunks = [];
  for (let i = 0; i < codes.length; i += chunkSize) chunks.push(codes.slice(i, i + chunkSize));

  const rowsPerChunk = await Promise.all(chunks.map((chunk) => fetchLines(chunk, startYmd, endYmd)));

  let newlyPriced = 0;
  for (const rows of rowsPerChunk) {
    for (const r of rows) {
      const item = String(r.item || '').trim();
      if (!item) continue;
      const price = r.price != null ? Number(r.price) : null;
      if (!(price > 0)) continue; // ignore $0 / null-price lines
      const date = String(r.delivery_date || '');
      const prev = out.get(item);
      if (!prev) newlyPriced++;
      // YYYY-MM-DD compares correctly as a string. Newest real sale wins.
      if (!prev || date > prev.lastSoldDate) {
        out.set(item, {
          price,
          priceUom: r.price_uom || null,
          orderUom: r.order_uom || null,
          lastSoldDate: date,
          customer: r.customer_name || null,
          salesOrder: r.sales_order != null ? String(r.sales_order) : null,
        });
      }
    }
  }
  return newlyPriced;
}

// codes: array of item codes. Returns Map<item, {
//   price, priceUom, orderUom, lastSoldDate, customer, salesOrder
// }> for items with at least one real (price > 0) sale in the window. Never throws.
async function lastPrices(codes, lookbackDays) {
  const maxDays = Math.min(MAX_LOOKBACK_DAYS, Math.max(1, Number(lookbackDays) || MAX_LOOKBACK_DAYS));
  // Tiers up to maxDays, ascending & unique (e.g. 360 -> [60, 360]; 90 -> [60, 90]; 30 -> [30]).
  const tiers = [...new Set(TIER_WINDOWS.filter((w) => w < maxDays).concat(maxDays))].sort((a, b) => a - b);

  const all = [...new Set(codes.map(normalizeItemCode).filter((c) => c && c !== '000000'))];
  const out = new Map();
  let remaining = all;

  for (const days of tiers) {
    if (remaining.length === 0) break;
    const newly = await priceWindow(remaining, days, out);
    remaining = remaining.filter((c) => !out.has(c));
    console.log(`[Pricing] ${days}d window: +${newly} priced (${out.size}/${all.length} total, ${remaining.length} still unpriced)`);
  }

  return out;
}

module.exports = { lastPrices };
