// catalog.js — discover every in-stock product code via a Swarmbox wildcard sweep.
//
// Swarmbox's `inventory_detail` RPC accepts a SQL LIKE wildcard on p_item
// (e.g. "05%"), and every returned lot row carries its own `item` + `description`.
// So sweeping by code prefix and de-duping the `item` column gives us the live
// universe of product codes that currently have stock — no hardcoded item list.
//
// We sweep all two-digit prefixes ("00".."99") in parallel, bounded by
// swarmbox.js's process-wide concurrency semaphore (the same pattern clayTool's
// nightly snapshot uses to fire hundreds of inventory_detail calls). Each call is
// projected to just `item,description` to stay light. Two digits keeps even the
// densest slice well under a safe size; the rare prefix that still exceeds
// CATALOG_ROW_BUDGET (or fails) is subdivided into its ten finer children and
// swept in the next round. Every lot row is fetched at most once. Read-only.

const { getRows } = require('./swarmbox');

const ROW_BUDGET = Number(process.env.CATALOG_ROW_BUDGET) || 40000;
const MAX_DEPTH = 6; // product codes are 6 digits — never subdivide past that

function twoDigitSeeds() {
  const seeds = [];
  for (let a = 0; a <= 9; a++) for (let b = 0; b <= 9; b++) seeds.push(`${a}${b}`);
  return seeds; // "00".."99"
}

async function sweepPrefix(prefix) {
  const q = `rpc/inventory_detail?p_item=${encodeURIComponent(prefix + '%')}&select=item,description`;
  const res = await getRows(q);
  return { prefix, res };
}

// Returns [{ item, description }] for every distinct in-stock code. Never throws.
async function sweepCatalog() {
  const found = new Map(); // item code -> description (first seen wins)
  let queue = twoDigitSeeds();
  let calls = 0;
  let failedLeaves = 0;

  while (queue.length) {
    // One round: all queued prefixes fire together; the semaphore bounds how
    // many actually hit Swarmbox at once.
    const results = await Promise.all(queue.map(sweepPrefix));
    calls += queue.length;
    const next = [];

    for (const { prefix, res } of results) {
      const tooBig = res.ok && res.data.length >= ROW_BUDGET && prefix.length < MAX_DEPTH;
      if (!res.ok || tooBig) {
        // Failed, timed out, or too dense — split into finer prefixes so no
        // single slice is ever oversized. Children cover the same codes, so
        // nothing is lost by skipping this slice.
        if (prefix.length < MAX_DEPTH) {
          for (let d = 0; d <= 9; d++) next.push(prefix + d);
          if (!res.ok) console.warn(`[Catalog] ${prefix}% failed (${res.status || 'err'}) — subdividing`);
        } else {
          failedLeaves++;
          console.error(`[Catalog] ${prefix}% failed and cannot subdivide further`);
        }
        continue;
      }
      for (const r of res.data) {
        const item = String(r.item || '').trim();
        if (item && !found.has(item)) found.set(item, r.description || '');
      }
    }
    queue = next;
  }

  const list = [...found.entries()]
    .map(([item, description]) => ({ item, description }))
    .sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));

  console.log(
    `[Catalog] swept ${calls} prefixes → ${list.length} distinct in-stock items`
    + (failedLeaves ? ` (${failedLeaves} prefix slice(s) unavailable)` : '')
  );
  return list;
}

module.exports = { sweepCatalog };
