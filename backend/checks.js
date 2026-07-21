// checks.js — production "sanity check" / data-quality flags from Swarmbox.
//
// The Production Margin tab trusts Swarmbox's batch numbers. This module does the
// opposite: it looks for batches whose numbers can't physically be true, so a bad
// record gets caught before anyone reports off it.
//
// Everything here is pure arithmetic on data the app already pulls:
//   - production_batch_summary  → per batch: input/wip/output/loss quantities,
//                                 yield_pct, process, room, line, notes.
//   - production_input_cost     → per batch: the items consumed (item, lbs, UOM).
//   - production_output_cost    → per batch: the items produced.
//
// IMPORTANT — the "assumed lbs" caveat. Swarmbox's own docs say batch_summary's
// quantities/yield are "assumed lbs". But some line items are costed in EA/CS, not
// LB, and the summary sums them as if they were pounds. A batch that mixes units
// therefore has a meaningless yield (we saw grinds show a phantom 101–104% gain
// purely because a seasoning was counted in eaches). So we detect mixed-UOM
// batches from the line RPCs and DON'T raise weight/yield flags on them — we note
// the unit mix instead. The headline checks only fire on all-LB batches.
//
// Read-only; never throws — routes get { ... } or a graceful empty.

const { postRpc } = require('./swarmbox');
const { recentDates, mostRecentDate } = require('./production');
const checkFeedback = require('./checkFeedback');

// ── Diagnostic questions (one per rule) ──────────────────────────────────────
// A flag says "this can't be true"; only a person knows WHY. For each rule we ask
// one question with the likely causes, so the answers reveal the upstream fix.
// The frontend renders these; the answer text is validated loosely (free "Other"
// is allowed via the note), so adding/editing an option here needs no UI change.
const QUESTIONS = {
  'weight-gain': {
    q: 'Output weighs more than input — what happened?',
    options: ['Missed / under-scanned an input', 'Output double-counted', 'Wrong unit (case/each entered as lbs)', 'Something really was added (correct)', 'Not sure'],
  },
  'low-yield': {
    q: 'Yield looks too low — why?',
    options: ['Missed an output scan', 'Heavy trim/fat loss is normal here', 'Cooking / render loss (expected)', 'Mis-entry', 'Not sure'],
  },
  'no-output': {
    q: 'Material was consumed but no output recorded — why?',
    options: ['Output not scanned yet', 'Scanned to the wrong batch', 'Batch cancelled', 'Not sure'],
  },
  'output-no-input': {
    q: 'Output recorded but no input — why?',
    options: ['Input not scanned yet', 'Customer-supplied meat (toll)', 'Scanned to the wrong batch', 'Not sure'],
  },
  'item-both-sides': {
    q: 'Same item is on both the input and output side — is that right?',
    options: ['Yes — re-grade / partial (correct)', 'No — mis-entry', 'Not sure'],
  },
  'mixed-uom': {
    q: 'This batch mixes pounds with case/each units — is that expected?',
    options: ['Expected (seasoning / packaging in EA/CS)', 'Should all be in pounds', 'Not sure'],
  },
  'empty-batch': {
    q: 'Batch has no quantities — why?',
    options: ['Cancelled', 'Not started yet', 'Test / duplicate', 'Not sure'],
  },
};

const TTL_MS = Number(process.env.CHECKS_CACHE_TTL_MS) || 5 * 60 * 1000; // 5 min
const RANGE_DAYS = Number(process.env.CHECKS_RANGE_DAYS) || 30;

// ── Tunable thresholds ───────────────────────────────────────────────────────
// A gain is "output + wip exceeded input" — the batch made MORE weight than it
// consumed. A tiny gain is rounding/scale slop; only flag past a floor.
const GAIN_ABS_LB = Number(process.env.CHECKS_GAIN_ABS_LB) || 2;     // ignore gains under this many lbs
const GAIN_PCT = Number(process.env.CHECKS_GAIN_PCT) || 0.01;        // …or under this fraction of input
const GAIN_PCT_NEUTRAL = 0.03;                                       // non-cutting needs a bigger gain to flag
const GAIN_ABS_NEUTRAL = 25;
const LOW_YIELD = Number(process.env.CHECKS_LOW_YIELD) || 40;        // yield% below this ⇒ probably a missed output scan
const SEVERITY_RANK = { high: 3, medium: 2, low: 1, info: 0 };
const RTE_ROOM = 'R.R.TE.000';                                      // Ready-To-Eat room — cooking loss is expected here

