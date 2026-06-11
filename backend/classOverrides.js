// classOverrides.js — user-set Toll/Own classification per item, overriding the
// automatic rule (≈$0 input cost / has a toll price). Stored on disk so it sticks.
//
// mode is 'toll' or 'own'. An override wins over the heuristic; removing it
// reverts that item to Auto. Per-item (like manual rates) so it survives the
// report being recomputed from Swarmbox each load.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'class-overrides.json');

let records = [];          // [{ code, mode, updatedAt }]
let modeMap = new Map();   // code -> 'toll' | 'own'

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(arr)) {
      records = arr
        .filter((r) => r && r.code && (r.mode === 'toll' || r.mode === 'own'))
        .map((r) => ({ code: String(r.code).trim(), mode: r.mode, updatedAt: r.updatedAt || null }));
      modeMap = new Map(records.map((r) => [r.code, r.mode]));
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[ClassOverrides] load failed:', e.message);
    records = []; modeMap = new Map();
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(records, null, 2));
  } catch (e) {
    console.error('[ClassOverrides] save failed:', e.message);
  }
}

load();

const getMode = (code) => modeMap.get(String(code).trim());
const getList = () => records.slice().sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

function set(code, mode) {
  code = String(code || '').trim();
  if (!code || (mode !== 'toll' && mode !== 'own')) return false;
  const existing = records.find((r) => r.code === code);
  if (existing) {
    existing.mode = mode;
    existing.updatedAt = new Date().toISOString();
  } else {
    records.push({ code, mode, updatedAt: new Date().toISOString() });
  }
  modeMap.set(code, mode);
  persist();
  return true;
}

function remove(code) {
  code = String(code || '').trim();
  if (!modeMap.has(code)) return false;
  records = records.filter((r) => r.code !== code);
  modeMap.delete(code);
  persist();
  return true;
}

module.exports = { getMode, getList, set, remove };
