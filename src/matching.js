// Text + URL helpers that decide "does this business already have a website?"

// Words that don't identify a business on their own ("Ali Bakers" → "ali" is the distinctive part).
const GENERIC_WORDS = new Set([
  'the', 'and', 'of', 'by', 'at', 'in', 'pvt', 'ltd', 'llc', 'inc', 'co', 'company', 'limited', 'official', 'new', 'best',
  'restaurant', 'restaurants', 'cafe', 'coffee', 'bakery', 'bakers', 'bakes', 'sweets', 'sweet', 'food', 'foods',
  'kitchen', 'grill', 'bbq', 'hotel', 'motel', 'inn', 'guest', 'house', 'shop', 'store', 'stores', 'mart', 'market',
  'center', 'centre', 'clinic', 'hospital', 'medical', 'dental', 'dentist', 'pharmacy', 'chemist', 'chemists',
  'salon', 'saloon', 'beauty', 'parlour', 'parlor', 'spa', 'gym', 'fitness', 'club', 'auto', 'autos', 'motors',
  'garage', 'service', 'services', 'traders', 'trading', 'enterprises', 'enterprise', 'point', 'corner', 'hub',
  'express', 'international', 'studio', 'boutique', 'collection', 'tailors', 'tailor', 'clothing', 'fashion',
  'electronics', 'mobile', 'mobiles', 'agency', 'agent', 'associates', 'group', 'brothers', 'bros', 'sons',
  // Trades: "Jackson Plumbing Co." is not hattiesburgplumbingco.com
  'plumbing', 'plumber', 'plumbers', 'heating', 'cooling', 'air', 'conditioning', 'hvac', 'electric', 'electrical',
  'electrician', 'electricians', 'roofing', 'roofer', 'roofers', 'painting', 'painters', 'cleaning', 'cleaners',
  'landscaping', 'lawn', 'construction', 'contractor', 'contractors', 'repair', 'repairs', 'drain', 'sewer', 'gas',
  'pest', 'control', 'locksmith', 'carpentry', 'remodeling', 'solutions', 'pros', 'experts', 'llc',
]);

const STOP_WORDS = new Set(['the', 'and', 'pvt', 'ltd', 'llc', 'inc', 'company', 'limited']);

export function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFKD').replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export const compact = (s) => normalizeText(s).replace(/ /g, '');

const tokensOf = (s) => normalizeText(s).split(' ').filter(Boolean);

/** Is `candidate` (e.g. a Google Maps title) the same business as any of `names`? */
export function namesMatch(candidate, names) {
  const list = Array.isArray(names) ? names : [names];
  return list.some((n) => nameSimilar(candidate, n));
}

function nameSimilar(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ca = na.replace(/ /g, '');
  const cb = nb.replace(/ /g, '');
  const [short, long, shortText] = ca.length <= cb.length ? [ca, cb, na] : [cb, ca, nb];
  // "Salon" is inside "Salon Zara", but a name made only of generic words doesn't identify a business.
  const distinctive = shortText.split(' ').some((t) => !GENERIC_WORDS.has(t) && !STOP_WORDS.has(t));
  if (distinctive && long.includes(short) && (short.length >= 5 || short.length >= 0.6 * long.length)) return true;
  const words = (s) => new Set(s.split(' ').filter((t) => t.length >= 3 && !STOP_WORDS.has(t)));
  const ta = words(na);
  const tb = words(nb);
  if (!ta.size || !tb.size) return false;
  const shared = [...ta].filter((t) => tb.has(t));
  // Sharing only a generic word ("Cafe X" vs "Cafe Y") doesn't count.
  if (!shared.some((t) => !GENERIC_WORDS.has(t))) return false;
  return shared.length / Math.min(ta.size, tb.size) >= 0.6;
}

