const express = require('express');
const { getValues } = require('../valuation');

const router = express.Router();

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
    const esc = (v) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`);
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
