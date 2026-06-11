# Product Value Tool

A small standalone Node/Express app that lists **every in-stock product code with its
last selling price in each company tier** — used as that product's `$value`. The
business is two-tier: **CMP → JD** (what we produce and sell to JD, the internal
price) and **JD → customer** (what JD resells it for, the street price). The tool
reports the most recent real sale in each. Read-only over the Swarmbox PostgREST API.
Built in the same style as clayTool / ShoushaBox and reuses clayTool's Swarmbox client
verbatim.

> This app does **not** touch clayTool or ShoushaBox. It only *reads* from Swarmbox
> (`inventory_detail` + `sales_order_lines`) — no writes to any system.

## How it works

1. **Discover in-stock codes — wildcard sweep** (`backend/catalog.js`)
   Swarmbox's `inventory_detail` RPC accepts a SQL `LIKE` wildcard on `p_item`
   (e.g. `05%`) and every lot row carries its own `item` + `description`. The sweep
   walks code prefixes (`0%`…`9%`), projecting to just `item,description` to stay
   light, and de-dupes the `item` column into the live product universe. A prefix
   that returns too many rows (or fails) is automatically subdivided into finer
   prefixes, so no single call is ever oversized on the weak API.

2. **Last price per tier — batched** (`backend/pricing.js`)
   `sales_order_lines` accepts a `p_items` array and tags each row with its `item`
   **and a `company` field** (`CMP` = CMP→JD internal, `JD` = JD→customer street).
   For each item we keep the newest real (price > 0) sale in *each* tier. To stay
   fast over thousands of codes: column-projected, parallel (bounded by the Swarmbox
   semaphore), **tiered windows** (price a recent 60-day window first, widen to the
   full 360 days only for items still missing a tier), and a batch that times out is
   split in half and retried so heavy-history items never drop data.

3. **Join + cache** (`backend/valuation.js`)
   Catalog ⨝ prices → the value table (both tiers per row), cached in memory (TTL,
   default 6h) and shared across requests so page loads don't re-sweep.

A full refresh sweeps the whole WMS (~5,000+ codes) and takes roughly 2–3 minutes;
it's cached and warmed on boot, so page loads hit the cache, not the build.

## Value semantics

- Two prices per item, each = **most recent real sale (price > 0), any customer**,
  within the lookback window:
  - `cmpValue` — **CMP → JD** (internal / production price; buyer "JD Food").
  - `jdValue` — **JD → customer** (street price).
- **Prices keep their native unit** (`cmpValueUom` / `jdValueUom`, e.g. `$/LB`). The
  same item may be ordered by the case but priced by the pound, so a bare number
  would be misleading.
- **No sale in a tier → that value is `null`** (blank "no recent sale"). The tool
  never substitutes a number that isn't an actual selling price. `$0` / internal
  zero-price lines are ignored.

## Price store & daily refresh

