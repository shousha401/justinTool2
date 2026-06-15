// valueOverrides.js — manual corrections for the Product Value table.
//
// Each item shows two tier prices pulled from Swarmbox: CMP→JD (internal) and
// JD→customer (street). When Swarmbox pulls the wrong number, the boss can type
// the correct value for either tier AND choose, per tier, which source the table
// should use — `swarmbox` (the live last-sale) or `manual` (the typed number).
// Both numbers stay visible, so nothing is silently overwritten and you can flip
// back to the live rate without retyping.
//
// Per item CODE (global, like the other override stores). Stored on disk
// (data/value-overrides.json, gitignored) and applied to the served value table
// immediately by valuation.js — no rebuild needed.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'value-overrides.json');

let records = [];      // [{ code, cmpManual, cmpUom, cmpUse, jdManual, jdUom, jdUse, note, updatedAt }]
let map = new Map();   // code -> record

const num = (v) => { const n = Number(v); return n > 0 ? n : null; };
const uom = (v) => { const s = String(v == null ? '' : v).trim().toUpperCase(); return s || 'LB'; };
const use = (v) => (v === 'swarmbox' ? 'swarmbox' : 'manual'); // default to manual

function clean(r) {
  if (!r || !r.code) return null;
  const code = String(r.code).trim();
  if (!code) return null;
  return {
    code,
    cmpManual: num(r.cmpManual),
    cmpUom: uom(r.cmpUom),
    cmpUse: use(r.cmpUse),
    jdManual: num(r.jdManual),
    jdUom: uom(r.jdUom),
    jdUse: use(r.jdUse),
    note: r.note ? String(r.note) : '',
    updatedAt: r.updatedAt || null,
  };
}

// Worth keeping only if at least one tier carries a manual number — otherwise
// there's nothing to override and the record is treated as a delete.
const isEmpty = (r) => r.cmpManual == null && r.jdManual == null;

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(arr)) {
      records = arr.map(clean).filter((r) => r && !isEmpty(r));
      map = new Map(records.map((r) => [r.code, r]));
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[ValueOverrides] load failed:', e.message);
    records = []; map = new Map();
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(records, null, 2));
  } catch (e) {
    console.error('[ValueOverrides] save failed:', e.message);
  }
}

load();

const get = (code) => map.get(String(code).trim()) || null;
const getList = () => records.slice().sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

// Merge a change into an item's override. Fields left undefined are preserved,
// so you can set the internal price now and the street price later without
// losing the other half. Clearing both manual numbers removes the record.
function set(code, patch = {}) {
  code = String(code || '').trim();
  if (!code) return false;
  const prev = map.get(code) || {
    code, cmpManual: null, cmpUom: 'LB', cmpUse: 'manual',
    jdManual: null, jdUom: 'LB', jdUse: 'manual', note: '',
  };
  const next = clean({
    code,
    cmpManual: patch.cmpManual !== undefined ? patch.cmpManual : prev.cmpManual,
    cmpUom: patch.cmpUom !== undefined ? patch.cmpUom : prev.cmpUom,
    cmpUse: patch.cmpUse !== undefined ? patch.cmpUse : prev.cmpUse,
    jdManual: patch.jdManual !== undefined ? patch.jdManual : prev.jdManual,
    jdUom: patch.jdUom !== undefined ? patch.jdUom : prev.jdUom,
    jdUse: patch.jdUse !== undefined ? patch.jdUse : prev.jdUse,
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
