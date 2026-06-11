// manualRates.js — user-entered toll rates ($/lb per item), for toll items that
// have no live toll sale and no contract rate (the "⚠ no rate" $0 lines). Stored
// on disk so they persist and actually affect the computed report.
//
// These are a FALLBACK only: production.js prefers a live toll sale, then a manual
// rate, then the contract table. So a real sale always wins and a manual number
// can't silently mask live data.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'toll-rates.json');

let records = [];          // [{ code, rate, note, updatedAt }]
let rateMap = new Map();   // code -> rate (fast lookup in the build)

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(arr)) {
      records = arr
        .filter((r) => r && r.code && Number(r.rate) > 0)
        .map((r) => ({ code: String(r.code).trim(), rate: Number(r.rate), note: r.note || '', updatedAt: r.updatedAt || null }));
      rateMap = new Map(records.map((r) => [r.code, r.rate]));
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[ManualRates] load failed:', e.message);
    records = []; rateMap = new Map();
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(records, null, 2));
  } catch (e) {
    console.error('[ManualRates] save failed:', e.message);
  }
}

load();

const getRate = (code) => rateMap.get(String(code).trim());
const getList = () => records.slice().sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

function set(code, rate, note) {
  code = String(code || '').trim();
  rate = Number(rate);
  if (!code || !(rate > 0)) return false;
  const existing = records.find((r) => r.code === code);
  if (existing) {
    existing.rate = rate;
    if (note != null) existing.note = note;
    existing.updatedAt = new Date().toISOString();
  } else {
    records.push({ code, rate, note: note || '', updatedAt: new Date().toISOString() });
  }
  rateMap.set(code, rate);
  persist();
  return true;
}

function remove(code) {
  code = String(code || '').trim();
  if (!rateMap.has(code)) return false;
  records = records.filter((r) => r.code !== code);
  rateMap.delete(code);
  persist();
  return true;
}

module.exports = { getRate, getList, set, remove };
