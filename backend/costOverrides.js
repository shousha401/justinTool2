// costOverrides.js — manual raw-material $/lb corrections for a production line.
// The cost-side twin of priceOverrides.js: a forced PRICE corrects a line's
// revenue rate; this corrects its input cost. Needed because Swarmbox costs a
// batch's WIP draw at the item's blended average, and when the automatic
// chained-draw re-costing (recostChainedDraws) can't prove the chain by matching
// pounds — a partial draw, competing producers — the blended number stands even
// when the user KNOWS it's wrong. This is the "here's the right $/lb" tool for
// exactly that case.
//
// Precedence in the build: manual cost override > chained re-cost > Swarmbox
// blended. The override changes the MONEY only — it never feeds toll/own
// classification (that has its own override), and toll lines still carry $0.
//
// Scope: per item code, optionally pinned to one batch. Batch numbers are unique
// to a production day, so a batch-scoped record naturally corrects just that
// day's line; an unscoped record applies to every batch of the item (rare — for
// an item whose blend is chronically wrong). A batch-scoped record wins over the
// item-wide one. Stored on disk (data/cost-overrides.json, gitignored) so it
// persists and affects the build.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'cost-overrides.json');

let records = [];    // [{ code, batch, rate, note, updatedAt }]  batch null = all batches
let map = new Map(); // `${code}|${batch ?? ''}` -> record

const keyOf = (code, batch) => `${code}|${batch || ''}`;

function clean(r) {
  if (!r || !r.code) return null;
  const code = String(r.code).trim();
  const rate = Number(r.rate);
  if (!code || !(rate > 0)) return null;
  const batch = r.batch == null ? null : String(r.batch).trim() || null;
  return { code, batch, rate, note: r.note ? String(r.note) : '', updatedAt: r.updatedAt || null };
}

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(arr)) {
      records = arr.map(clean).filter(Boolean);
      map = new Map(records.map((r) => [keyOf(r.code, r.batch), r]));
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[CostOverrides] load failed:', e.message);
    records = []; map = new Map();
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(records, null, 2));
  } catch (e) {
    console.error('[CostOverrides] save failed:', e.message);
  }
}

load();

// The override in effect for one production line: its batch's record if there is
// one, else the item-wide record.
function get(code, batch) {
  code = String(code || '').trim();
  const b = batch == null ? '' : String(batch).trim();
  return (b && map.get(keyOf(code, b))) || map.get(keyOf(code, null)) || null;
}

const getList = () => records.slice().sort((a, b) =>
  a.code !== b.code ? (a.code < b.code ? -1 : 1) : String(a.batch || '') < String(b.batch || '') ? -1 : 1);

function set(code, batch, rate, note) {
  const next = clean({ code, batch, rate, note });
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
