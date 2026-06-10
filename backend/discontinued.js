// discontinued.js — a small persisted list of product codes to exclude from the
// value table. Discontinued codes are dropped right after the catalog sweep,
// before the expensive price lookups, so they cost ~nothing on a rebuild and
// never clutter the table. Stored as plain JSON on disk so it survives restarts.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'discontinued.json');

let records = [];          // [{ code, description, addedAt }]
let codeSet = new Set();   // fast membership for the build filter

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(arr)) {
      records = arr
        .filter((r) => r && r.code)
        .map((r) => ({ code: String(r.code).trim(), description: r.description || '', addedAt: r.addedAt || null }));
      codeSet = new Set(records.map((r) => r.code));
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[Discontinued] load failed:', e.message);
    records = []; codeSet = new Set();
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(records, null, 2));
  } catch (e) {
    console.error('[Discontinued] save failed:', e.message);
  }
}

load();

const getCodes = () => codeSet; // live Set — valuation.js reads this each build
const getList = () => records.slice().sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

function add(code, description, addedAt) {
  code = String(code || '').trim();
  if (!code || codeSet.has(code)) return false;
  records.push({ code, description: description || '', addedAt: addedAt || new Date().toISOString() });
  codeSet.add(code);
  persist();
  return true;
}

// items: [{ code, description }]. Returns how many were newly added.
function addMany(items, addedAt) {
  const stamp = addedAt || new Date().toISOString();
  let added = 0;
  for (const it of items) {
    const code = String((it && it.code) || '').trim();
    if (!code || codeSet.has(code)) continue;
    records.push({ code, description: (it && it.description) || '', addedAt: stamp });
    codeSet.add(code);
    added++;
  }
  if (added) persist();
  return added;
}

function remove(code) {
  code = String(code || '').trim();
  if (!codeSet.has(code)) return false;
  records = records.filter((r) => r.code !== code);
  codeSet.delete(code);
  persist();
  return true;
}

module.exports = { getCodes, getList, add, addMany, remove };
