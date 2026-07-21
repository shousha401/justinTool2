// lineExcludes.js — manual "exclude this line from margin" markers.
// NOT a delete: the app is read-only against Swarmbox and a silently dropped
// line rewrites the day's money with no trace (see the sales-map lesson in
// production.js). An excluded line stays VISIBLE in Batch Detail — dimmed, with
// its note — but is kept out of every rollup, total, and stored summary, and the
// day header counts the exclusions. One click restores it.
//
// Scope works like costOverrides: per item code, optionally pinned to one batch
// (batch numbers are day-specific, so a batch-scoped record excludes just that
// day's line); a batch-scoped record wins over an item-wide one. Stored on disk
// (data/line-excludes.json, gitignored) and folded into overrideSignature() so
// stored daily summaries recompute when an exclusion changes.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'line-excludes.json');

let records = [];    // [{ code, batch, note, updatedAt }]  batch null = all batches
let map = new Map(); // `${code}|${batch ?? ''}` -> record

const keyOf = (code, batch) => `${code}|${batch || ''}`;

function clean(r) {
  if (!r || !r.code) return null;
  const code = String(r.code).trim();
  if (!code) return null;
  const batch = r.batch == null ? null : String(r.batch).trim() || null;
  return { code, batch, note: r.note ? String(r.note) : '', updatedAt: r.updatedAt || null };
}

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(arr)) {
      records = arr.map(clean).filter(Boolean);
      map = new Map(records.map((r) => [keyOf(r.code, r.batch), r]));
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[LineExcludes] load failed:', e.message);
    records = []; map = new Map();
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(records, null, 2));
  } catch (e) {
    console.error('[LineExcludes] save failed:', e.message);
  }
}

load();

// The exclusion in effect for one production line: its batch's record if there
// is one, else the item-wide record.
function get(code, batch) {
  code = String(code || '').trim();
  const b = batch == null ? '' : String(batch).trim();
  return (b && map.get(keyOf(code, b))) || map.get(keyOf(code, null)) || null;
}

const getList = () => records.slice().sort((a, b) =>
  a.code !== b.code ? (a.code < b.code ? -1 : 1) : String(a.batch || '') < String(b.batch || '') ? -1 : 1);

function set(code, batch, note) {
  const next = clean({ code, batch, note });
  if (!next) return false;
  next.updatedAt = new Date().toISOString();
  const key = keyOf(next.code, next.batch);
  records = records.filter((r) => keyOf(r.code, r.batch) !== key);
  records.push(next);
  map.set(key, next);
  persist();
  return true;
}

function remove(code, batch) {
  code = String(code || '').trim();
  const b = batch == null ? null : String(batch).trim() || null;
  const key = keyOf(code, b);
  if (!map.has(key)) return false;
  records = records.filter((r) => keyOf(r.code, r.batch) !== key);
  map.delete(key);
  persist();
  return true;
}

module.exports = { get, getList, set, remove };
