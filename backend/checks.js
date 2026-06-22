// checks.js — production "sanity check" / data-quality flags from Swarmbox.
//
// The Production Margin tab trusts Swarmbox's batch numbers. This module does the
// opposite: it looks for batches whose numbers can't physically be true, so a bad
// record gets caught before anyone reports off it.
//
// Everything here is pure arithmetic on data the app already pulls:
//   - production_batch_summary  → per batch: input/wip/output/loss quantities,
//                                 yield_pct, process, room, line, notes.
//   - production_input_cost     → per batch: the items consumed (raw + in-process).
//   - production_output_cost    → per batch: the items produced.
//
// The headline checks (gain / yield / output-from-nothing) come from ONE cheap
// batch_summary call, so the "last N days" range scan is a single Swarmbox round
// trip. The line-level check (same item in AND out) needs the two cost RPCs and
// only runs for the day view. Read-only; never throws — routes get { ... } or a
// graceful empty.

const { postRpc } = require('./swarmbox');
const { recentDates, mostRecentDate } = require('./production');

const TTL_MS = Number(process.env.CHECKS_CACHE_TTL_MS) || 5 * 60 * 1000; // 5 min
const RANGE_DAYS = Number(process.env.CHECKS_RANGE_DAYS) || 30;

// ── Tunable thresholds ───────────────────────────────────────────────────────
// A gain is "output + wip exceeded input" — i.e. the batch made MORE weight than
// it consumed. A tiny gain is just rounding/scale slop; only flag past a floor.
const GAIN_ABS_LB = Number(process.env.CHECKS_GAIN_ABS_LB) || 2;     // ignore gains under this many lbs
const GAIN_PCT = Number(process.env.CHECKS_GAIN_PCT) || 0.01;        // …or under this fraction of input
const GAIN_PCT_NEUTRAL = 0.03;                                       // non-cutting needs a bigger gain to flag
const GAIN_ABS_NEUTRAL = 25;
const LOW_YIELD = Number(process.env.CHECKS_LOW_YIELD) || 40;        // yield% below this ⇒ probably a missed output scan
const SEVERITY_RANK = { high: 3, medium: 2, low: 1, info: 0 };

const num = (v) => (v == null ? 0 : Number(v) || 0);

// ── Process classification ───────────────────────────────────────────────────
// Subtractive processes can only LOSE weight (you remove bone/fat/trim). Any gain
// there is a data error. "Gain-OK" processes legitimately add weight (water,
// marinade, breading). Everything else is neutral: a small gain is noise, a big
// one is still worth a look.
const SUBTRACTIVE = /CUT|GRIND|TRIM|SLICE|DICE|BREAK|DEBONE|BONE|PORTION|\bSAW\b|CHOP|PEEL|FAB/i;
const GAIN_OK = /MARINAT|MARINADE|INJECT|TUMBLE|BRINE|SEASON|BREAD|GLAZE|SOAK|PICKLE|\bRUB\b|SAUCE|WATER/i;
function classifyProcess(process) {
  const p = String(process || '');
  if (GAIN_OK.test(p)) return 'gain_ok';       // checked first: "seasoned grind" should count as gain-ok
  if (SUBTRACTIVE.test(p)) return 'subtractive';
  return 'neutral';
}

