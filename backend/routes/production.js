const express = require('express');
const { getProductionReport, recentDates, clearCache, refreshSummariesInBackground } = require('../production');
const manualRates = require('../manualRates');
const classOverrides = require('../classOverrides');
const customerOverrides = require('../customerOverrides');
const priceOverrides = require('../priceOverrides');
const itemSpecs = require('../itemSpecs');
const { KNOWN_CUSTOMERS } = require('../tollRates');

const router = express.Router();

// After any override change: drop cached reports (next read recomputes) and kick
// a background rebuild of the stored daily summaries, so a change shows up on the
// Dashboard and Customers tab too — not just today's live report.
function afterOverrideChange() {
  clearCache();
  refreshSummariesInBackground();
}

// ── Toll/Own class overrides ─────────────────────────────────────────────────
// GET /api/production/overrides → manual Toll/Own classifications
router.get('/overrides', (_req, res) => {
  res.json({ overrides: classOverrides.getList() });
});

// POST /api/production/overrides { code, mode } → force an item Toll or Own
router.post('/overrides', (req, res) => {
  const code = String((req.body && req.body.code) || '').trim();
  const mode = req.body && req.body.mode;
  if (!code || (mode !== 'toll' && mode !== 'own')) return res.status(400).json({ error: 'code and mode (toll|own) required' });
  classOverrides.set(code, mode);
  afterOverrideChange();
  res.json({ ok: true });
});

// DELETE /api/production/overrides/:code → revert an item to Auto
router.delete('/overrides/:code', (req, res) => {
  const removed = classOverrides.remove(req.params.code);
  afterOverrideChange();
  res.json({ ok: true, removed });
});

// ── Manual (fallback) toll rates ─────────────────────────────────────────────
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
  afterOverrideChange();
  res.json({ ok: true, count: manualRates.getList().length });
});

// DELETE /api/production/rates/:code → remove a manual toll rate
router.delete('/rates/:code', (req, res) => {
  const removed = manualRates.remove(req.params.code);
  afterOverrideChange();
  res.json({ ok: true, removed });
});

// ── Customer transfers (per item) ────────────────────────────────────────────
// GET /api/production/customer-overrides → manual item→customer transfers
router.get('/customer-overrides', (_req, res) => {
  res.json({ overrides: customerOverrides.getList() });
});

// POST /api/production/customer-overrides { code, customer } → reassign an item
router.post('/customer-overrides', (req, res) => {
  const code = String((req.body && req.body.code) || '').trim();
  const customer = String((req.body && req.body.customer) || '').trim();
  if (!code || !customer) return res.status(400).json({ error: 'code and customer required' });
  customerOverrides.set(code, customer);
  afterOverrideChange();
  res.json({ ok: true });
});

// DELETE /api/production/customer-overrides/:code → revert to auto-detected customer
router.delete('/customer-overrides/:code', (req, res) => {
  const removed = customerOverrides.remove(req.params.code);
  afterOverrideChange();
  res.json({ ok: true, removed });
});

// GET /api/production/known-customers → canonical customer list for the dropdown
// (the built-in names plus every customer the spec sheet introduced), deduped.
router.get('/known-customers', (_req, res) => {
  const customers = [...new Set([...KNOWN_CUSTOMERS, ...itemSpecs.getCustomers()])]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  res.json({ customers });
});

// ── Price overrides (forced price + wrong-source flag) ───────────────────────
// GET /api/production/price-overrides → all forced prices / flagged lines
router.get('/price-overrides', (_req, res) => {
  res.json({ overrides: priceOverrides.getList() });
});

// POST /api/production/price-overrides { code, rate?, flagged?, wrongBasis?,
// wrongSource?, note? } → set a forced price and/or flag a line as mis-pulling.
// Only the fields present are changed (so you can set a price now, flag later).
router.post('/price-overrides', (req, res) => {
  const body = req.body || {};
  const code = String(body.code || '').trim();
  if (!code) return res.status(400).json({ error: 'code required' });
  const patch = {};
  if (body.rate !== undefined) patch.rate = (body.rate === '' || body.rate === null) ? null : Number(body.rate);
  if (patch.rate !== undefined && patch.rate !== null && !(patch.rate > 0)) {
    return res.status(400).json({ error: 'rate must be a positive number (or blank to clear)' });
  }
  if (body.flagged !== undefined) patch.flagged = !!body.flagged;
  if (body.wrongBasis !== undefined) patch.wrongBasis = body.wrongBasis;
  if (body.wrongSource !== undefined) patch.wrongSource = body.wrongSource;
  if (body.note !== undefined) patch.note = body.note;
  priceOverrides.set(code, patch);
  afterOverrideChange();
  res.json({ ok: true, override: priceOverrides.get(code) });
});

// DELETE /api/production/price-overrides/:code → clear a forced price + flag
router.delete('/price-overrides/:code', (req, res) => {
  const removed = priceOverrides.remove(req.params.code);
  afterOverrideChange();
  res.json({ ok: true, removed });
});

// ── Report ───────────────────────────────────────────────────────────────────
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
    const esc = (v) => {
      let s = v == null ? '' : String(v);
      // Neutralize spreadsheet formula injection without mangling plain numbers
      // (negative money values legitimately begin with '-').
      if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
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
