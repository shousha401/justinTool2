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

## Production Margin tab

A second tab (`/production.html`) reports **daily production margin** — for one
production day, every finished-good line split into:

- **Toll** — we processed a customer's own meat for a fee. Input cost is ≈ $0 (we
  didn't buy the meat), so a line is toll when its batch's avg input cost is under
  `$0.10/lb` *and* the batch isn't our own (`CMP`) production. Revenue = a **contract
  toll rate × lbs** (rates live in `backend/tollRates.js`, the one business-owned file).
- **Own** — we own the meat. Revenue = the line's **sell value**, cost = its **input
  (raw-material) cost**.

Gross profit = revenue − cost; minus a manually-entered **labor** figure (kept in the
browser) = **net contribution**. Results roll up by **production room** and by
**customer**, with a line-by-line **Batch Detail** view.

All of it comes live from Swarmbox's `production_output_cost` RPC (one quick call per
day — no minutes-long sweep). The data layer is solid; the **toll rates are v1 contract
tables** — items with no mapped rate are flagged in a banner and show $0 revenue until a
rate (or a live toll-sale price, a planned fast-follow) is added.

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
| `GET /api/production` | Margin report for the most recent production day. `?date=YYYY-MM-DD` for a specific day; `?refresh=1` to rebuild. |
| `GET /api/production/dates` | Recent production days (newest first) with batch counts — drives the day picker. |
| `GET /api/production/export.csv?date=…` | The day's batch-detail lines as a CSV download. |

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