// ── Rule engine (per batch, batch_summary only) ──────────────────────────────
// Returns a flags[] for one batch row. Pure — no I/O.
function batchFlags(b) {
  const input = num(b.input_quantity);
  const wip = num(b.wip_quantity);
  const output = num(b.output_quantity);
  const yieldPct = b.yield_pct == null ? null : Number(b.yield_pct);
  const procClass = classifyProcess(b.production_process);
  const gain = output + wip - input; // >0 ⇒ made more than consumed (negative loss)
  const flags = [];

  // Rule A — made more than consumed (the 116%-yield case).
  if (gain > 0) {
    if (procClass === 'subtractive' && gain > Math.max(GAIN_ABS_LB, input * GAIN_PCT)) {
      flags.push({
        rule: 'weight-gain',
        severity: 'high',
        message: `Output exceeds input by ${Math.round(gain).toLocaleString()} lbs (yield ${yieldPct != null ? yieldPct.toFixed(1) + '%' : '—'}) on a ${b.production_process || 'cutting'} process — a cut/grind can only lose weight, never gain it. Likely a missed input scan, a double-counted output, or a UOM mix-up.`,
      });
    } else if (procClass === 'neutral' && gain > Math.max(GAIN_ABS_NEUTRAL, input * GAIN_PCT_NEUTRAL)) {
      flags.push({
        rule: 'weight-gain',
        severity: 'medium',
        message: `Output exceeds input by ${Math.round(gain).toLocaleString()} lbs (yield ${yieldPct != null ? yieldPct.toFixed(1) + '%' : '—'}) on ${b.production_process || 'this process'}. Unless something was added, you can't make more than you put in — check the input scans.`,
      });
    }
    // gain_ok processes legitimately gain weight → no flag.
  }

  // Rule B — output from nothing.
  if (output > 0 && input === 0) {
    flags.push({
      rule: 'output-no-input',
      severity: 'medium',
      message: `Produced ${Math.round(output).toLocaleString()} lbs with zero input recorded — the consumed material is missing from the batch.`,
    });
  }

  // Rule C — very low yield (most of the weight vanished).
  if (input > 0 && yieldPct != null && yieldPct < LOW_YIELD && !(output > 0 && input === 0)) {
    flags.push({
      rule: 'low-yield',
      severity: 'medium',
      message: `Yield only ${yieldPct.toFixed(1)}% — ${Math.round(input - output - wip).toLocaleString()} lbs of ${Math.round(input).toLocaleString()} unaccounted for. Real loss is usually far smaller; an output scan may be missing.`,
    });
  }

  // Rule E — no usable quantities at all.
  if (input === 0 && output === 0 && wip === 0) {
    flags.push({
      rule: 'empty-batch',
      severity: 'info',
      message: `No input, output, or WIP quantity recorded — the batch looks empty or incomplete.`,
    });
  }

  return { flags, input, wip, output, yieldPct, gain, procClass };
}

function topSeverity(flags) {
  let top = null;
  for (const f of flags) if (!top || SEVERITY_RANK[f.severity] > SEVERITY_RANK[top]) top = f.severity;
  return top;
}

// ── Day view ─────────────────────────────────────────────────────────────────
const dayCache = new Map(); // date -> { result, builtAt }