/** Pre-computes the name forms used to recognise a business's own domain. */
export function businessProfile(names, city) {
  const cityTokens = new Set(tokensOf(city));
  const keys = new Set();
  const tokenSets = [];
  const words = new Set();
  for (const name of names) {
    const toks = tokensOf(name);
    if (!toks.length) continue;
    keys.add(toks.join(''));
    keys.add(toks.filter((t) => t !== 'and').join(''));
    // Without "LLC", "Inc", "Co": "Bishop Plumbing Service LLC" → bishopplumbingservice
    const core = toks.filter((t) => !STOP_WORDS.has(t) && t !== 'co');
    keys.add(core.join(''));
    keys.add(core.filter((t) => t !== 'and').join(''));
    for (const t of toks) words.add(t);
    const distinctive = toks.filter((t) => t.length >= 3 && !GENERIC_WORDS.has(t) && !cityTokens.has(t));
    if (distinctive.length) tokenSets.push([...new Set(distinctive)]); // "Clark & Clark" → clark
  }
  return { keys: [...keys].filter((k) => k.length >= 4), tokenSets, cityTokens, words };
}

// Words any kind of business can have in its domain.
const NEUTRAL_WORDS = ['service', 'services', 'company', 'group', 'solutions', 'enterprises', 'repair', 'repairs', 'garage',
  'center', 'centre', 'studio', 'shop', 'store', 'experts', 'pros', 'brothers', 'sons', 'family'];

// Extra words sites add to a business name (joesplumbingonline.com, bishopplumbingms.com).
const SITE_FILLER = ['online', 'web', 'site', 'usa', 'official', 'team', 'home', 'call', 'now', 'get', 'local', 'pro'];

/**
 * What's left of a domain after taking out the business's own words and generic ones.
 * "bishopcisd" for "Bishop Plumbing" → "cisd"; "bishopplumbingms" → "ms".
 */
function leftoverOf(siteKey, profile) {
  // Short generic words ("new", "air") hide inside other words ("chapmannews"), so only longer ones count.
  // Another trade's word doesn't explain itself (avantemedicalcenter.com is not "Avante Plumbing Co").
  const known = [...new Set([...profile.words, ...profile.cityTokens, ...NEUTRAL_WORDS, ...SITE_FILLER])]
    .filter((w) => w.length >= 4 || profile.words.has(w))
    .sort((a, b) => b.length - a.length);
  let rest = siteKey;
  for (const w of known) rest = rest.split(w).join(' ');
  return rest.replace(/[\s\d]+/g, '');
}

/**
 * Strong match: the domain is clearly named after the business (alibakers.pk for "Ali Bakers").
 * A domain holding only part of the name ("bishop" of "Bishop Plumbing") must have nothing else
 * unexplained in it, or a page title naming the business: bishopcisd.net is a school district.
 */
export function siteMatchesBusiness(siteKey, profile, title = '') {
  if (!siteKey || siteKey.length < 3) return false;
  if (GENERIC_WORDS.has(siteKey) || profile.cityTokens.has(siteKey)) return false;
  if (profile.keys.some((key) => siteKey.includes(key))) return true;
  const t = compact(title);
  const tCore = tokensOf(title).filter((w) => !STOP_WORDS.has(w)).join(''); // "Barber & Sons" → barbersons
  const titled = profile.keys.some((k) => k.length >= 6 && (t.includes(k) || tCore.includes(k)));
  // Just one word of the name (jackson.com for "Jackson Plumbing Co.") is a surname or a place as often
  // as it's the business, so it counts only when the page title names the business.
  const plain = siteKey.replace(/\d+/g, '');
  if (profile.tokenSets.some((tokens) => tokens.length === 1 && [plain, plain.replace(/s$/, '')].includes(tokens[0]))) return titled;
  if (profile.keys.some((key) => siteKey.length >= 5 && key.includes(siteKey) && siteKey.length >= key.length * 0.5)) return true;
  // One distinctive word plus another word of the name (bishopplumbing.com), not some other word (douglasus.com).
  // A neutral business word counts too (harbornegarage.co.uk for "Harborne Auto Centre"), but not another
  // trade's (friendlysrestaurants.com is not "Friendly Plumbers").
  const otherNameWord = (tokens) => [...profile.words, ...NEUTRAL_WORDS]
    .some((w) => w.length >= 3 && !tokens.includes(w) && !STOP_WORDS.has(w) && siteKey.includes(w));
  const holds = (tokens) => tokens.join('').length >= 5 && tokens.every((x) => siteKey.includes(x));
  if (titled && profile.tokenSets.some(holds)) return true;
  const partial = profile.tokenSets.some((tokens) => holds(tokens) && (tokens.length > 1 || otherNameWord(tokens)));
  // With more than that one word, nothing else in the domain may be unexplained.
  return partial && leftoverOf(siteKey, profile).length <= 3;
}

