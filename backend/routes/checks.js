const express = require('express');
const { getDayChecks, getRangeChecks } = require('../checks');
const { recentDates } = require('../production');

const router = express.Router();

// GET /api/checks/dates → recent production days (newest first) for the picker
router.get('/dates', async (_req, res) => {
  try {
    res.json({ dates: await recentDates() });
  } catch (err) {
    console.error('[Checks] dates failed:', err && err.message);
    res.status(500).json({ error: 'Failed to list production dates' });
  }
});

// GET /api/checks/range?days=30 → cheap whole-window sweep (batch_summary rules)
router.get('/range', async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    res.json(await getRangeChecks({ days, force }));
  } catch (err) {
    console.error('[Checks] range failed:', err && err.message);
    res.status(500).json({ error: 'Failed to build range scan' });
  }
});

// GET /api/checks            → most recent production day, full rule set
// GET /api/checks?date=...    → that specific day (YYYY-MM-DD)
// GET /api/checks?refresh=1   → force a rebuild
router.get('/', async (req, res) => {
  try {
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : undefined;
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    res.json(await getDayChecks({ date, force }));
  } catch (err) {
    console.error('[Checks] day failed:', err && err.message);
    res.status(500).json({ error: 'Failed to build sanity check' });
  }
});

module.exports = router;
