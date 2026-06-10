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

// Infer the toll/own customer from a batch's free-text notes. "CMP" means our
// own in-house production (we own the meat) — anything else is a named external
// customer whose meat we may be tolling.
function parseCustomer(notes) {
  const n = (notes || '').toUpperCase();
  if (n.includes('TURKEY') || n.includes('WFM 365')) return 'Diestel';
  if (n.includes('MISHIMA') || n.includes('MRCC') || n.includes('CROWD COW')) return 'Mishima';
  if (n.includes('SUPER DUPER')) return 'Super Duper';
  if (n.includes('AJINOMOTO')) return 'Ajinomoto';
  if (n.includes('BRANDT')) return 'Brandt';
  if (n.includes('GOURMET')) return 'Gourmet';
  if (n.includes('JMC')) return 'JMC';
  if (n.includes('GFF')) return 'GFF';
  if (n.includes('WFM')) return 'WFM';
  if (n.includes('HR ') || n.startsWith('HR')) return 'Harris Ranch';
  if (n.includes('DD ')) return 'Dash & Dine';
  if (n.includes('MCI')) return 'MCI';
  if (n.includes('FML')) return 'FML';
  if (n.includes('JD ') || n.includes('BIRITE') || n.includes('WAGYU BLEND') || n.includes('CHUCK BLEND')) return 'JD Food';
  return 'CMP'; // beef/chicken/pork cutting and anything unmatched = our own production
}

// Short room labels for the rollup (raw Swarmbox value → display).
const ROOM_LABEL = {
  'G.1.FL.OOR': 'G1', 'G.2.FL.OOR': 'G2',
  'P.1.FL.OOR': 'P1', 'P.2.FL.OOR': 'P2', 'P.3.FL.OOR': 'P3',
  'R.R.TE.000': 'RTE',
};

module.exports = { tollRate, parseCustomer, ROOM_LABEL };
