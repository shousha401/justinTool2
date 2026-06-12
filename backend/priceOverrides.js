// priceOverrides.js — authoritative per-item price corrections for the
// "Prices Today" page. Unlike manualRates.js (a FALLBACK that only fills a gap
// and loses to a real sale), a price override WINS over everything Swarmbox
// pulls — live toll price, own/sale price, contract, standard — until cleared.
// It's for the case "Swarmbox is pulling the wrong number; here's the right one."
//
// Each record can carry two independent things:
//   - rate     : the forced $/lb (the right value). Optional.
//   - flagged  : "this line was pulling from the wrong area" — a review marker.
//                When you flag, we snapshot what it WAS pulling (wrongBasis +
//                wrongSource) and an optional note, so when you come back you see
//                what was wrong and can chase down the correct Swarmbox source.
//
// Per item CODE (global, like the other override stores). Stored on disk
// (data/price-overrides.json, gitignored) so it persists and affects the build.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'price-overrides.json');

let records = [];        // [{ code, rate, flagged, wrongBasis, wrongSource, note, updatedAt }]
let map = new Map();     // code -> record

function clean(r) {
  if (!r || !r.code) return null;
  const code = String(r.code).trim();
  if (!code) return null;
  const rate = Number(r.rate);
  return {
    code,
    rate: rate > 0 ? rate : null,
    flagged: !!r.flagged,
    wrongBasis: r.wrongBasis ? String(r.wrongBasis) : null,
    wrongSource: r.wrongSource ? String(r.wrongSource) : null,
    note: r.note ? String(r.note) : '',
    updatedAt: r.updatedAt || null,
  };
}

// A record is only worth keeping if it actually does something (forces a price
// or carries a flag). Lets us treat "blank + unflagged" as a delete.
const isEmpty = (r) => !(r.rate > 0) && !r.flagged;

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(arr)) {
      records = arr.map(clean).filter((r) => r && !isEmpty(r));
      map = new Map(records.map((r) => [r.code, r]));
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[PriceOverrides] load failed:', e.message);
    records = []; map = new Map();
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(records, null, 2));
  } catch (e) {
    console.error('[PriceOverrides] save failed:', e.message);
  }
}

load();

const get = (code) => map.get(String(code).trim()) || null;
const getList = () => records.slice().sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

// Merge a change into an item's override. Fields left undefined are preserved,
// so you can set a price now and flag later (or vice-versa) without losing the
// other half. Clearing both the price and the flag removes the record.
function set(code, patch = {}) {
  code = String(code || '').trim();
  if (!code) return false;
  const prev = map.get(code) || { code, rate: null, flagged: false, wrongBasis: null, wrongSource: null, note: '' };
  const next = clean({
    code,
    rate: patch.rate !== undefined ? patch.rate : prev.rate,
    flagged: patch.flagged !== undefined ? patch.flagged : prev.flagged,
    wrongBasis: patch.wrongBasis !== undefined ? patch.wrongBasis : prev.wrongBasis,
    wrongSource: patch.wrongSource !== undefined ? patch.wrongSource : prev.wrongSource,
    note: patch.note !== undefined ? patch.note : prev.note,
  });
  if (isEmpty(next)) return remove(code);
  next.updatedAt = new Date().toISOString();
  records = records.filter((r) => r.code !== code);
  records.push(next);
  map.set(code, next);
  persist();
  return true;
}

function remove(code) {
  code = String(code || '').trim();
  if (!map.has(code)) return false;
  records = records.filter((r) => r.code !== code);
  map.delete(code);
  persist();
  return true;
}

module.exports = { get, getList, set, remove };
