const express = require('express');
const { getValues, priceHistory, reapplyValueOverride } = require('../valuation');
const valueOverrides = require('../valueOverrides');

const router = express.Router();

// GET /api/values/history?code=XXXXXX → day-by-day price series for one item
router.get('/history', (req, res) => {
  const code = String(req.query.code || '').trim();
  if (!code) return res.status(400).json({ error: 'code required' });
  try {
    res.json({ code, history: priceHistory(code) });
  } catch (err) {
    console.error('[Values] history failed:', err && err.message);
    res.status(500).json({ error: 'Failed to load history' });
  }
});

// ── Manual value-overrides — per-item price corrections for the value table ────
// GET    /api/values/overrides        → list every manual override
// POST   /api/values/overrides        → set/merge one ({ code, cmpManual?, cmpUom?,
//                                        cmpUse?, jdManual?, jdUom?, jdUse?, note? })
// DELETE /api/values/overrides/:code  → clear an item's manual override
router.get('/overrides', (_req, res) => {
  res.json({ overrides: valueOverrides.getList() });
});

router.post('/overrides', (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim();
  if (!code) return res.status(400).json({ error: 'code required' });
  try {
    valueOverrides.set(code, b);
    reapplyValueOverride(code); // take effect on the live table immediately
    res.json({ ok: true, override: valueOverrides.get(code) });
  } catch (err) {
    console.error('[Values] override save failed:', err && err.message);
    res.status(500).json({ error: 'Failed to save override' });
  }
});

router.delete('/overrides/:code', (req, res) => {
  const code = String(req.params.code || '').trim();
  try {
    const removed = valueOverrides.remove(code);
    reapplyValueOverride(code);
    res.json({ ok: true, removed });
  } catch (err) {
    console.error('[Values] override delete failed:', err && err.message);
    res.status(500).json({ error: 'Failed to clear override' });
  }
});

// GET /api/values            → cached value table (rebuilds if stale)
// GET /api/values?refresh=1  → force a fresh sweep first
router.get('/', async (req, res) => {
  try {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const c = await getValues({ force });
    res.json({
      builtAt: c.builtAt,
      buildMs: c.buildMs,
      lookbackDays: c.lookbackDays,
      itemCount: c.itemCount,
      pricedJd: c.pricedJd,
      pricedCmp: c.pricedCmp,
      discontinued: c.discontinued,
      rows: c.rows,
    });
  } catch (err) {
    console.error('[Values] failed:', err && err.message);
    res.status(500).json({ error: 'Failed to build value table' });
  }
});

// POST /api/values/refresh   → force a rebuild, return summary (no rows)
router.post('/refresh', async (_req, res) => {
  try {
    const c = await getValues({ force: true });
    res.json({
      builtAt: c.builtAt,
      buildMs: c.buildMs,
      itemCount: c.itemCount,
      pricedJd: c.pricedJd,
      pricedCmp: c.pricedCmp,
    });
  } catch (err) {
    console.error('[Values] refresh failed:', err && err.message);
    res.status(500).json({ error: 'Refresh failed' });
  }
});

// GET /api/values/export.csv → the current value table as a CSV download
router.get('/export.csv', async (_req, res) => {
  try {
    const c = await getValues({});
    const cols = [
      'productCode', 'description',
      'cmpValue', 'cmpValueUom', 'cmpLastSoldDate',
      'jdValue', 'jdValueUom', 'jdLastSoldDate', 'jdCustomer',
    ];
    const esc = (v) => {
      let s = v == null ? '' : String(v);
      // Neutralize spreadsheet formula injection without mangling plain numbers
      // (negative money values legitimately begin with '-').
      if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = [cols.join(',')];
    for (const r of c.rows) lines.push(cols.map((k) => esc(r[k])).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="product-values.csv"');
    res.send(lines.join('\r\n'));
  } catch (err) {
    console.error('[Values] csv failed:', err && err.message);
    res.status(500).send('Export failed');
  }
});

module.exports = router;
