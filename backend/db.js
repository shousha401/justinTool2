// db.js — local SQLite store for the value table (Node's built-in node:sqlite,
// no dependency, no native build). Two jobs:
//   1. Persist the latest built table so a restart serves prices instantly
//      instead of cold-rebuilding for 2–3 minutes.
//   2. Keep one snapshot per build day → price history for trends.
//
// One row per (snapshot_date, product_code). "Latest" = the newest snapshot_date.

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.VALUE_DB_PATH || path.join(__dirname, '..', 'data', 'value.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS builds (
    snapshot_date TEXT PRIMARY KEY,
    built_at      INTEGER,
    build_ms      INTEGER,
    lookback_days INTEGER,
    item_count    INTEGER,
    priced_cmp    INTEGER,
    priced_jd     INTEGER,
    discontinued  INTEGER
  );
  CREATE TABLE IF NOT EXISTS value_history (
    snapshot_date TEXT NOT NULL,
    product_code  TEXT NOT NULL,
    description   TEXT,
    cmp_value     REAL,
    cmp_uom       TEXT,
    cmp_last_sold TEXT,
    jd_value      REAL,
    jd_uom        TEXT,
    jd_last_sold  TEXT,
    jd_customer   TEXT,
    PRIMARY KEY (snapshot_date, product_code)
  );
  CREATE INDEX IF NOT EXISTS idx_vh_code ON value_history (product_code);
  CREATE TABLE IF NOT EXISTS prod_summary (
    date      TEXT PRIMARY KEY,
    built_at  INTEGER,
    gp        REAL,
    rev       REAL,
    toll_rev  REAL,
    own_rev   REAL,
    lbs       REAL,
    cs        REAL,
    ic        REAL,
    lines     INTEGER,
    payload   TEXT
  );
`);

// Reusable statements
const delDay = db.prepare('DELETE FROM value_history WHERE snapshot_date = ?');
const insRow = db.prepare(`INSERT INTO value_history
  (snapshot_date, product_code, description, cmp_value, cmp_uom, cmp_last_sold, jd_value, jd_uom, jd_last_sold, jd_customer)
  VALUES (?,?,?,?,?,?,?,?,?,?)`);
const upsertBuild = db.prepare(`INSERT INTO builds
  (snapshot_date, built_at, build_ms, lookback_days, item_count, priced_cmp, priced_jd, discontinued)
  VALUES (?,?,?,?,?,?,?,?)
  ON CONFLICT(snapshot_date) DO UPDATE SET
    built_at=excluded.built_at, build_ms=excluded.build_ms, lookback_days=excluded.lookback_days,
    item_count=excluded.item_count, priced_cmp=excluded.priced_cmp, priced_jd=excluded.priced_jd,
    discontinued=excluded.discontinued`);

// Replace a day's snapshot (idempotent — re-running the same day overwrites it).
function saveSnapshot(snapshotDate, rows, meta) {
  db.exec('BEGIN');
  try {
    delDay.run(snapshotDate);
    for (const r of rows) {
      insRow.run(
        snapshotDate, r.productCode, r.description ?? null,
        r.cmpValue ?? null, r.cmpValueUom ?? null, r.cmpLastSoldDate ?? null,
        r.jdValue ?? null, r.jdValueUom ?? null, r.jdLastSoldDate ?? null, r.jdCustomer ?? null,
      );
    }
    upsertBuild.run(
      snapshotDate, meta.builtAt, meta.buildMs, meta.lookbackDays,
      meta.itemCount, meta.pricedCmp, meta.pricedJd, meta.discontinued,
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function toRow(r) {
  return {
    productCode: r.product_code,
    description: r.description || '',
    cmpValue: r.cmp_value, cmpValueUom: r.cmp_uom, cmpLastSoldDate: r.cmp_last_sold,
    jdValue: r.jd_value, jdValueUom: r.jd_uom, jdLastSoldDate: r.jd_last_sold, jdCustomer: r.jd_customer,
    hasCmp: r.cmp_value != null, hasJd: r.jd_value != null,
  };
}

// The most recent snapshot, shaped exactly like valuation's in-memory cache.
function loadLatest() {
  const meta = db.prepare('SELECT * FROM builds ORDER BY snapshot_date DESC LIMIT 1').get();
  if (!meta) return null;
  const rows = db.prepare('SELECT * FROM value_history WHERE snapshot_date = ? ORDER BY product_code').all(meta.snapshot_date).map(toRow);
  return {
    rows,
    snapshotDate: meta.snapshot_date,
    builtAt: meta.built_at,
    buildMs: meta.build_ms,
    lookbackDays: meta.lookback_days,
    itemCount: meta.item_count,
    pricedCmp: meta.priced_cmp,
    pricedJd: meta.priced_jd,
    discontinued: meta.discontinued,
  };
}

// Day-by-day price series for one item (newest first) — for trend views.
function priceHistory(productCode, limit = 120) {
  const lim = Math.max(1, Math.min(1000, Number(limit) || 120));
  return db.prepare(`SELECT snapshot_date, cmp_value, cmp_uom, jd_value, jd_uom, jd_customer
    FROM value_history WHERE product_code = ? ORDER BY snapshot_date DESC LIMIT ?`).all(String(productCode), lim)
    .map((r) => ({
      date: r.snapshot_date,
      cmpValue: r.cmp_value, cmpUom: r.cmp_uom,
      jdValue: r.jd_value, jdUom: r.jd_uom, jdCustomer: r.jd_customer,
    }));
}

// ── Production daily margin summaries (for the Owner's Dashboard) ─────────────
const upsertProd = db.prepare(`INSERT INTO prod_summary
  (date, built_at, gp, rev, toll_rev, own_rev, lbs, cs, ic, lines, payload)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(date) DO UPDATE SET
    built_at=excluded.built_at, gp=excluded.gp, rev=excluded.rev, toll_rev=excluded.toll_rev,
    own_rev=excluded.own_rev, lbs=excluded.lbs, cs=excluded.cs, ic=excluded.ic,
    lines=excluded.lines, payload=excluded.payload`);

// s: { date, builtAt, lines, v, totals:{gp,rev,tollRev,ownRev,lbs,cs,ic}, customers:[{...,items:[]}] }
function saveProdSummary(s) {
  const t = s.totals || {};
  upsertProd.run(
    s.date, s.builtAt || null, t.gp || 0, t.rev || 0, t.tollRev || 0, t.ownRev || 0,
    t.lbs || 0, t.cs || 0, t.ic || 0, s.lines || 0,
    JSON.stringify({ v: s.v || 1, customers: s.customers || [] }),
  );
}

function loadProdSummaries(fromDate, toDate) {
  return db.prepare('SELECT * FROM prod_summary WHERE date >= ? AND date <= ? ORDER BY date').all(fromDate, toDate)
    .map((r) => {
      let p = {}; try { p = JSON.parse(r.payload || '{}'); } catch (e) { /* ignore */ }
      return {
        date: r.date, builtAt: r.built_at, v: p.v || 1,
        gp: r.gp, rev: r.rev, tollRev: r.toll_rev, ownRev: r.own_rev,
        lbs: r.lbs, cs: r.cs, ic: r.ic, lines: r.lines,
        customers: p.customers || [], items: p.items || [], // items: legacy v1 only
      };
    });
}

const prodSummaryDates = () => db.prepare('SELECT date FROM prod_summary').all().map((r) => r.date);

module.exports = { saveSnapshot, loadLatest, priceHistory, saveProdSummary, loadProdSummaries, prodSummaryDates };
