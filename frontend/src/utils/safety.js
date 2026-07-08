/**
 * Safety content — helplines + protocols.
 *
 * HELPLINES: verified national numbers (valid in Raipur). Sources cross-checked
 * Jan 2026. These are edited here in ONE place so updating a number is trivial.
 *
 * PROTOCOLS: general safety advice, each tied to a CONDITION computed from the
 * live incident data. A tip only shows when its condition is true, so the
 * advice always feels relevant to the current picture rather than generic.
 * All advice is true regardless of data — it's guidance, not a data claim.
 */

export const HELPLINES = [
  { num: '112',  label: 'Emergency (Police · Fire · Ambulance)', tag: 'all',
    note: 'Works without SIM/network. Press power button 3× to auto-dial.' },
  { num: '1091', label: "Women's Helpline", tag: 'women',
    note: 'Harassment or immediate danger.' },
  { num: '181',  label: 'Women in Distress (Domestic)', tag: 'women',
    note: 'Domestic abuse and distress support.' },
  { num: '1098', label: 'Childline (Child in Distress)', tag: 'child',
    note: 'Child abuse, trafficking, or a child in danger.' },
  { num: '100',  label: 'Police', tag: 'police',
    note: 'Report a crime, theft, or suspicious activity.' },
  { num: '108',  label: 'Ambulance', tag: 'medical',
    note: 'Free government medical emergency service.' },
];

/**
 * Each protocol: { id, cond(ctx) -> bool, text }.
 * ctx = { snatch, nightRatio, topArea, topScore, harassment, stalking, total }
 * Ordered by priority; the sidebar shows the first N whose cond() is true,
 * always including at least the baseline tips.
 */
export const PROTOCOLS = [
  {
    id: 'snatch',
    cond: (c) => c.snatch > 0,
    text: 'Chain/phone snatching reported nearby. Walk facing traffic, keep bags on the wall side, and avoid using your phone openly on the roadside.',
  },
  {
    id: 'night',
    cond: (c) => c.nightRatio >= 1.4,
    text: 'Incidents cluster after dark here. After 9 PM, share your live location with a trusted contact and prefer well-lit main roads over shortcuts.',
  },
  {
    id: 'stalking',
    cond: (c) => c.stalking > 0,
    text: 'If you think you are being followed, cross the road, enter the nearest open shop or the nearest police station, and call 112. Do not head home directly.',
  },
  {
    id: 'harassment',
    cond: (c) => c.harassment > 0,
    text: 'For harassment, save 1091 (Women\u2019s Helpline) on speed dial. Note vehicle numbers and descriptions — they help police act.',
  },
  {
    id: 'hotspot',
    cond: (c) => c.topScore >= 50 && c.topArea,
    text: (c) => `${c.topArea} is the highest-risk zone right now. If your route passes through it after dark, consider the safer alternative the route planner suggests.`,
  },
  // baseline tips — always eligible, fill remaining slots
  {
    id: 'baseline_112',
    cond: () => true,
    text: 'In any emergency dial 112 — it reaches police, fire, and ambulance, works even without a SIM, and shares your location with responders.',
  },
  {
    id: 'baseline_share',
    cond: () => true,
    text: 'Travelling alone at night? Share your live trip on WhatsApp/Maps with someone who can check in when you should have arrived.',
  },
];

/** Pick up to `max` protocol strings whose conditions hold. */
export function activeProtocols(ctx, max = 4) {
  const out = [];
  for (const p of PROTOCOLS) {
    if (out.length >= max) break;
    if (p.cond(ctx)) out.push(typeof p.text === 'function' ? p.text(ctx) : p.text);
  }
  return out;
}
