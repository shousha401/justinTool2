// customerOverrides.js — user-set customer per item, overriding parseCustomer's
// automatic guess (which reads batch notes + description). This is the "transfer
// an item from one customer to another" store: pick a customer for an item code
// and every line of that item rolls up under it everywhere — the production
// report, the stored daily summaries, the Owner's Dashboard, and the Customers
// tab (they all read one field, `customer`).
//
// Per item CODE (global, like manual rates / class overrides), so a transfer
// sticks across days and survives the report being recomputed from Swarmbox.
// Stored on disk (data/customer-overrides.json, gitignored) so it persists.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'customer-overrides.json');

let records = [];          // [{ code, customer, updatedAt }]
let custMap = new Map();   // code -> customer

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(arr)) {
      records = arr
        .filter((r) => r && r.code && r.customer)
        .map((r) => ({ code: String(r.code).trim(), customer: String(r.customer).trim(), updatedAt: r.updatedAt || null }));
      custMap = new Map(records.map((r) => [r.code, r.customer]));
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[CustomerOverrides] load failed:', e.message);
    records = []; custMap = new Map();
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(records, null, 2));
  } catch (e) {
    console.error('[CustomerOverrides] save failed:', e.message);
  }
}

load();

const getCustomer = (code) => custMap.get(String(code).trim());
const getList = () => records.slice().sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

function set(code, customer) {
  code = String(code || '').trim();
  customer = String(customer || '').trim();
  if (!code || !customer) return false;
  const existing = records.find((r) => r.code === code);
  if (existing) {
    existing.customer = customer;
    existing.updatedAt = new Date().toISOString();
  } else {
    records.push({ code, customer, updatedAt: new Date().toISOString() });
  }
  custMap.set(code, customer);
  persist();
  return true;
}

function remove(code) {
  code = String(code || '').trim();
  if (!custMap.has(code)) return false;
  records = records.filter((r) => r.code !== code);
  custMap.delete(code);
  persist();
  return true;
}

module.exports = { getCustomer, getList, set, remove };
