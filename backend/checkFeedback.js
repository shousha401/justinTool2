// checkFeedback.js — captures the human diagnosis on each Sanity Check flag.
//
// A flag tells you a batch's numbers can't be true; it can't tell you WHY. The
// person on the floor can. For each flagged batch we ask one short question
// ("output is higher than input — what happened?") with a few likely causes plus
// a free note. Their answers accumulate so we can see the pattern behind the bad
// data (e.g. "90% of weight-gains are 'wrong unit entered'") and chase the real
// upstream fix instead of eyeballing batches forever.
//
// Keyed per (batch, rule) — one batch can trip several rules, each its own answer.
// Stored on disk (data/check-feedback.json, gitignored) mirroring the override
// stores. Read-only against Swarmbox; this is purely our own annotation layer.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'check-feedback.json');

let records = [];     // [{ batch, date, rule, answer, note, by, updatedAt }]
let map = new Map();  // `${batch}|${rule}` -> record

const key = (batch, rule) => `${String(batch).trim()}|${String(rule).trim()}`;

function clean(r) {
  if (!r || !r.batch || !r.rule) return null;
  const batch = String(r.batch).trim();
  const rule = String(r.rule).trim();
  if (!batch || !rule) return null;
  return {
    batch,
    rule,
    date: r.date ? String(r.date).slice(0, 10) : null,
    answer: r.answer ? String(r.answer) : '',
    note: r.note ? String(r.note) : '',
    by: r.by ? String(r.by).slice(0, 60) : '',
    updatedAt: r.updatedAt || null,
  };
}

// Worth keeping only if it carries an actual answer or note.
const isEmpty = (r) => !r.answer && !r.note;

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(arr)) {
      records = arr.map(clean).filter((r) => r && !isEmpty(r));
      map = new Map(records.map((r) => [key(r.batch, r.rule), r]));
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[CheckFeedback] load failed:', e.message);
    records = []; map = new Map();
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(records, null, 2));
  } catch (e) {
    console.error('[CheckFeedback] save failed:', e.message);
  }
}

load();

const get = (batch, rule) => map.get(key(batch, rule)) || null;
// All answers for a batch, as { rule -> record } — used to stitch answers back
// onto the day's flags in one lookup.
function forBatch(batch) {
  const b = String(batch).trim();
  const out = {};
  for (const r of records) if (r.batch === b) out[r.rule] = r;
  return out;
}
const getList = () => records.slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

function set({ batch, rule, date, answer, note, by } = {}) {
  const next = clean({ batch, rule, date, answer, note, by });
  if (!next) return false;
  if (isEmpty(next)) return remove(batch, rule);
  next.updatedAt = new Date().toISOString();
  const k = key(next.batch, next.rule);
  records = records.filter((r) => key(r.batch, r.rule) !== k);
  records.push(next);
  map.set(k, next);
  persist();
  return true;
}

function remove(batch, rule) {
  const k = key(batch, rule);
  if (!map.has(k)) return false;
  records = records.filter((r) => key(r.batch, r.rule) !== k);
  map.delete(k);
  persist();
  return true;
}

module.exports = { get, forBatch, getList, set, remove };