const num = (v) => (v == null ? 0 : Number(v) || 0);
const isLb = (uom) => String(uom || 'LB').toUpperCase() === 'LB';

// ── Process classification ───────────────────────────────────────────────────
// Subtractive processes can only LOSE weight (you remove bone/fat/trim) — any gain
// is a data error. "Gain-OK" legitimately adds weight (water, marinade, breading).
// "Loss-OK" legitimately loses a lot (cooking/rendering boils weight off) — so a
// low yield there is normal, not a flag. Everything else is neutral.
// NOTE: match on STEMS so the "-ing" forms hit too (Tumbling/Dicing/Slicing).
const GAIN_OK = /MARINAT|INJECT|TUMBL|BRINE|SEASON|BREAD|GLAZE|SOAK|PICKL|\bRUB\b|SAUC|WATER/i;
const LOSS_OK = /RENDER|COOK|SMOK|ROAST|DEHYDRAT|BAKE|\bFRY\b|\bDRY|CURE/i;
const SUBTRACTIVE = /CUT|GRIND|TRIM|BONE|PORTION|\bSAW\b|CHOP|PEEL|BREAK|FAB|DIC|SLIC/i;
function classifyProcess(process) {
  const p = String(process || '');
  if (GAIN_OK.test(p)) return 'gain_ok';       // first: a "seasoned grind" counts as gain-ok
  if (LOSS_OK.test(p)) return 'loss_ok';
  if (SUBTRACTIVE.test(p)) return 'subtractive';
  return 'neutral';
}

