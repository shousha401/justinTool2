// tollRates.js — toll-processing business rules (NOT in Swarmbox).
//
// When we process a customer's own meat for a fee, the toll rate ($/lb we
// charge) comes from contract rate tables, not from any Swarmbox field. These
// are the rates ported from the original margin prototype. Edit them here — this
// is the one file the business "owns".
//
// Rates are tiered by the item's TOTAL pounds produced that day (volume breaks),
// so tollRate(item, dayLbs) takes the day's pounds for that item, not the line's.
//
// v1 uses these contract rates only. A later phase can prefer the most recent
// real toll-customer sale price from Swarmbox (see backend/pricing.js) and fall
// back to these — that's why tollRate returns a {rate, source} it can be layered
// onto.

// ── Contract rate tables (tiered $/lb by volume) ─────────────────────────────
const mishima1LbRate      = (lbs) => (lbs >= 8000 ? 0.74 : lbs >= 4000 ? 0.78 : 0.88);
const mishimaBistroFSRate = (lbs) => (lbs >= 8000 ? 0.89 : lbs >= 4000 ? 0.92 : lbs >= 2000 ? 1.07 : 1.17);
const mishimaRetailRate   = (lbs) => (lbs >= 8000 ? 1.07 : lbs >= 4000 ? 1.10 : lbs >= 2000 ? 1.25 : 1.35);
const mishimaMRCCRate     = (lbs) => (lbs >= 2000 ? 2.75 : lbs >= 1000 ? 2.90 : 3.05);
const gourmet5LbRate      = (lbs) => (lbs >= 4000 ? 0.70 : 0.76);
const gourmetBistroRate   = () => 1.35;

function brandtRate(item, lbs) {
  const ded = lbs >= 3000 ? 0.10 : 0; // high-volume deduction
  if (item === '900916') return 1.00 - ded;
  if (['900713', '900911'].includes(item)) return 0.68;
  if (['900714', '900737', '900792'].includes(item)) return 0.85 - ded;
  if (['900715', '900659', '900666', '900716', '900728', '900752'].includes(item)) {
    if (item === '900752') return 0.95 - ded;
    if (item === '900728') return 1.35 - ded;
    return 0.85 - ded;
  }
  if (item === '900560') return 0.75 - ded;
  return null;
}

// Item families → rate table. Returns { rate, source }; rate is null when no
// contract rate is mapped for the item (surfaced as a "missing rate" warning).
function tollRate(item, dayLbs) {
  const lbs = dayLbs || 0;
  if (['060660', '060661', '665045'].includes(item)) return { rate: mishima1LbRate(lbs), source: 'Mishima 1# brick' };
  if (['060663', '060665', '060667', '060690', '665217', '665218', '665219'].includes(item)) return { rate: mishimaBistroFSRate(lbs), source: 'Mishima bistro FS' };
  if (['060669', '060668', '060692', '060691'].includes(item)) return { rate: mishimaRetailRate(lbs), source: 'Mishima retail patty' };
  if (item.startsWith('064')) return { rate: mishimaMRCCRate(lbs), source: 'MRCC steak' };
  if (item === '062258') return { rate: gourmet5LbRate(lbs), source: 'Gourmet 5# brick' };
  if (['062134', '062772'].includes(item)) return { rate: gourmetBistroRate(), source: 'Gourmet bistro patty' };
  const br = brandtRate(item, lbs);
  if (br !== null) return { rate: br, source: `Brandt contract $${br.toFixed(2)}/lb` };
  return { rate: null, source: null };
}

// Infer the customer from a line. There is NO real customer called "CMP" — it's
// the production company, and a line with no other signal is JD Food's own
// in-house production (beef/pork/chicken cutting), so it rolls up under "JD Food".
//
// The real customer is encoded in two places: the batch's free-text NOTES
// ("MISHIMA…", "Eel River 93/7", "MARIPOSA PORTION CUTTING") and, when the notes
// are just a generic cut name ("BEEF", "RIBEYE"), the product DESCRIPTION
// ("GFF ROAST BEEF…", "BNLS BF 80 U CMP"). A "CMP" token in the description is
// JD Food's own-brand naming → JD Food. We read notes first (most authoritative —
// the batch was run for that customer), then the description.
//
// Short/ambiguous tokens (JD, DD, HR, MCI…) are only trusted inside batch notes,
// never in a product description where they could appear by coincidence.
function matchByText(text, allowShort) {
  const t = (text || '').toUpperCase();
  if (!t) return null;
  // Distinctive, full-word names — safe to match in notes OR description.
  if (t.includes('TURKEY') || t.includes('WFM 365') || t.includes('DIESTEL')) return 'Diestel';
  if (t.includes('MISHIMA') || t.includes('MRCC') || t.includes('CROWD COW')) return 'Mishima';
  if (t.includes('SUPER DUPER')) return 'Super Duper';
  if (t.includes('AJINOMOTO')) return 'Ajinomoto';
  if (t.includes('BRANDT')) return 'Brandt';
  if (t.includes('GOURMET')) return 'Gourmet';
  if (t.includes('EEL RIVER')) return 'Eel River';
  if (t.includes('MARIPOSA')) return 'Mariposa';
  if (t.includes('HEWITT')) return 'Hewitt';
  if (t.includes('MIAMI')) return 'Miami';
  if (t.includes('GFF')) return 'GFF';
  // Short/ambiguous tokens — trust only in batch notes.
  if (allowShort) {
    if (t.includes('JMC')) return 'JMC';
    if (t.includes('WFM')) return 'WFM';
    if (t.includes('HR ') || t.startsWith('HR')) return 'Harris Ranch';
    if (t.includes('DD ')) return 'Dash & Dine';
    if (t.includes('MCI')) return 'MCI';
    if (t.includes('FML')) return 'FML';
    if (t.includes('JD ') || t.includes('BIRITE') || t.includes('WAGYU BLEND') || t.includes('CHUCK BLEND')) return 'JD Food';
  }
  // A standalone "CMP" token (product naming) = JD Food's own brand.
  if (/(^|[^A-Z])CMP([^A-Z]|$)/.test(t)) return 'JD Food';
  return null;
}

function parseCustomer(notes, description) {
  return matchByText(notes, true) || matchByText(description, false) || 'JD Food';
}

// Short room labels for the rollup (raw Swarmbox value → display).
const ROOM_LABEL = {
  'G.1.FL.OOR': 'G1', 'G.2.FL.OOR': 'G2',
  'P.1.FL.OOR': 'P1', 'P.2.FL.OOR': 'P2', 'P.3.FL.OOR': 'P3',
  'R.R.TE.000': 'RTE',
};

// Every customer parseCustomer can produce — the canonical list the "transfer
// item to another customer" dropdown is built from. "JD Food" is our own
// in-house production (there is no real "CMP" customer).
const KNOWN_CUSTOMERS = [
  'JD Food', 'Diestel', 'Mishima', 'Gourmet', 'Brandt', 'Ajinomoto', 'Super Duper',
  'Eel River', 'Mariposa', 'Hewitt', 'Miami', 'GFF', 'JMC', 'WFM',
  'Harris Ranch', 'Dash & Dine', 'MCI', 'FML',
];

module.exports = { tollRate, parseCustomer, ROOM_LABEL, KNOWN_CUSTOMERS };
