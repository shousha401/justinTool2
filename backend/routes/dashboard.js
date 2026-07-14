const express = require('express');
const { recentDates, pendingSummaryDays, refreshSummariesInBackground } = require('../production');
const { loadProdSummaries } = require('../db');

const router = express.Router();

// GET /api/dashboard?days=7|14|30 → period margin rollup for the Owner's Dashboard
router.get('/', async (req, res) => {
  try {
    const days = [7, 14, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 14;
    const dateList = (await recentDates()).slice(0, days).map((d) => d.date); // newest-first
    if (!dateList.length) {
      return res.json({ days, dayCount: 0, daily: [], totals: {}, topCustomers: [], bottomCustomers: [], topItems: [], bottomItems: [] });
    }

    // Serve whatever's already stored INSTANTLY; if any day is stale (missing /
    // old version / pre-override), recompute in the BACKGROUND and tell the client
    // so it can re-fetch shortly. No page load ever blocks on the Swarmbox recompute.
    // `unavailable` days are ones Swarmbox will not serve; they are NOT pending, so
    // they can't hold the page in a permanent "updating…" poll loop.
    const { pending, unavailable, unavailableDates } = await pendingSummaryDays(days);
    if (pending) refreshSummariesInBackground(Math.max(30, days));

    const from = dateList[dateList.length - 1];
    const to = dateList[0];
    const inRange = new Set(dateList);
    const summaries = loadProdSummaries(from, to).filter((s) => inRange.has(s.date)); // asc by date

    const daily = summaries.map((s) => ({ date: s.date, gp: s.gp, rev: s.rev, tollRev: s.tollRev, ownRev: s.ownRev, ic: s.ic, lbs: s.lbs, lines: s.lines }));
    const totals = daily.reduce((a, s) => ({
      gp: a.gp + s.gp, rev: a.rev + s.rev, tollRev: a.tollRev + s.tollRev,
      ownRev: a.ownRev + s.ownRev, ic: a.ic + s.ic, lbs: a.lbs + s.lbs,
    }), { gp: 0, rev: 0, tollRev: 0, ownRev: 0, ic: 0, lbs: 0 });

    // Aggregate customers and items across the period
    const merge = (rows, key) => {
      const m = new Map();
      for (const s of summaries) for (const x of s[key]) {
        const id = x[key === 'customers' ? 'customer' : 'item'];
        const cur = m.get(id) || (key === 'customers'
          ? { customer: x.customer, lbs: 0, rev: 0, ic: 0, gp: 0 }
          : { item: x.item, description: x.description, lbs: 0, rev: 0, ic: 0, gp: 0 });
        cur.lbs += x.lbs || 0; cur.rev += x.rev || 0; cur.ic += x.ic || 0; cur.gp += x.gp || 0;
        m.set(id, cur);
      }
      return [...m.values()];
    };
    const customers = merge(summaries, 'customers').sort((a, b) => b.gp - a.gp);

    // Products: in v2 each customer carries its own items; flatten across customers
    // (fall back to a legacy v1 top-level items array if present).
    const itemMap = new Map();
    for (const s of summaries) {
      const rows = (s.items && s.items.length) ? s.items : [].concat(...(s.customers || []).map((c) => c.items || []));
      for (const x of rows) {
        const m = itemMap.get(x.item) || { item: x.item, description: x.description, lbs: 0, rev: 0, ic: 0, gp: 0 };
        m.lbs += x.lbs || 0; m.rev += x.rev || 0; m.ic += x.ic || 0; m.gp += x.gp || 0;
        itemMap.set(x.item, m);
      }
    }
    const items = [...itemMap.values()].sort((a, b) => b.gp - a.gp);

    res.json({
      days,
      from, to,
      dayCount: daily.length,
      refreshing: pending > 0,   // some days still recomputing in the background
      pending,
      unavailable,               // days Swarmbox won't serve — excluded, not $0
      unavailableDates,
      daily,
      totals,
      topCustomers: customers.slice(0, 8),
      bottomCustomers: customers.filter((c) => c.gp < 0).sort((a, b) => a.gp - b.gp).slice(0, 8),
      topItems: items.slice(0, 10),
      bottomItems: items.filter((i) => i.gp < 0).sort((a, b) => a.gp - b.gp).slice(0, 10),
    });
  } catch (err) {
    console.error('[Dashboard] failed:', err && err.message);
    res.status(500).json({ error: 'Failed to build dashboard' });
  }
});

module.exports = router;
