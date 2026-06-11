require('dotenv').config();

const express = require('express');
const path = require('path');

const { getValues } = require('./backend/valuation');
const { getProductionReport, backfillSummaries } = require('./backend/production');

const app = express();
app.use(express.json({ limit: '256kb' }));

app.use('/api/values', require('./backend/routes/values'));
app.use('/api/production', require('./backend/routes/production'));
app.use('/api/discontinued', require('./backend/routes/discontinued'));
app.use('/api/dashboard', require('./backend/routes/dashboard'));

const PUBLIC_DIR = path.join(__dirname, 'public');
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});
app.use(express.static(PUBLIC_DIR));

// Schedule the daily price refresh (default 5 AM, VM local time). Reschedules
// itself each day. The build runs in the background, so no user ever waits on it.
const REFRESH_HOUR = Number(process.env.VALUE_REFRESH_HOUR);
function scheduleDailyRefresh() {
  const hour = Number.isFinite(REFRESH_HOUR) ? REFRESH_HOUR : 5;
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const ms = next.getTime() - now.getTime();
  console.log(`[ValueTool] next daily price refresh at ${next.toLocaleString()} (~${Math.round(ms / 3.6e6)}h)`);
  setTimeout(() => {
    getValues({ force: true })
      .then((c) => console.log(`[ValueTool] daily refresh done: ${c.itemCount} items`))
      .catch((err) => console.error('[ValueTool] daily refresh failed:', err && err.message))
      .finally(scheduleDailyRefresh);
  }, ms);
}

const PORT = Number(process.env.PORT) || 3004;
app.listen(PORT, () => {
  console.log(`[ValueTool] Product Value report on http://localhost:${PORT}`);

  // Warm the cache on boot so the first page load is instant. With a saved
  // snapshot this returns immediately and refreshes in the background.
  getValues({})
    .then((c) => console.log(`[ValueTool] cache ready: ${c.itemCount} items (${c.pricedJd} JD-priced, ${c.pricedCmp} CMP-priced)`))
    .catch((err) => console.error('[ValueTool] warm-up failed (will build on first request):', err && err.message));

  // Warm the most-recent production day too (cheap — one day is a single call),
  // then backfill the Owner's Dashboard history (last 30 production days) in the
  // background so the dashboard loads instantly with real trends.
  getProductionReport({})
    .then((p) => {
      console.log(`[ValueTool] production warmed: ${p.date} (${p.rows.length} lines)`);
      return backfillSummaries(30);
    })
    .then((b) => { if (b) console.log(`[ValueTool] dashboard history ready (${b.filled} day(s) backfilled)`); })
    .catch((err) => console.error('[ValueTool] production warm-up failed (will build on first request):', err && err.message));

  scheduleDailyRefresh();
});
