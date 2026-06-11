const express = require('express');
const { recentDates, backfillSummaries } = require('../production');
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

    await backfillSummaries(days); // make sure the whole range is computed
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
    const items = merge(summaries, 'items').sort((a, b) => b.gp - a.gp);

    res.json({
      days,
      from, to,
      dayCount: daily.length,
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