function titleStartsWithName(title, names) {
  const t = normalizeText(title);
  return names.some((n) => {
    const nn = normalizeText(n);
    return nn.length >= 4 && t.startsWith(nn);
  });
}

export function titleMentionsName(title, profile) {
  const t = compact(title);
  if (profile.keys.some((k) => k.length >= 5 && t.includes(k))) return true;
  return profile.tokenSets.some((tokens) => tokens.join('').length >= 5 && tokens.every((x) => t.includes(x)));
}

// ── URL classification ──────────────────────────────────────────────────────

const brandPattern = (brands) => new RegExp(`(^|\\.)(${brands.join('|')})\\.[a-z.]{2,12}$`);

// Pages that are NOT the business's own website.
const SOCIAL = brandPattern([
  'facebook', 'fb', 'instagram', 'instagr', 'twitter', 'x', 'tiktok', 'youtube', 'youtu', 'linkedin', 'pinterest',
  'snapchat', 'threads', 'whatsapp', 'wa', 'telegram', 't', 'linktr', 'linktree', 'beacons', 'bio', 'taplink', 'lnk',
  'msha', 'about', 'tumblr', 'vk', 'weibo', 'line',
]);
const DELIVERY = brandPattern([
  'foodpanda', 'ubereats', 'doordash', 'grubhub', 'deliveroo', 'talabat', 'zomato', 'swiggy', 'justeat', 'just-eat',
  'menulog', 'careem', 'cheetay', 'glovoapp', 'glovo', 'wolt', 'rappi', 'postmates', 'seamless', 'skipthedishes',
  'hungerstation', 'jahez', 'lieferando', 'thuisbezorgd', 'pedidosya', 'ifood', 'foodora', 'grab',
]);
const BOOKING = brandPattern([
  'booking', 'agoda', 'expedia', 'hotels', 'trivago', 'airbnb', 'kayak', 'makemytrip', 'goibibo', 'bookme',
  'sastaticket', 'practo', 'marham', 'oladoc', 'sehat', 'fresha', 'treatwell', 'vagaro', 'booksy', 'mindbody',
  'mindbodyonline', 'opentable', 'resy', 'tablecheck', 'eatapp', 'classpass', 'zocdoc', 'doctolib', 'healthgrades',
  'hotelscombined', 'trip', 'yatra', 'ixigo', 'cleartrip', 'hostelworld',
]);
const DIRECTORY = brandPattern([
  'yelp', 'tripadvisor', 'foursquare', 'yellowpages', 'yell', 'cylex', 'infobel', 'hotfrog', 'kompass',
  'restaurantguru', 'sluurpy', 'justdial', 'sulekha', 'wikipedia', 'wikimapia', 'wikidata', 'mapcarta', 'trustpilot',
  'glassdoor', 'indeed', 'olx', 'daraz', 'zameen', 'graana', 'businesslist', 'pakbiz', 'brownbook', 'cybo', 'manta',
  'bbb', 'chamberofcommerce', 'mapquest', 'nextdoor', 'angi', 'angieslist', 'houzz', 'thumbtack', 'checkatrade',
  'scoot', 'freeindex', 'n49', 'yellow', 'top-rated', 'restaurantji', 'menupages', 'allmenus', 'wanderlog',
  'lonelyplanet', 'timeout', 'reddit', 'quora', 'openstreetmap', 'waze', 'here', 'bing', 'duckduckgo', 'yahoo',
  'yandex', '2gis', 'apple', 'findglocal', 'infoisinfo', 'locanto', 'rozee', 'mustakbil', 'dnb', 'opencorporates',
  'bizapedia', 'zoominfo', 'crunchbase', 'placedigger', 'worldorgs', 'tuugo', 'ezlocal', 'citysquares',
  'superpages', 'merchantcircle', 'storeboard', 'showmelocal', 'cataloxy', 'tradekey', 'alibaba', 'indiamart',
  'birdeye', 'homeyou', 'yellowbot', 'buildzoom', 'homeadvisor', 'porch', 'bark', 'expertise', 'threebestrated',
  'callupcontact', 'bizprofile', 'chamberorganization', 'allbiz', 'yably', 'judysbook', 'kudzu', 'loc8nearme',
  'whitepages', 'spokeo', 'fyple', 'golocal247', 'iglobal', 'us-business', 'wheree', 'homescroller', 'rocketreach',
  'nicelocal', 'cityfos', 'bizvibe', 'dexknows',
]);
// Government, schools and universities are never a local business's own site (bishop.edu, oxford.gov.uk).
const INSTITUTION = /\.(gov|edu|mil)(\.[a-z]{2})?$|\.(ac|gov|govt|edu|nhs|police|sch|mil)\.[a-z]{2}$|\.(k12|state)\.[a-z]{2}\.us$/;
// Google shut down business.site websites in 2024 — a link there means no working site.
const DEAD = /(^|\.)business\.site$/;
const GOOGLE = /(^|\.)google\.[a-z.]{2,8}$|(^|\.)(goo\.gl|g\.page|g\.co|share\.google)$/;

