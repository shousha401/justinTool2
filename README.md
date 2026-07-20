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

### Correcting a value (manual override)

When Swarmbox pulls the **wrong** number for a tier — or an item has no sale and you
know its value anyway — the **✎** on a row opens an editor. For each tier (Internal
CMP→JD and Street JD→Customer) you see the **live Swarmbox rate** and can type a
**manual rate**, then choose **which source the table uses** (Swarmbox vs. manual) for
that tier. Both numbers stay visible, so nothing is silently overwritten and you can
flip back to the live rate without retyping. A manual cell is tagged **MANUAL** and its
tooltip still shows what Swarmbox pulls.

Overrides are per item code, saved to `data/value-overrides.json` (gitignored), and
applied as a **serve-time overlay** — they take effect on the table immediately (no
rebuild) and re-apply on every daily build. The **price history** (📈) and the SQLite
snapshots stay **real-sales-only** — the overlay never pollutes them.

## Owner's Dashboard

A period view (**7 / 14 / 30 days**) of production margin — the "how's the business
doing" screen. KPI cards (revenue with toll/own split, raw material, gross profit + GP%,
avg GP/day, lbs, net after labor), a daily **gross-profit bar chart**, and the **top &
bottom customers and products** by GP for the period.

It reads stored daily margin summaries (one row per production day in SQLite,
`prod_summary`), written whenever a day is built and **backfilled for the last 30
production days on boot** — so it loads instantly with real history (production margin is
recomputable from Swarmbox, so there's nothing to wait for). Days whose Swarmbox fetch
errors out are **excluded, not shown as a false $0**.

**The page never blocks on a recompute.** The Dashboard and Customers routes serve
whatever summaries are already stored **immediately** and, if any day is stale (missing,
older `SUMMARY_VERSION`, or built before the latest overrides), kick the recompute in the
**background** and return `refreshing: true` with a `pending` day count. The page shows an
"updating…" note and **re-fetches itself every few seconds** until it catches up — so a
restart or a version bump (which marks every day stale) can no longer freeze the page for
minutes the way an `await`-on-backfill did.

## Customers tab

A profitability **scorecard**: every customer ranked by gross profit over the period
(7/14/30 days), with their **toll/own revenue mix**, GP%, and the **change vs. the prior
equal-length period** (▲/▼). Click a customer to drill down into their **top products**
and a **day-by-day GP** mini-chart. Columns are sortable. It reuses the same stored daily
summaries as the dashboard (`prod_summary`, which now nests each customer's products and
toll/own split — `SUMMARY_VERSION` bumps force a one-time re-backfill).

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

- **Toll** — we processed a customer's own meat for a fee. A line is toll when it bills a
  **toll-arrangement customer** (`…-TOLL`, Gourmet, Diestel) *or* its batch had ≈ $0
  input cost **and the item has no ordinary sale** (a low-input batch that *does* have a
  regular sale is treated as own, not toll). Revenue = **toll rate × lbs**, resolved
  **live → manual → contract → sale price**: the most recent toll-customer sale; else a
  hand-typed rate; else the contract table in `backend/tollRates.js`; else the item's
  actual sale price (labeled "no toll rate") so the line is never a phantom $0 and a
  Toll/Own flip never blanks. Only items with *no* sale anywhere and no production value
  stay $0.
- **Own** — we own the meat. Revenue = the item's **most recent actual sale price**
  (CMP-tier, from `sales_order_lines`, same source as the Product Value tab) × lbs,
  falling back to the production module's sell value only when there's no recent sale;
  cost = its **input (raw-material) cost**. (The production sell value is often a flat
  standard — e.g. 661922 is stamped $1.00/lb on every batch — so the real last sale
  price is far more accurate. A note shows how many own lines used a real sale vs the
  fallback.)

Gross profit = revenue − cost; minus a manually-entered **labor** figure (kept in the
browser) = **net contribution**. Results roll up by **production room** and by
**customer**, with a line-by-line **Batch Detail** view.

All of it comes live from Swarmbox (`production_output_cost` for the day's lines,
`sales_order_lines` for each toll item's latest billed rate) — one quick set of calls,
no minutes-long sweep. A toll line's rate is resolved **live → manual → contract → sale price**: the most recent
sale to a toll account (`…-TOLL`, Gourmet, Diestel) wins; then a **manual rate** you typed
in; then the contract table in `tollRates.js`; then the item's actual sale price (so the
line never shows a false $0 and a Toll/Own flip keeps a number). A small note shows the
live/manual/contract/sale-price/no-rate split.

The rare item with no rate at all shows $0 and is flagged — in **Batch Detail** those
lines have an inline **$/lb box**: type a rate and it's saved (`data/toll-rates.json`,
gitignored) and applied to that item everywhere. It's a fallback only — if a real toll
sale later appears, the live price automatically takes over. Clear the box to remove it.

