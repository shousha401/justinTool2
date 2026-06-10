const express = require('express');
const disc = require('../discontinued');
const { getCachedRows, dropFromCache } = require('../valuation');

const router = express.Router();

// GET /api/discontinued → the current discontinued list
router.get('/', (_req, res) => {
  res.json({ rows: disc.getList() });
});

// POST /api/discontinued { code, description } → discontinue one item now
router.post('/', (req, res) => {
  const code = String((req.body && req.body.code) || '').trim();
  if (!code) return res.status(400).json({ error: 'code required' });
  const added = disc.add(code, (req.body && req.body.description) || '');
  if (added) dropFromCache(new Set([code])); // instant — no rebuild needed
  res.json({ ok: true, added, count: disc.getList().length });
});

// POST /api/discontinued/bulk-unsold → discontinue every item with no sale in
// either tier (the dead weight). Reads the built value table.
router.post('/bulk-unsold', (_req, res) => {
  const rows = getCachedRows();
  if (!rows) return res.status(409).json({ error: 'Value table not built yet — open the Product Value tab first.' });
  const unsold = rows.filter((r) => !r.hasCmp && !r.hasJd).map((r) => ({ code: r.productCode, description: r.description }));
  const added = disc.addMany(unsold);
  const removed = dropFromCache(new Set(unsold.map((u) => u.code)));
  res.json({ ok: true, added, removed, count: disc.getList().length });
});

// DELETE /api/discontinued/:code → restore an item (reappears on next rebuild)
router.delete('/:code', (req, res) => {
  const removed = disc.remove(req.params.code);
  res.json({ ok: true, removed, count: disc.getList().length });
});

module.exports = router;
