const express = require('express');
const questions = require('../questions');

const router = express.Router();

// GET /api/questions?status=open|answered&item=&date= → the queue (newest first)
router.get('/', (req, res) => {
  const { status, item, date } = req.query;
  res.json({
    questions: questions.getList({ status, item, date }),
    open: questions.openCount(),
  });
});

// GET /api/questions/for-date?date=YYYY-MM-DD → { "batch|item": [q,…] }
// Lets the Production page badge the exact lines someone has questioned.
router.get('/for-date', (req, res) => {
  res.json({ byLine: questions.forDate(req.query.date) });
});

// GET /api/questions/count → open count, for the nav badge
router.get('/count', (_req, res) => res.json({ open: questions.openCount() }));

// POST /api/questions  { date, item, batch, description, field, question, askedBy, snapshot }
// Ask about a number. `snapshot` is what the asker was looking at — keep it, or the
// question becomes unanswerable once the report is rebuilt with different overrides.
router.post('/', (req, res) => {
  const b = req.body || {};
  if (!String(b.question || '').trim()) return res.status(400).json({ error: 'question required' });
  const q = questions.ask(b);
  if (!q) return res.status(400).json({ error: 'could not save question' });
  console.log(`[Questions] new: ${q.item || '?'} ${q.field} — "${q.question.slice(0, 60)}"`);
  res.json({ question: q, open: questions.openCount() });
});

// POST /api/questions/:id/answer  { answer, answeredBy, resolved }
router.post('/:id/answer', (req, res) => {
  const b = req.body || {};
  const q = questions.answer(String(req.params.id), b);
  if (!q) return res.status(404).json({ error: 'question not found' });
  res.json({ question: q, open: questions.openCount() });
});

// DELETE /api/questions/:id
router.delete('/:id', (req, res) => {
  if (!questions.remove(String(req.params.id))) return res.status(404).json({ error: 'question not found' });
  res.json({ ok: true, open: questions.openCount() });
});

// GET /api/questions/export.csv → the whole queue as a spreadsheet
router.get('/export.csv', (_req, res) => {
  const cols = ['id', 'date', 'item', 'batch', 'description', 'field', 'question', 'askedBy', 'askedAt', 'answer', 'answeredBy', 'answeredAt', 'resolved'];
  const esc = (v) => {
    let s = v == null ? '' : String(v);
    // Neutralize spreadsheet formula injection without mangling plain numbers.
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [cols.join(',')];
  for (const r of questions.getList()) lines.push(cols.map((c) => esc(r[c])).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="questions.csv"');
  res.send(lines.join('\r\n'));
});

module.exports = router;