**See how a line's numbers were derived — 🔎 explainer.** Every Batch Detail line has a
**🔎** that opens a per-line breakdown: for the **customer**, **Toll/Own**, and **rate**
it shows the full decision chain — every candidate that was considered, with the one that
won checked — then the arithmetic behind revenue/cost/GP. So you can see exactly where a
number came from (e.g. "customer Miami from the Product Specs sheet; rate $1.50/lb from a
real Miami sale, not the $0.75/lb production standard") and fix anything wrong with the
customer/type/rate controls built into the same panel. Each row carries a `trace` object
(`backend/production.js`) holding those candidates.

**Chained-batch re-costing — WIP blended-average dilution.** Swarmbox costs a
batch's *draw* of an item at that item's **blended average**, not at the cost of the
batch that actually produced it. When one WIP code pools customer-supplied ($0) and
company-owned meat — e.g. 060269 Mishima ground beef on 2026-07-15: once from
CMP-owned trim at $4.71/lb, three times from Mishima's own $0 trim — every packaging
batch draws it at the diluted average ($0.47/lb), the real cost leaks onto the toll
chains (whose input cost the report zeroes anyway), and own-product GP is overstated
(~$3.3k that day). The report undoes this: a draw whose pounds match a **sibling
batch's same-day output** of the same item (within 1%) is re-costed at that batch's
**actual output cost**, and the consuming batch's lines are re-scaled the way
Swarmbox itself allocates (by value, off its original split). Anything ambiguous —
no pounds match, competing producers at different $/lb, a partial draw — **keeps the
blended number**: mis-attributing cost is worse than averaging it. Re-costed lines
say so in the 🔎 explainer (both numbers shown, with the producing batch), and the
day header counts the re-costed batches.

**Repack / boxing batches create no value.** A batch whose input is (≈)entirely the
**same item** it outputs, pounds in ≈ pounds out, and where **no sibling batch made
that item the same day** (that guard is what protects the tail of a cutting→packaging
chain, whose line carries the chain's real revenue), is a repack (one case broken into
two) or a boxing run (bulk boxed for later use). Swarmbox still stamps the output with
a sell value, so these used to show phantom GP (+$70 for splitting a bacon case; a fake
−$8.4k on a cooker-trim boxing run). They're treated as internal: input cost only,
excluded from margin — the real margin appears when the item actually ships or cooks.

**Toll vs Own is also overridable.** The Type column in Batch Detail is an
**Auto / Toll / Own** selector: "Auto" uses the automatic rule (and shows what it
decided, e.g. "Auto (Own)"), or pick Toll/Own to force an item either way. Overrides
are per-item, saved to `data/class-overrides.json` (gitignored), and the report
recomputes on change. This is how you settle items the rule can't (e.g. JD Food).

**Customer attribution — authoritative spec sheet, then a text guess.** A line's
customer is resolved in this order: a **manual transfer** (below) wins; then the
**spec-sheet customer** — an authoritative per-code owner from the Product Specs export
(`reference/item-specs.json`, see below); then a **text guess** from the batch **notes**,
then the product **description** (`backend/tollRates.js` `parseCustomer`). Named accounts
(Mishima, Eel River, Mariposa, Miami, Hewitt, GFF…) are recognized wherever they're
written, and a `CMP` token in a description is JD Food's own brand. There is **no real
"CMP" customer** — anything unidentified is JD Food's own in-house production.

**Transfer an item.** When attribution is still wrong, the **Customer** column in Batch
Detail is a dropdown: pick a customer to **transfer that item** there. Transfers are
per-item, saved to `data/customer-overrides.json` (gitignored), and flow everywhere —
the report, the stored daily summaries, the Owner's Dashboard, and the Customers tab
(they all roll up on one `customer` field).

### Product Specs reference data

`reference/item-specs.json` is an **authoritative per-item-code customer** table (plus
species / production channel) extracted from the "Product Specs Data.xlsx" export. It
covers finished goods (≈2,200 codes, 55 customers) and is the second link in the
attribution chain above — beating the heuristic guess, losing only to a manual transfer.
It's a **committed** file (not under the gitignored `data/`), so it deploys with the
code. Regenerate it when the spreadsheet changes and commit the result:

```bash
python scripts/import-item-specs.py "C:/path/to/Product Specs Data.xlsx"
```

The sheet's long names ("MISHIMA RESERVE", "GILLUM FAMILY FARMS") are canonicalized to
the app's short names ("Mishima", "GFF") at load by an `ALIAS` map in
`backend/itemSpecs.js`; unmapped names become their own Title-Cased account (edit `ALIAS`
to fold any of them into an existing customer). Changing the dataset bumps an internal
fingerprint that marks stored daily summaries stale, so the Dashboard/Customers tab
recompute automatically.

## Prices Today tab

A second pricing view (`/prices.html`) listing **every item produced that day and the
$/lb the report is using for it**, with where that number came from (live toll sale,
real own sale, contract, manual, production value…). Two corrections live here:

- **Forced price.** If Swarmbox is pulling the **wrong** number, type the correct
  `$/lb`. Unlike a manual rate (a fallback that loses to a real sale), a forced price
  **wins over everything** — live, own, sale, contract, standard — until you clear it.
- **⚑ Wrong-source flag.** Flag a line as "pulling from the wrong area." Flagging
  snapshots **what it was pulling** (basis + source) and an optional note, so the line
  shows up under **Needs review** until you track down the correct Swarmbox source and
  clear it. The flag is independent of the forced price — flag without a number when you
  know it's wrong but don't yet have the right value.

Forced prices and flags are per-item, saved to `data/price-overrides.json` (gitignored).
Changing any override (price, class, customer) rebuilds the recent daily summaries in the
background, so the Dashboard and Customers tab catch up without a manual refresh.

## Password gate

The margin data is company-sensitive, so the whole app sits behind one shared
password — **every page and every `/api/*` route**, not just the HTML (the
sensitive part is the JSON; gating only the pixels would leave the money one
curl away). Set `APP_PASSWORD` in `.env` (gitignored — the password never ships
in code) and the login screen (`/login.html`) fronts everything; a successful
login sets an HttpOnly session cookie (12h sliding). Sessions are in-memory, so
a pm2 restart logs everyone out — you just type the password again. Leaving
`APP_PASSWORD` unset turns the gate **off** (with a loud boot warning), so a
missing line degrades to open rather than locking everyone out.

**API key (machine channel).** Setting `API_KEY` in `.env` opens one narrow,
password-free lane through the gate: a request bearing the header
`X-Api-Key: <key>` may **GET any `/api/*` route** and **POST
`/api/questions/:id/answer`** — nothing else. No deletes, no question
creation, no override/rate edits, no pages; those still need a human login.
It exists so a local agent or script can read the numbers and work the
Questions queue without ever holding the shared password. Wrong keys get the
same slowed 401 as wrong passwords and can't tell whether the channel is even
enabled.

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
| `GET /api/values/overrides` | Manual value-overrides (`{ overrides: [{ code, cmpManual, cmpUom, cmpUse, jdManual, jdUom, jdUse, note, updatedAt }] }`). |
| `POST /api/values/overrides` | Set/merge a manual value-override (`{ code, cmpManual?, cmpUom?, cmpUse?, jdManual?, jdUom?, jdUse?, note? }`; `*Use` = `manual`\|`swarmbox`; only fields sent change). Applied to the live table immediately. |
| `DELETE /api/values/overrides/:code` | Clear an item's manual value-override. |
| `GET /api/production` | Margin report for the most recent production day. `?date=YYYY-MM-DD` for a specific day; `?refresh=1` to rebuild. |
| `GET /api/production/dates` | Recent production days (newest first) with batch counts — drives the day picker. |
| `GET /api/production/export.csv?date=…` | The day's batch-detail lines as a CSV download. |
| `GET /api/production/rates` | Manual per-item toll rates (`{ rates: [{ code, rate, note, updatedAt }] }`). |
| `POST /api/production/rates` | Set a manual toll rate (`{ code, rate, note }`); used only where there's no live/contract rate. |
| `DELETE /api/production/rates/:code` | Remove a manual toll rate. |
| `GET /api/production/overrides` | Manual Toll/Own classifications (`{ overrides: [{ code, mode, updatedAt }] }`). |
| `POST /api/production/overrides` | Force an item Toll or Own (`{ code, mode }`, mode = `toll`\|`own`). |
| `DELETE /api/production/overrides/:code` | Revert an item to automatic classification. |
| `GET /api/production/customer-overrides` | Manual item→customer transfers (`{ overrides: [{ code, customer, updatedAt }] }`). |
| `POST /api/production/customer-overrides` | Transfer an item to a customer (`{ code, customer }`). |
| `DELETE /api/production/customer-overrides/:code` | Revert an item to its auto-detected customer. |
| `GET /api/production/known-customers` | Canonical customer list for the transfer dropdown. |
| `GET /api/production/price-overrides` | Forced prices / flagged lines (`{ overrides: [{ code, rate, flagged, wrongBasis, wrongSource, note, updatedAt }] }`). |
| `POST /api/production/price-overrides` | Set a forced price and/or flag a line (`{ code, rate?, flagged?, wrongBasis?, wrongSource?, note? }`; only fields sent are changed). |
| `DELETE /api/production/price-overrides/:code` | Clear a forced price + flag. |
| `GET /api/dashboard?days=7\|14\|30` | Period margin rollup for the Owner's Dashboard: daily GP series, totals, top/bottom customers & products. |
| `GET /api/customers?days=7\|14\|30` | Customer scorecard: every customer ranked by GP with toll/own split, trend vs the prior period, and per-customer products + daily series. |
| `GET /api/discontinued` | The discontinued list (`{ rows: [{ code, description, addedAt }] }`). |
| `POST /api/discontinued` | Discontinue one item (`{ code, description }`); drops it from the live cache immediately. |
| `POST /api/discontinued/bulk-unsold` | Discontinue every item with no sale in either tier. |
| `DELETE /api/discontinued/:code` | Restore an item (reappears on the next value-table rebuild). |

## When Swarmbox misbehaves

Swarmbox is intermittently flaky (some production days just return a 400 forever).
Two rules keep that from turning into either a wrong number or a request storm:

**A failure is not a "split".** The catalog sweep subdivides a code prefix into ten
finer ones when the slice is genuinely too big — and *only* then (an oversized result,
or a timeout, which can mean the same thing). Any other failure is **retried in place**
with backoff. Treating a plain error as "too big" is what turns one bad prefix into
10 → 100 → 1,000 → 10,000 calls against an API that is already struggling; a whole-API
outage could reach ~1.1M calls, and every extra call makes the outage worse. The same
rule applies to the pricing batches. `CATALOG_CALL_BUDGET` caps a sweep regardless, and
a process-wide **circuit breaker** pauses *all* Swarmbox calls after `SWARMBOX_BREAKER_FAILS`
consecutive failures.

**A day's numbers are all-or-nothing.** A production day is only stored if *every* input
behind its money came back — the output fetch **and** the sales fetch. The sales map does
not merely decorate the report, it drives it: classification reads toll/own from it and the
rate falls out of it. A silently-dropped sales chunk flips toll lines to Own (un-zeroing
their input cost) and drops own lines back to the flat production standard, producing a
normal-looking report full of wrong money. So a day that can't be fully read is **excluded
and labelled**, never persisted as a $0 or a phantom loss. Failed days back off
(5m → 15m → 30m → 1h → 4h) instead of being retried forever, and the Dashboard says how
many days are missing rather than quietly averaging over the hole.

Likewise, a **degraded sweep never overwrites a good price table** — a partial catalog
would silently delete real products — and an item whose price lookup failed keeps its last
known price instead of being blanked, because "we couldn't ask" is not "no recent sale".

**Background work never starves a page.** Swarmbox calls are split into two classes.
Foreground (someone is waiting on it — a page load) may use every slot and is served
first. Background (the sweep, the price build, the summary backfill) is capped at
`SWARMBOX_CONCURRENCY - SWARMBOX_RESERVED_SLOTS`, so at least one slot is always free for
a user request. Without this, the sweep's ~120 simultaneous calls take the whole pool and
a page needing one fresh call (e.g. Production Margin's date list) queues behind the
entire multi-minute rebuild and just spins.

## Configuration (`.env`)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3004` | HTTP port. |
| `APP_PASSWORD` | *(unset — gate off)* | Shared password in front of every page and API route. |
| `API_KEY` | *(unset — channel off)* | `X-Api-Key` header auth: `/api/*` reads + question answers only. |
| `SESSION_TTL_MS` | `43200000` | Login session lifetime (12h, sliding). |
| `SWARMBOX_BASE_URL` | `https://jdfood.swarmbox.com:443/pg-api` | Swarmbox REST base. |
| `SWARMBOX_TIMEOUT_MS` | `30000` | Per-request timeout. |
| `SWARMBOX_CONCURRENCY` | `4` | Process-wide cap on parallel Swarmbox calls. |
| `SWARMBOX_RESERVED_SLOTS` | `1` | Slots held back for user-facing calls, so a background rebuild can't starve a page. |
| `SWARMBOX_BREAKER_FAILS` | `40` | Consecutive failures before *all* calls pause (`SWARMBOX_BREAKER=off` to disable). |
| `SWARMBOX_BREAKER_COOLDOWN_MS` | `60000` | How long the circuit stays open. |
| `VALUE_LOOKBACK_DAYS` | `360` | Sales window for "last price" (max 360). |
| `VALUE_CACHE_TTL_MS` | `21600000` | How long a built table is reused (6h). |
| `CATALOG_ROW_BUDGET` | `50000` | Subdivide a wildcard prefix above this many rows. |
| `CATALOG_ATTEMPTS` | `3` | Tries per prefix before the slice is written off (timeouts are split, not retried). |
| `CATALOG_CALL_BUDGET` | `300` | Hard ceiling on Swarmbox calls per sweep — abort rather than storm. |
| `PRODUCTION_CACHE_TTL_MS` | `300000` | How long a built day's margin report is reused (5m). |
| `PRODUCTION_MAX_DAY_ATTEMPTS` | `6` | Give up rebuilding a broken day after this many failures. |
