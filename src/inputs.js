// Settings typed into the "Run workflow" form on GitHub. They apply to that one run only;
// the daily run always uses config.js.

import { CATEGORIES } from './categories.js';

// Calling codes for WhatsApp links, so typing a new country "just works".
const CALLING_CODES = {
  'united kingdom': '44', uk: '44', 'great britain': '44', britain: '44', england: '44', scotland: '44', wales: '44', 'northern ireland': '44',
  ireland: '353', 'united states': '1', usa: '1', us: '1', america: '1', canada: '1',
  australia: '61', 'new zealand': '64', 'south africa': '27',
  pakistan: '92', india: '91', bangladesh: '880', 'sri lanka': '94', nepal: '977',
  'united arab emirates': '971', uae: '971', 'saudi arabia': '966', qatar: '974', kuwait: '965', oman: '968', bahrain: '973',
  egypt: '20', nigeria: '234', kenya: '254', ghana: '233', morocco: '212',
  turkey: '90', türkiye: '90', turkiye: '90',
  germany: '49', france: '33', spain: '34', italy: '39', portugal: '351', netherlands: '31', belgium: '32',
  switzerland: '41', austria: '43', sweden: '46', norway: '47', denmark: '45', finland: '358', poland: '48', greece: '30',
  malaysia: '60', indonesia: '62', philippines: '63', singapore: '65', thailand: '66', vietnam: '84',
  japan: '81', 'south korea': '82', china: '86', 'hong kong': '852',
  mexico: '52', brazil: '55', argentina: '54', colombia: '57', chile: '56',
};

export const callingCodeFor = (country) => CALLING_CODES[String(country || '').trim().toLowerCase()] || '';

/** The niche dropdown's first option, meaning "use the categories in config.js". */
export const DEFAULT_NICHE = '(daily settings)';

/**
 * Applies HUNT_CITY / HUNT_COUNTRY / HUNT_NICHE (from the Run workflow form) on top of config.js.
 * Returns { config, label } — label describes the manual settings for the Discord summary, or null.
 */
export function applyRunInputs(config, env = process.env) {
  const city = String(env.HUNT_CITY || '').trim();
  const country = String(env.HUNT_COUNTRY || '').trim();
  const niche = String(env.HUNT_NICHE || '').trim();
  const custom = String(env.HUNT_CUSTOM_NICHE || '').trim();
  const out = { ...config };
  const parts = [];

  if (/^(true|1|yes)$/i.test(String(env.HUNT_RECHECK || '').trim())) {
    // Recheck earlier leads instead of finding new ones (the other boxes don't apply).
    return { config: { ...out, recheck: true }, label: '♻️ Rechecking earlier leads with the latest checks' };
  }

  if (city) {
    // A new place: the old centre point and country no longer apply.
    out.city = city;
    out.country = country;
    out.center = null;
    out.phoneCountryCode = callingCodeFor(country);
  } else if (country) {
    out.country = country;
    out.phoneCountryCode = callingCodeFor(country) || out.phoneCountryCode;
  }
  if (city || country) parts.push([out.city, out.country].filter(Boolean).join(', '));

  const picked = niche && niche !== DEFAULT_NICHE;
  if (picked) {
    out.categories = [niche];
    parts.push(CATEGORIES[niche.toLowerCase()]?.label || niche);
  }
  if (custom) {
    // Any business type, typed in: found by searching Google Maps (e.g. "pool cleaners").
    out.mapsSearch = [custom];
    if (!picked) out.categories = [];
    parts.push(`"${custom}" (Google Maps search)`);
  }
  return { config: out, label: parts.length ? `Manual run: ${parts.join(' · ')}` : null };
}