The built value table is persisted to a local **SQLite** file (`data/value.db`, via
Node's built-in `node:sqlite` — no dependency, no native build) with **one snapshot per
build day**, which buys two things:

- **Instant restarts.** On boot the last snapshot is loaded straight from disk, so a
  restart/deploy serves prices immediately instead of cold-rebuilding for 2–3 minutes.
  A stale snapshot is served *while* a fresh build runs in the background — so a page
  load never waits on the sweep once any data exists (only the very first build ever does).
- **Price history.** Each day's prices are kept, so you can see how an item's price moved
  over time. In the value table, the **📈** on a row opens its day-by-day series
  (`GET /api/values/history?code=…`). History accumulates one row per day, so trends fill
  in after a few days of runs.

The sweep itself still runs once a day — a scheduled **background refresh** at
`VALUE_REFRESH_HOUR` (default 5 AM, VM local time) rebuilds the table and writes the new
snapshot. The manual **Refresh** button still forces an immediate rebuild. The `data/`
folder is gitignored, so the store lives only on the machine that runs the app.

## Discontinued list

Products you no longer care about can be moved to a **discontinued list** so they're
dropped from the value table. The list is server-side (`data/discontinued.json`, kept
out of git) and applied **right after the catalog sweep, before pricing** — so
discontinued codes never hit the price API and cost ≈ nothing on a rebuild, keeping
rebuilds lighter and the table clean. (Normal page loads are cached either way; this
speeds up the *rebuild*, not the cached read.)

In the **Product Value** tab: the **✕** on any row discontinues it (it disappears
instantly — no rebuild wait); **Discontinue unsold** moves every item with no sale in
either tier at once (the dead weight); **Discontinued (N)** opens the list to **Restore**
anything. Restored items reappear on the next rebuild/Refresh. Discontinuing only affects
the value table — the Production Margin tab still shows whatever was actually produced.

## Production Margin tab

A second tab (`/production.html`) reports **daily production margin** — for one
production day, every finished-good line split into:

- **Toll** — we processed a customer's own meat for a fee. Input cost is ≈ $0 (we
  didn't buy the meat), so a line is toll when its batch's avg input cost is under
  `$0.10/lb` *and* the batch isn't our own (`CMP`) production. Revenue = **toll rate
  × lbs**, where the rate is pulled **live**: the item's most recent real CMP-tier
  sale to an *external* customer (One World, Sugar Mountain, Gourmet, Diestel…) — the
  fee actually billed to the meat's owner. Internal (JD Food / CMP) lines are excluded
  so a transfer price can't masquerade as a toll fee. Items with no recent toll sale
  fall back to the contract rate tables in `backend/tollRates.js`.
- **Own** — we own the meat. Revenue = the line's **sell value**, cost = its **input
  (raw-material) cost**.

Gross profit = revenue − cost; minus a manually-entered **labor** figure (kept in the
browser) = **net contribution**. Results roll up by **production room** and by
**customer**, with a line-by-line **Batch Detail** view.

All of it comes live from Swarmbox (`production_output_cost` for the day's lines,
`sales_order_lines` for each toll item's latest billed rate) — one quick set of calls,
no minutes-long sweep. A toll line's rate is resolved **live → manual → contract**: the
most recent real sale to a toll account (`…-TOLL`, Gourmet, Diestel) wins; failing that,
a **manual rate** you typed in; failing that, the contract table in `tollRates.js`. A
small note shows the live/manual/contract/no-rate split.

The rare item with no rate at all shows $0 and is flagged — in **Batch Detail** those
lines have an inline **$/lb box**: type a rate and it's saved (`data/toll-rates.json`,
gitignored) and applied to that item everywhere. It's a fallback only — if a real toll
sale later appears, the live price automatically takes over. Clear the box to remove it.

**Toll vs Own is also overridable.** The Type column in Batch Detail is an
**Auto / Toll / Own** selector: "Auto" uses the automatic rule (and shows what it
decided, e.g. "Auto (Own)"), or pick Toll/Own to force an item either way. Overrides
are per-item, saved to `data/class-overrides.json` (gitignored), and the report
recomputes on change. This is how you settle items the rule can't (e.g. JD Food).

## Run

```bash
npm install
cp .env.example .env   # adjust if needed
npm start              # http://localhost:3004
```

PM2 (matches the other tools):

```bash
pm2 start ecosystem.config.js
pm2 save
```

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/values` | Cached value table (`{ builtAt, itemCount, pricedCmp, pricedJd, lookbackDays, rows }`). Each row: `productCode, description, cmpValue, cmpValueUom, cmpLastSoldDate, jdValue, jdValueUom, jdLastSoldDate, jdCustomer`. |
| `GET /api/values?refresh=1` | Force a fresh sweep, then return the table. |
| `POST /api/values/refresh` | Force a rebuild, return a summary only. |
| `GET /api/values/export.csv` | The current table as a CSV download. |
| `GET /api/values/history?code=…` | Day-by-day price snapshots for one item (`{ code, history: [{ date, cmpValue, jdValue, … }] }`). |
| `GET /api/production` | Margin report for the most recent production day. `?date=YYYY-MM-DD` for a specific day; `?refresh=1` to rebuild. |
| `GET /api/production/dates` | Recent production days (newest first) with batch counts — drives the day picker. |
| `GET /api/production/export.csv?date=…` | The day's batch-detail lines as a CSV download. |
| `GET /api/production/rates` | Manual per-item toll rates (`{ rates: [{ code, rate, note, updatedAt }] }`). |
| `POST /api/production/rates` | Set a manual toll rate (`{ code, rate, note }`); used only where there's no live/contract rate. |
| `DELETE /api/production/rates/:code` | Remove a manual toll rate. |
| `GET /api/production/overrides` | Manual Toll/Own classifications (`{ overrides: [{ code, mode, updatedAt }] }`). |
| `POST /api/production/overrides` | Force an item Toll or Own (`{ code, mode }`, mode = `toll`\|`own`). |
| `DELETE /api/production/overrides/:code` | Revert an item to automatic classification. |
| `GET /api/discontinued` | The discontinued list (`{ rows: [{ code, description, addedAt }] }`). |
| `POST /api/discontinued` | Discontinue one item (`{ code, description }`); drops it from the live cache immediately. |
| `POST /api/discontinued/bulk-unsold` | Discontinue every item with no sale in either tier. |
| `DELETE /api/discontinued/:code` | Restore an item (reappears on the next value-table rebuild). |

## Configuration (`.env`)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3004` | HTTP port. |
| `SWARMBOX_BASE_URL` | `https://jdfood.swarmbox.com:443/pg-api` | Swarmbox REST base. |
| `SWARMBOX_TIMEOUT_MS` | `30000` | Per-request timeout. |
| `SWARMBOX_CONCURRENCY` | `4` | Process-wide cap on parallel Swarmbox calls. |
| `VALUE_LOOKBACK_DAYS` | `360` | Sales window for "last price" (max 360). |
| `VALUE_CACHE_TTL_MS` | `21600000` | How long a built table is reused (6h). |
| `CATALOG_ROW_BUDGET` | `50000` | Subdivide a wildcard prefix above this many rows. |
| `PRODUCTION_CACHE_TTL_MS` | `300000` | How long a built day's margin report is reused (5m). |