// Free website builders put the business name in the subdomain (alibakers.wixsite.com).
const PLATFORM_HOSTS = [
  'wixsite.com', 'weebly.com', 'wordpress.com', 'blogspot.com', 'godaddysites.com', 'square.site', 'webflow.io',
  'carrd.co', 'netlify.app', 'vercel.app', 'github.io', 'myshopify.com', 'jimdosite.com', 'mystrikingly.com',
  'strikingly.com', 'site123.me', 'webnode.page', 'framer.website', 'my.canva.site', 'canva.site',
];
const SECOND_LEVEL = new Set(['com', 'net', 'org', 'co', 'edu', 'gov', 'ac', 'biz', 'gen', 'web', 'ltd', 'plc']);

export function unwrapRedirect(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  const host = u.hostname.replace(/^www\./, '');
  if (GOOGLE.test(host) && u.pathname === '/url') return u.searchParams.get('q') || u.searchParams.get('url') || raw;
  if (host.endsWith('duckduckgo.com') && u.pathname.startsWith('/l/')) return u.searchParams.get('uddg') || raw;
  if (host.endsWith('bing.com') && u.pathname.startsWith('/ck/')) {
    const p = u.searchParams.get('u');
    if (p && p.startsWith('a1')) {
      const decoded = Buffer.from(p.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      if (/^https?:\/\//.test(decoded)) return decoded;
    }
  }
  return raw;
}

export function hostOf(url) {
  try {
    return new URL(unwrapRedirect(url)).hostname.toLowerCase().replace(/^www\d?\./, '').replace(/^m\./, '');
  } catch {
    return '';
  }
}

function registrableLabel(host) {
  const labels = host.split('.');
  if (labels.length >= 3 && SECOND_LEVEL.has(labels[labels.length - 2])) return labels[labels.length - 3];
  return labels.length >= 2 ? labels[labels.length - 2] : labels[0];
}

function siteKeyFor(host, u) {
  if (host === 'sites.google.com') return compact(u.pathname);
  const platform = PLATFORM_HOSTS.find((p) => host.endsWith(`.${p}`));
  if (platform) {
    const sub = host.slice(0, -(platform.length + 1));
    return compact(`${sub} ${platform === 'wixsite.com' ? u.pathname : ''}`);
  }
  return registrableLabel(host).replace(/-/g, '');
}

/** kind: website | social | delivery | booking | directory | maps | dead */
export function classifyUrl(raw) {
  let u;
  try {
    u = new URL(unwrapRedirect(raw));
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^www\d?\./, '').replace(/^m\./, '');
  let kind = 'website';
  if (host === 'sites.google.com') kind = 'website';
  else if (DEAD.test(host)) kind = 'dead';
  else if (SOCIAL.test(host)) kind = 'social';
  else if (DELIVERY.test(host)) kind = 'delivery';
  else if (BOOKING.test(host)) kind = 'booking';
  else if (GOOGLE.test(host)) kind = 'maps';
  else if (DIRECTORY.test(host) || /yellow-?pages/.test(host)) kind = 'directory';
  else if (INSTITUTION.test(host)) kind = 'institution';
  return { kind, host, url: u.href, siteKey: siteKeyFor(host, u) };
}

const PRETTY = {
  facebook: 'Facebook', fb: 'Facebook', instagram: 'Instagram', instagr: 'Instagram', tiktok: 'TikTok',
  youtube: 'YouTube', youtu: 'YouTube', linkedin: 'LinkedIn', twitter: 'X (Twitter)', x: 'X (Twitter)',
  wa: 'WhatsApp', whatsapp: 'WhatsApp', linktr: 'Linktree', foodpanda: 'Foodpanda', ubereats: 'Uber Eats',
  doordash: 'DoorDash', marham: 'Marham', oladoc: 'Oladoc', booking: 'Booking.com', tripadvisor: 'Tripadvisor',
  google: 'Google', business: 'Google Business',
};
export function prettySite(host) {
  const label = registrableLabel(host || '');
  return PRETTY[label] || (label ? label.charAt(0).toUpperCase() + label.slice(1) : 'link');
}

// ── Layer 3 decision ────────────────────────────────────────────────────────

function pathDepth(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).length;
  } catch {
    return 99;
  }
}