async function getDayChecks({ date, force = false } = {}) {
  const day = date || (await mostRecentDate());
  const hit = dayCache.get(day);
  if (!force && hit && Date.now() - hit.builtAt < TTL_MS) return hit.result;

  const [sumRes, inRes, outRes] = await Promise.all([
    postRpc('production_batch_summary', { p_date: day }),
    postRpc('production_input_cost', { p_date: day }),
    postRpc('production_output_cost', { p_date: day }),
  ]);

  // Line items consumed / produced per batch → drives the "same item in & out" rule
  // and the per-batch input/output drill-down.
  const inByBatch = new Map();  // batch -> [{ item, description, designation, lbs }]
  const outByBatch = new Map();
  const collect = (res, map) => {
    if (!res.ok) return;
    for (const r of res.data) {
      const arr = map.get(r.batch) || [];
      arr.push({ item: r.item, description: r.description || '', designation: r.product_designation || '', lbs: num(r.cost_quantity), cs: num(r.base_quantity) });
      map.set(r.batch, arr);
    }
  };
  collect(inRes, inByBatch);
  collect(outRes, outByBatch);

  const summaries = sumRes.ok ? sumRes.data : [];
  const flagged = [];
  let scanned = 0;
  const counts = { high: 0, medium: 0, low: 0, info: 0, batches: 0 };

  for (const b of summaries) {
    scanned++;
    const { flags, input, wip, output, yieldPct, gain, procClass } = batchFlags(b);

    // Rule D — same item appears on BOTH the input and output side of the batch.
    const ins = inByBatch.get(b.batch) || [];
    const outs = outByBatch.get(b.batch) || [];
    const inItems = new Set(ins.map((r) => r.item));
    const both = [...new Set(outs.filter((r) => inItems.has(r.item)).map((r) => r.item))];
    if (both.length) {
      const labels = both.slice(0, 3).map((it) => {
        const d = (outs.find((r) => r.item === it) || ins.find((r) => r.item === it) || {}).description || '';
        return `${it}${d ? ' ' + d : ''}`;
      });
      flags.push({
        rule: 'item-both-sides',
        severity: 'low',
        message: `${both.length} item(s) appear as both an input and an output of this batch: ${labels.join('; ')}${both.length > 3 ? ` +${both.length - 3} more` : ''}. Usually a re-grade, but worth confirming it isn't a mis-entry.`,
      });
    }

    if (!flags.length) continue;
    const sev = topSeverity(flags);
    counts[sev]++;
    counts.batches++;
    flagged.push({
      batch: b.batch,
      date: String(b.production_date || day).slice(0, 10),
      room: b.production_room || '',
      line: b.production_line || '',
      process: b.production_process || '',
      notes: b.batch_notes || '',
      input, wip, output, yieldPct, gain, procClass,
      topSeverity: sev,
      flags,
      inputs: ins,
      outputs: outs,
    });
  }

  flagged.sort((a, b) => SEVERITY_RANK[b.topSeverity] - SEVERITY_RANK[a.topSeverity] || b.gain - a.gain);

  const result = {
    date: day,
    scanned,
    counts,
    flagged,
    unavailable: !sumRes.ok,
    builtAt: Date.now(),
  };
  dayCache.set(day, { result, builtAt: Date.now() });
  console.log(`[Checks] ${day}: scanned ${scanned} batches, ${counts.batches} flagged (${counts.high} high, ${counts.medium} med, ${counts.low} low)`);
  return result;
}

// ── Range view (cheap: one batch_summary call for the whole window) ───────────
let rangeCache = null; // { days, result, builtAt }

async function getRangeChecks({ days = RANGE_DAYS, force = false } = {}) {
  if (!force && rangeCache && rangeCache.days === days && Date.now() - rangeCache.builtAt < TTL_MS) return rangeCache.result;

  const list = (await recentDates()).slice(0, days);
  if (!list.length) return { days: [], totals: { batches: 0, flagged: 0, high: 0, medium: 0 }, builtAt: Date.now() };
  const start = list[list.length - 1].date;
  const end = list[0].date;
  const res = await postRpc('production_batch_summary', { p_start_date: start, p_end_date: end });

  const byDay = new Map(); // date -> { date, batches, high, medium, low, info, flagged }
  for (const d of list) byDay.set(d.date, { date: d.date, batches: d.batches, high: 0, medium: 0, low: 0, info: 0, flagged: 0 });
  const totals = { batches: 0, flagged: 0, high: 0, medium: 0 };

  if (res.ok) for (const b of res.data) {
    const d = String(b.production_date || '').slice(0, 10);
    const row = byDay.get(d);
    if (!row) continue;
    const { flags } = batchFlags(b); // range scan = batch_summary rules only (no line-level)
    if (!flags.length) continue;
    const sev = topSeverity(flags);
    row[sev]++;
    row.flagged++;
  }

  const daysOut = [...byDay.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  for (const r of daysOut) {
    totals.flagged += r.flagged;
    totals.high += r.high;
    totals.medium += r.medium;
    totals.batches += r.batches;
  }

  const result = { days: daysOut, totals, unavailable: !res.ok, builtAt: Date.now() };
  rangeCache = { days, result, builtAt: Date.now() };
  return result;
}

function clearCache() { dayCache.clear(); rangeCache = null; }

module.exports = { getDayChecks, getRangeChecks, clearCache, batchFlags, classifyProcess };