// TODAY, in LOCAL calendar terms. Used only to tell "the shift is still running"
// from "the day is closed". toISOString() would roll over to tomorrow every
// afternoon (5pm Pacific = next day UTC) and make a finished day look open.
function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Rule engine (per batch) ──────────────────────────────────────────────────
// b: a batch_summary row. opts.mixedUom: batch mixes non-LB units (yield not
// comparable). opts.dayInProgress: this batch's day is still being worked, so
// "nothing recorded yet" is normal and not flagged. Pure — no I/O.
// Returns { flags, ...computed }.
function batchFlags(b, opts = {}) {
  const input = num(b.input_quantity);
  const wip = num(b.wip_quantity);
  const output = num(b.output_quantity);
  const yieldPct = b.yield_pct == null ? null : Number(b.yield_pct);
  const procClass = classifyProcess(b.production_process);
  const isRte = b.production_room === RTE_ROOM;
  const lossExpected = procClass === 'loss_ok' || isRte; // cooking/rendering → low yield is normal
  const gain = output + wip - input; // >0 ⇒ made more than consumed (negative loss)
  const mixedUom = !!opts.mixedUom;
  const flags = [];

  // When units are mixed, the summary's lbs are nonsense — note it and SKIP every
  // weight/yield check (they'd be false). Other checks (no output, empty) still run.
  if (mixedUom) {
    flags.push({
      rule: 'mixed-uom',
      severity: 'info',
      message: `Batch mixes pounds with case/each units, so Swarmbox's yield (${yieldPct != null ? yieldPct.toFixed(1) + '%' : '—'}) isn't a true weight balance — can't reliably check gain/loss here.`,
    });
  }

  // Rule A — made more than consumed (the 116%-yield case). LB-only.
  if (!mixedUom && gain > 0) {
    if ((procClass === 'subtractive' || procClass === 'loss_ok') && gain > Math.max(GAIN_ABS_LB, input * GAIN_PCT)) {
      flags.push({
        rule: 'weight-gain',
        severity: 'high',
        message: `Output exceeds input by ${Math.round(gain).toLocaleString()} lbs (yield ${yieldPct != null ? yieldPct.toFixed(1) + '%' : '—'}) on a ${b.production_process || 'cut/cook'} process — it can only lose weight, never gain it. Likely a missed input scan, a double-counted output, or a UOM mix-up.`,
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

  // Rule B — consumed material but recorded ZERO output (real gap, even for cooking).
  if (input > 0 && output === 0 && wip === 0) {
    flags.push({
      rule: 'no-output',
      severity: 'medium',
      message: `Consumed ${Math.round(input).toLocaleString()} lbs but recorded no output at all — the produced item is missing from the batch.`,
    });
  }

  // Rule C — output produced from nothing.
  if (output > 0 && input === 0) {
    flags.push({
      rule: 'output-no-input',
      severity: 'medium',
      message: `Produced ${Math.round(output).toLocaleString()} lbs with zero input recorded — the consumed material is missing from the batch.`,
    });
  }

  // Rule D — very low yield (most of the weight vanished). LB-only, and NOT for
  // cooking/rendering/RTE where heavy loss is expected.
  if (!mixedUom && !lossExpected && input > 0 && output > 0 && yieldPct != null && yieldPct < LOW_YIELD) {
    flags.push({
      rule: 'low-yield',
      severity: 'medium',
      message: `Yield only ${yieldPct.toFixed(1)}% — ${Math.round(input - output - wip).toLocaleString()} lbs of ${Math.round(input).toLocaleString()} unaccounted for. Real loss is usually far smaller; an output scan may be missing.`,
    });
  }

  // Rule E — no usable quantities at all.
  //
  // NOT flagged while the day is still running. An open batch with nothing on it
  // yet is just work in progress: on 2026-07-21 mid-shift, 60 of 116 batches were
  // empty, against 0–2 per day on every completed day that week. Flagging those
  // buried the handful that matter under noise that resolves itself by morning.
  // On a CLOSED day it's real but harmless — a batch opened and never used (a job
  // that didn't run, or a duplicate of the batch that did). It carries no pounds
  // and no cost, so it cannot move margin; hence "info".
  if (input === 0 && output === 0 && wip === 0 && !opts.dayInProgress) {
    flags.push({
      rule: 'empty-batch',
      severity: 'info',
      message: `Opened but never used — no input, output, or WIP was ever recorded on it. No effect on margin (it carries no pounds and no cost); usually a job that didn't run, or a duplicate of the batch that did.`,
    });
  }

  return { flags, input, wip, output, yieldPct, gain, procClass, mixedUom, isRte };
}

function topSeverity(flags) {
  let top = null;
  for (const f of flags) if (!top || SEVERITY_RANK[f.severity] > SEVERITY_RANK[top]) top = f.severity;
  return top;
}

// Build the set of batches that mix non-LB units, from line rows (input + output).
function mixedUomSet(...rowSets) {
  const lbOnly = new Map(); // batch -> stays true only if every line is LB
  for (const rows of rowSets) {
    if (!rows) continue;
    for (const r of rows) {
      const ok = isLb(r.value_uom);
      lbOnly.set(r.batch, (lbOnly.has(r.batch) ? lbOnly.get(r.batch) : true) && ok);
    }
  }
  const mixed = new Set();
  for (const [batch, allLb] of lbOnly) if (!allLb) mixed.add(batch);
  return mixed;
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

  const inByBatch = new Map();
  const outByBatch = new Map();
  const collect = (res, map) => {
    if (!res.ok) return;
    for (const r of res.data) {
      const arr = map.get(r.batch) || [];
      arr.push({ item: r.item, description: r.description || '', designation: r.product_designation || '', lbs: num(r.cost_quantity), uom: r.value_uom || '', cs: num(r.base_quantity) });
      map.set(r.batch, arr);
    }
  };
  collect(inRes, inByBatch);
  collect(outRes, outByBatch);
  const mixed = mixedUomSet(inRes.ok ? inRes.data : [], outRes.ok ? outRes.data : []);

  const summaries = sumRes.ok ? sumRes.data : [];
  const flagged = [];
  let scanned = 0;
  const counts = { high: 0, medium: 0, low: 0, info: 0, batches: 0 };
  // Is this day still being worked? If so, empty batches are open work, not
  // errors — we don't flag them, but we DO report how many, so "not flagged"
  // never reads as "not there".
  const dayInProgress = day === todayYmd();
  let openBatches = 0;

  for (const b of summaries) {
    scanned++;
    const isMixed = mixed.has(b.batch);
    if (dayInProgress && !num(b.input_quantity) && !num(b.output_quantity) && !num(b.wip_quantity)) openBatches++;
    const { flags, input, wip, output, yieldPct, gain, procClass } = batchFlags(b, { mixedUom: isMixed, dayInProgress });

    // Rule F — same item appears on BOTH the input and output side of the batch.
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
    // Stitch the diagnostic question + any saved human answer onto each flag.
    const answers = checkFeedback.forBatch(b.batch);
    for (const fl of flags) {
      fl.question = QUESTIONS[fl.rule] || null;
      const a = answers[fl.rule];
      fl.feedback = a
        ? { answer: a.answer, note: a.note, by: a.by, at: a.updatedAt, reply: a.reply, replyBy: a.replyBy, repliedAt: a.repliedAt }
        : null;
    }
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
      input, wip, output, yieldPct, gain, procClass, mixedUom: isMixed,
      topSeverity: sev,
      flags,
      inputs: ins,
      outputs: outs,
    });
  }

  flagged.sort((a, b) => SEVERITY_RANK[b.topSeverity] - SEVERITY_RANK[a.topSeverity] || b.gain - a.gain);

  const result = { date: day, scanned, counts, flagged, dayInProgress, openBatches, unavailable: !sumRes.ok, builtAt: Date.now() };
  dayCache.set(day, { result, builtAt: Date.now() });
  console.log(`[Checks] ${day}: scanned ${scanned} batches, ${counts.batches} flagged (${counts.high} high, ${counts.medium} med, ${counts.low} low, ${counts.info} info; ${mixed.size} mixed-UOM${dayInProgress ? `; day still running — ${openBatches} open batch(es) not flagged` : ''})`);
  return result;
}

// ── Range view ───────────────────────────────────────────────────────────────
// Three Swarmbox calls for the whole window (summary + the two cost RPCs, all
// bounded to ≤100 days). The cost RPCs are only used to detect mixed-UOM batches
// so the window's gain/yield counts exclude the false unit-mix positives.
let rangeCache = null; // { days, result, builtAt }

async function getRangeChecks({ days = RANGE_DAYS, force = false } = {}) {
  if (!force && rangeCache && rangeCache.days === days && Date.now() - rangeCache.builtAt < TTL_MS) return rangeCache.result;

  const list = (await recentDates()).slice(0, days);
  if (!list.length) return { days: [], totals: { batches: 0, flagged: 0, high: 0, medium: 0 }, builtAt: Date.now() };
  const start = list[list.length - 1].date;
  const end = list[0].date;
  const [sumRes, inRes, outRes] = await Promise.all([
    postRpc('production_batch_summary', { p_start_date: start, p_end_date: end }),
    postRpc('production_input_cost', { p_start_date: start, p_end_date: end }),
    postRpc('production_output_cost', { p_start_date: start, p_end_date: end }),
  ]);
  const mixed = mixedUomSet(inRes.ok ? inRes.data : [], outRes.ok ? outRes.data : []);

  const byDay = new Map();
  for (const d of list) byDay.set(d.date, { date: d.date, batches: d.batches, high: 0, medium: 0, low: 0, info: 0, flagged: 0 });
  // "flagged" = actionable (high+medium+low). info-only batches (mixed-UOM / empty)
  // are tracked separately so the headline isn't inflated by informational notes.
  const totals = { batches: 0, flagged: 0, high: 0, medium: 0, low: 0, info: 0, mixedUom: mixed.size };

  if (sumRes.ok) for (const b of sumRes.data) {
    const d = String(b.production_date || '').slice(0, 10);
    const row = byDay.get(d);
    if (!row) continue;
    // no same-item check in range; today's open batches aren't errors (see Rule E)
    const { flags } = batchFlags(b, { mixedUom: mixed.has(b.batch), dayInProgress: d === todayYmd() });
    if (!flags.length) continue;
    const sev = topSeverity(flags);
    row[sev]++;
    row.flagged++;
  }

  const daysOut = [...byDay.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  for (const r of daysOut) {
    totals.high += r.high;
    totals.medium += r.medium;
    totals.low += r.low;
    totals.info += r.info;
    totals.flagged += r.high + r.medium + r.low; // actionable only
    totals.batches += r.batches;
  }

  const result = { days: daysOut, totals, unavailable: !sumRes.ok, builtAt: Date.now() };
  rangeCache = { days, result, builtAt: Date.now() };
  return result;
}

function clearCache() { dayCache.clear(); rangeCache = null; }

module.exports = { getDayChecks, getRangeChecks, clearCache, batchFlags, classifyProcess, mixedUomSet, QUESTIONS };
