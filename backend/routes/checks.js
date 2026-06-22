const express = require('express');
const { getDayChecks, getRangeChecks, clearCache, QUESTIONS } = require('../checks');
const { recentDates } = require('../production');
const checkFeedback = require('../checkFeedback');

const router = express.Router();

// ── Diagnostic feedback (the human "why" on each flag) ───────────────────────
// GET /api/checks/feedback → every saved answer (newest first), for review/export
router.get('/feedback', (_req, res) => {
  res.json({ feedback: checkFeedback.getList() });
});

// GET /api/checks/feedback.csv → answers as a spreadsheet for chasing root cause
router.get('/feedback.csv', (_req, res) => {
  const cols = ['date', 'batch', 'rule', 'answer', 'note', 'by', 'updatedAt'];
  const esc = (v) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`);
  const lines = [cols.join(',')];
  for (const r of checkFeedback.getList()) lines.push(cols.map((c) => esc(r[c])).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="sanity-check-feedback.csv"');
  res.send(lines.join('\r\n'));
});

// POST /api/checks/feedback { batch, rule, date?, answer?, note?, by? }
// Saves (or, when answer+note are blank, clears) the human diagnosis for a flag.
router.post('/feedback', (req, res) => {
  const b = req.body || {};
  const batch = String(b.batch || '').trim();
  const rule = String(b.rule || '').trim();
  if (!batch || !rule) return res.status(400).json({ error: 'batch and rule are required' });
  if (!QUESTIONS[rule]) return res.status(400).json({ error: 'unknown rule' });
  checkFeedback.set({ batch, rule, date: b.date, answer: b.answer, note: b.note, by: b.by });
  clearCache(); // so the day view shows the saved answer immediately
  res.json({ ok: true, feedback: checkFeedback.get(batch, rule) });
});

// DELETE /api/checks/feedback/:batch/:rule → clear one answer
router.delete('/feedback/:batch/:rule', (req, res) => {
  const removed = checkFeedback.remove(req.params.batch, req.params.rule);
  clearCache();
  res.json({ ok: true, removed });
});

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