/**
 * Looks at search results for one business.
 * hasWebsite → a result's domain is clearly the business's own site.
 * possible   → a homepage whose title starts with the business name, but the domain doesn't match (check manually).
 * socials    → the business's own social pages (useful when pitching).
 */
export function analyzeResults(results, biz) {
  const profile = biz.profile || businessProfile(biz.names, biz.city);
  const socials = [];
  const possible = [];
  for (const r of results) {
    const site = classifyUrl(r.url);
    if (!site) continue;
    if (site.kind === 'social') {
      if (titleMentionsName(r.title, profile)) socials.push(site.url);
      continue;
    }
    if (site.kind !== 'website') continue;
    if (siteMatchesBusiness(site.siteKey, profile, r.title)) return { hasWebsite: true, website: site.url, socials, possible };
    const oneWord = pathDepth(site.url) <= 1 && profile.tokenSets.some((tokens) => tokens.length === 1 && tokens[0] === site.siteKey);
    if (possible.length < 2 && pathDepth(site.url) <= 1 && (oneWord || titleStartsWithName(r.title, biz.names))) {
      if (!possible.includes(site.host)) possible.push(site.host);
    }
  }
  return { hasWebsite: false, website: null, socials, possible };
}

export function uniqueUrls(urls) {
  const seen = new Set();
  const out = [];
  for (const url of urls) {
    if (!url) continue;
    const key = url.toLowerCase().replace(/^https?:\/\/(www\.|m\.)?/, '').replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

// Where mobile numbers can be told apart from landlines, only mobiles get a WhatsApp link.
// Countries not listed here (e.g. USA/Canada, where they look the same) always get one.
const MOBILE_PREFIXES = {
  92: /^923/, // Pakistan
  91: /^91[6-9]/, // India
  880: /^8801[3-9]/, // Bangladesh
  971: /^9715/, // UAE
  966: /^9665/, // Saudi Arabia
  974: /^974[3567]/, // Qatar
  965: /^965[569]/, // Kuwait
  968: /^968[79]/, // Oman
  973: /^973[36]/, // Bahrain
  44: /^447/, // UK
  353: /^3538/, // Ireland
  61: /^614/, // Australia
  64: /^642/, // New Zealand
  27: /^27[6-8]/, // South Africa
  234: /^234[789]/, // Nigeria
  254: /^254[17]/, // Kenya
  20: /^201/, // Egypt
  90: /^905/, // Turkey
  62: /^628/, // Indonesia
  63: /^639/, // Philippines
  60: /^601/, // Malaysia
  94: /^947/, // Sri Lanka
  977: /^9779/, // Nepal
};

/** wa.me link from a phone number, using the country code for local numbers ("0300…" → "92300…"). */
export function toWhatsApp(phone, countryCode = '') {
  if (!phone) return null;
  const first = String(phone).split(/[;,/]/)[0].trim();
  let digits = first.replace(/\D/g, '');
  if (!first.startsWith('+')) {
    if (digits.startsWith('00')) digits = digits.slice(2);
    else if (countryCode && digits.startsWith('0')) digits = countryCode + digits.slice(1);
    else if (countryCode && !digits.startsWith(countryCode) && digits.length <= 10) digits = countryCode + digits;
  }
  // Still a local number (no country code known), so wa.me can't use it.
  if (digits.startsWith('0')) return null;
  if (digits.length < 10 || digits.length > 15) return null;
  // Country codes never share a prefix, so at most one entry matches.
  const code = Object.keys(MOBILE_PREFIXES).find((c) => digits.startsWith(c));
  if (code && !MOBILE_PREFIXES[code].test(digits)) return null;
  return `https://wa.me/${digits}`;
}
