const express = require('express');
const { getProductionReport, recentDates, clearCache } = require('../production');
const manualRates = require('../manualRates');

const router = express.Router();

// GET /api/production/rates → manual toll rates
router.get('/rates', (_req, res) => {
  res.json({ rates: manualRates.getList() });
});

// POST /api/production/rates { code, rate, note } → set a manual toll rate
router.post('/rates', (req, res) => {
  const code = String((req.body && req.body.code) || '').trim();
  const rate = Number(req.body && req.body.rate);
  if (!code || !(rate > 0)) return res.status(400).json({ error: 'code and a positive rate are required' });
  manualRates.set(code, rate, req.body && req.body.note);
  clearCache(); // recompute reports with the new rate
  res.json({ ok: true, count: manualRates.getList().length });
});

// DELETE /api/production/rates/:code → remove a manual toll rate
router.delete('/rates/:code', (req, res) => {
  const removed = manualRates.remove(req.params.code);
  clearCache();
  res.json({ ok: true, removed });
});

// GET /api/production/dates → recent production days (newest first) for the picker
router.get('/dates', async (_req, res) => {
  try {
    res.json({ dates: await recentDates() });
  } catch (err) {
    console.error('[Production] dates failed:', err && err.message);
    res.status(500).json({ error: 'Failed to list production dates' });
  }
});

// GET /api/production           → most recent production day
// GET /api/production?date=...  → that specific day (YYYY-MM-DD)
// GET /api/production?refresh=1 → force a rebuild for the day
router.get('/', async (req, res) => {
  try {
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : undefined;
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    res.json(await getProductionReport({ date, force }));
  } catch (err) {
    console.error('[Production] report failed:', err && err.message);
    res.status(500).json({ error: 'Failed to build production report' });
  }
});

// GET /api/production/export.csv?date=... → the day's detail lines as CSV
router.get('/export.csv', async (req, res) => {
  try {
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : undefined;
    const report = await getProductionReport({ date });
    const cols = [
      'batch', 'item', 'description', 'room', 'process', 'customer', 'type',
      'cases', 'lbs', 'ratePerLb', 'revenue', 'inputCost', 'grossProfit', 'source',
    ];
    const esc = (v) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`);
    const lines = [cols.join(',')];
    for (const r of report.rows) {
      lines.push([
        r.batch, r.item, r.description, r.room, r.process, r.customer, r.isToll ? 'Toll' : 'Own',
        r.cs, r.lbs, r.rate, r.revenue, r.inputCost, r.gp, r.source,
      ].map(esc).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="production-margin-${report.date}.csv"`);
    res.send(lines.join('\r\n'));
  } catch (err) {
    console.error('[Production] csv failed:', err && err.message);
    res.status(500).send('Export failed');
  }
});

module.exports = router;
