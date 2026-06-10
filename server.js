require('dotenv').config();

const express = require('express');
const path = require('path');

const { getValues } = require('./backend/valuation');
const { getProductionReport } = require('./backend/production');

const app = express();
app.use(express.json({ limit: '256kb' }));

app.use('/api/values', require('./backend/routes/values'));
app.use('/api/production', require('./backend/routes/production'));

const PUBLIC_DIR = path.join(__dirname, 'public');
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});
app.use(express.static(PUBLIC_DIR));

const PORT = Number(process.env.PORT) || 3004;
app.listen(PORT, () => {
  console.log(`[ValueTool] Product Value report on http://localhost:${PORT}`);

  // Warm the cache on boot so the first page load is instant. Fire-and-forget —
  // a Swarmbox hiccup here just means the first request builds it lazily instead.
  getValues({})
    .then((c) => console.log(`[ValueTool] cache warmed: ${c.itemCount} items (${c.pricedJd} JD-priced, ${c.pricedCmp} CMP-priced)`))
    .catch((err) => console.error('[ValueTool] warm-up failed (will build on first request):', err && err.message));

  // Warm the most-recent production day too (cheap — one day is a single call).
  getProductionReport({})
    .then((p) => console.log(`[ValueTool] production warmed: ${p.date} (${p.rows.length} lines)`))
    .catch((err) => console.error('[ValueTool] production warm-up failed (will build on first request):', err && err.message));
});
