// questions.js — "I don't believe this number. Why is it that?"
//
// The explainer shows HOW a number was derived, but it can't know when the derivation
// is wrong, or when the person reading it knows something we don't ("that batch was
// re-weighed", "that customer moved in June"). This is the channel for that: anyone
// can question any line, the question is captured WITH the numbers exactly as they saw
// them, and it waits in a queue until someone answers it.
//
// Capturing the numbers at ask-time matters. A question like "why is raw material so
// high on 655021?" is unanswerable a week later if the report has since been rebuilt
// with new overrides — the number they were looking at is gone. So we snapshot it.
//
// Stored on disk (data/questions.json, gitignored) mirroring the override stores and
// checkFeedback. Purely our own annotation layer — nothing is written to Swarmbox.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'questions.json');
const MAX_LEN = 2000;

let records = [];        // newest first
let seq = 0;

const str = (v, n = 200) => (v == null ? '' : String(v).slice(0, n));

function clean(q) {
  if (!q) return null;
  const question = str(q.question, MAX_LEN).trim();
  if (!question) return null;                 // a question with no question is nothing
  return {
    id: q.id || `q${Date.now().toString(36)}${(seq++).toString(36)}`,
    // What was being questioned
    date: q.date ? str(q.date, 10) : null,    // production day
    item: str(q.item, 20),
    batch: str(q.batch, 30),
    description: str(q.description, 120),
    field: str(q.field, 30) || 'other',       // rawMaterial | rate | customer | type | gp | other
    // The numbers AS THE ASKER SAW THEM — so the question stays answerable after a rebuild.
    snapshot: q.snapshot && typeof q.snapshot === 'object' ? q.snapshot : null,
    question,
    askedBy: str(q.askedBy, 60),
    askedAt: q.askedAt || new Date().toISOString(),
    // The reply
    answer: str(q.answer, MAX_LEN),
    answeredBy: str(q.answeredBy, 60),
    answeredAt: q.answeredAt || null,
    resolved: !!q.resolved,
  };
}

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(arr)) records = arr.map(clean).filter(Boolean);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[Questions] load failed:', e.message);
    records = [];
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(records, null, 2));
  } catch (e) {
    console.error('[Questions] save failed:', e.message);
  }
}

load();

const byNewest = (a, b) => String(b.askedAt).localeCompare(String(a.askedAt));

// All questions, optionally filtered. `status`: 'open' | 'answered' | undefined (all).
function getList({ status, item, date } = {}) {
  let out = records.slice();
  if (status === 'open') out = out.filter((r) => !r.answer);
  if (status === 'answered') out = out.filter((r) => !!r.answer);
  if (item) out = out.filter((r) => r.item === String(item).trim());
  if (date) out = out.filter((r) => r.date === String(date).slice(0, 10));
  return out.sort(byNewest);
}

// Questions attached to a given production day, as { `${batch}|${item}` -> [q] }, so the
// Production page can badge the exact lines that have an open question.
function forDate(date) {
  const d = String(date || '').slice(0, 10);
  const out = {};
  for (const r of records) {
    if (r.date !== d) continue;
    const k = `${r.batch}|${r.item}`;
    (out[k] = out[k] || []).push(r);
  }
  return out;
}

const openCount = () => records.filter((r) => !r.answer).length;

function ask(q) {
  const next = clean(q);
  if (!next) return null;
  next.answer = '';            // a new question is never born answered
  next.answeredBy = '';
  next.answeredAt = null;
  next.resolved = false;
  records.unshift(next);
  persist();
  return next;
}

function answer(id, { answer: text, answeredBy, resolved } = {}) {
  const r = records.find((x) => x.id === id);
  if (!r) return null;
  r.answer = str(text, MAX_LEN);
  r.answeredBy = str(answeredBy, 60);
  r.answeredAt = r.answer ? new Date().toISOString() : null;
  if (resolved !== undefined) r.resolved = !!resolved;
  persist();
  return r;
}

function remove(id) {
  const before = records.length;
  records = records.filter((r) => r.id !== id);
  if (records.length === before) return false;
  persist();
  return true;
}

module.exports = { getList, forDate, openCount, ask, answer, remove };
