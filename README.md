# Product Value Tool

A small standalone Node/Express app that lists **every in-stock product code with its
last selling price** — the most recent sale to any customer, used as that product's
`$value`. Read-only over the Swarmbox PostgREST API. Built in the same style as
clayTool / ShoushaBox and reuses clayTool's Swarmbox client verbatim.

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

2. **Last price — batched** (`backend/pricing.js`)
   `sales_order_lines` accepts a `p_items` array and tags each row with its `item`,
   so codes are priced ~100 per call over the last 360 days (the API's item-filtered
   window cap). For each item the row with the newest `delivery_date` wins → its
   `price` + `price_uom` is the value.

3. **Join + cache** (`backend/valuation.js`)
   Catalog ⨝ prices → the value table, cached in memory (TTL, default 6h) and shared
   across requests so page loads don't re-sweep.

A full refresh is ~10–25 Swarmbox calls and finishes in well under a minute.

## Value semantics

- **`value` = most recent selling price, any customer**, within the lookback window.
- **Prices keep their native unit** (`valueUom`, e.g. `$/LB`). The same item may be
  ordered by the case but priced by the pound, so a bare number would be misleading.
- **No sale in the window → `value` is `null`** ("no recent sale"). The tool never
  substitutes a number that isn't an actual selling price.

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
| `GET /api/values` | Cached value table (`{ builtAt, itemCount, pricedCount, lookbackDays, rows }`). |
| `GET /api/values?refresh=1` | Force a fresh sweep, then return the table. |
| `POST /api/values/refresh` | Force a rebuild, return a summary only. |
| `GET /api/values/export.csv` | The current table as a CSV download. |

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
