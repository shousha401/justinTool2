const express = require('express');
const { recentDates, pendingSummaryDays, refreshSummariesInBackground } = require('../production');
const { loadProdSummaries } = require('../db');

const router = express.Router();

// GET /api/customers?days=7|14|30 → every customer ranked by gross profit, with
// toll/own split, a trend vs the prior equal-length period, and per-customer
// products + daily GP series for drill-down.
router.get('/', async (req, res) => {
  try {
    const days = [7, 14, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 14;
    const allDates = (await recentDates()).map((d) => d.date); // newest-first
    const curDates = allDates.slice(0, days);
    const prevDates = allDates.slice(days, days * 2);
    if (!curDates.length) return res.json({ days, dayCount: 0, hasPrior: false, customers: [] });

    // Serve stored summaries INSTANTLY; recompute any stale day in the BACKGROUND
    // (both periods' worth) and flag it so the client can re-fetch shortly. The
    // page never blocks on the Swarmbox recompute.
    // `unavailable` days are ones Swarmbox will not serve; they are NOT pending, so
    // they can't hold the page in a permanent "updating…" poll loop.
    const window = Math.min(days * 2, allDates.length);
    const { pending, unavailable } = await pendingSummaryDays(window);
    if (pending) refreshSummariesInBackground(Math.max(30, window));

    const lo = (prevDates[prevDates.length - 1] || curDates[curDates.length - 1]);
    const hi = curDates[0];
    const loaded = loadProdSummaries(lo, hi);
    const curSet = new Set(curDates), prevSet = new Set(prevDates);
    const cur = loaded.filter((s) => curSet.has(s.date));
    const prev = loaded.filter((s) => prevSet.has(s.date));

    // current period: aggregate per customer with items + daily series
    const map = new Map();
    for (const s of cur) for (const c of s.customers) {
      let m = map.get(c.customer);
      if (!m) m = map.set(c.customer, { customer: c.customer, lbs: 0, rev: 0, ic: 0, gp: 0, tollRev: 0, ownRev: 0, items: new Map(), daily: [] }).get(c.customer);
      m.lbs += c.lbs || 0; m.rev += c.rev || 0; m.ic += c.ic || 0; m.gp += c.gp || 0;
      m.tollRev += c.tollRev || 0; m.ownRev += c.ownRev || 0;
      m.daily.push({ date: s.date, gp: c.gp || 0 });
      for (const it of (c.items || [])) {
        const im = m.items.get(it.item) || { item: it.item, description: it.description, lbs: 0, rev: 0, gp: 0 };
        im.lbs += it.lbs || 0; im.rev += it.rev || 0; im.gp += it.gp || 0;
        m.items.set(it.item, im);
      }
    }
    // prior period GP per customer (for the trend arrow)
    const prevGp = new Map();
    for (const s of prev) for (const c of s.customers) prevGp.set(c.customer, (prevGp.get(c.customer) || 0) + (c.gp || 0));

    const customers = [...map.values()].map((m) => {
      const pg = prevGp.has(m.customer) ? prevGp.get(m.customer) : null;
      const deltaPct = (pg != null && pg !== 0) ? ((m.gp - pg) / Math.abs(pg)) * 100 : null;
      return {
        customer: m.customer, lbs: m.lbs, rev: m.rev, ic: m.ic, gp: m.gp,
        tollRev: m.tollRev, ownRev: m.ownRev,
        prevGp: pg, deltaPct,
        items: [...m.items.values()].sort((a, b) => b.gp - a.gp).slice(0, 15),
        daily: m.daily.sort((a, b) => (a.date < b.date ? -1 : 1)),
      };
    }).sort((a, b) => b.gp - a.gp);

    res.json({
      days,
      from: curDates[curDates.length - 1], to: curDates[0],
      dayCount: cur.length,
      hasPrior: prev.length > 0,
      refreshing: pending > 0,   // some days still recomputing in the background
      pending,
      unavailable,               // days Swarmbox won't serve — excluded, not $0
      customers,
    });
  } catch (err) {
    console.error('[Customers] failed:', err && err.message);
    res.status(500).json({ error: 'Failed to build customer scorecard' });
  }
});

module.exports = router;
