// Layer 1 — OpenStreetMap: find named businesses in the area that have no website tag.

import { businessProfile, compact } from './matching.js';
import { botUserAgent, sleep } from './util.js';

const RELATION_AREA_OFFSET = 3600000000;
const WAY_AREA_OFFSET = 2400000000;

/** Works out the search area: an OSM boundary (whole city) or a circle around a point. */
export async function resolveArea(cfg, ep, log = () => {}) {
  if (cfg.center && Number.isFinite(Number(cfg.center.lat)) && Number.isFinite(Number(cfg.center.lon))) {
    const radiusKm = cfg.radiusKm > 0 ? cfg.radiusKm : 5;
    const lat = Number(cfg.center.lat);
    const lon = Number(cfg.center.lon);
    return { type: 'around', lat, lon, radiusM: radiusKm * 1000, label: `${radiusKm} km around ${lat}, ${lon}` };
  }

  const q = [cfg.city, cfg.country].filter(Boolean).join(', ');
  let results;
  try {
    const params = new URLSearchParams({ q, format: 'jsonv2', limit: '5' });
    const res = await fetch(`${ep.nominatim}/search?${params}`, {
      headers: { 'User-Agent': botUserAgent(), 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    results = await res.json();
  } catch (err) {
    // Place lookup is down — fall back to matching the city's name inside Overpass.
    log(`   Place lookup failed (${err.message}); matching "${cfg.city}" by name instead.`);
    return { type: 'name', name: cfg.city, country: cfg.country, label: q };
  }

  if (!Array.isArray(results) || !results.length) {
    throw new Error(`Couldn't find "${q}" on OpenStreetMap. Check the spelling of city/country in config.js.`);
  }
  const kind = (r) => r.category || r.class;
  const best = results.find((r) => ['relation', 'way'].includes(r.osm_type) && ['boundary', 'place'].includes(kind(r)))
    || results[0];
  const lat = Number(best.lat);
  const lon = Number(best.lon);
  if (cfg.radiusKm > 0 || best.osm_type === 'node') {
    const radiusKm = cfg.radiusKm > 0 ? cfg.radiusKm : 10;
    return { type: 'around', lat, lon, radiusM: radiusKm * 1000, label: `${radiusKm} km around ${best.display_name}` };
  }
  const offset = best.osm_type === 'relation' ? RELATION_AREA_OFFSET : WAY_AREA_OFFSET;
  return { type: 'area', areaId: offset + Number(best.osm_id), lat, lon, label: best.display_name };
}

const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function buildOverpassQuery({ defs, area, skipChains }) {
  const scope = area.type === 'around'
    ? `(around:${Math.round(area.radiusM)},${area.lat},${area.lon})`
    : '(area.searchArea)';
  const noWebsite = `["name"][!"website"][!"contact:website"][!"url"]${skipChains ? '[!"brand:wikidata"]' : ''}`;
  const seen = new Set();
  const lines = [];
  for (const def of defs) {
    for (const { key, value } of def.tags) {
      const line = `  nwr[${quote(key)}=${quote(value)}]${noWebsite}${scope};`;
      if (!seen.has(line)) lines.push(line);
      seen.add(line);
    }
  }
  const header = ['[out:json][timeout:180];'];
  if (area.type === 'area') header.push(`area(id:${area.areaId})->.searchArea;`);
  if (area.type === 'name' && area.country) {
    // Only places with that name inside the chosen country, not every "Hyderabad" in the world.
    const c = quote(area.country);
    const n = quote(area.name);
    header.push(`(area["admin_level"="2"]["name"=${c}];area["admin_level"="2"]["name:en"=${c}];)->.country;`);
    header.push(`(rel["name"=${n}](area.country);rel["name:en"=${n}](area.country););`);
    header.push('map_to_area->.searchArea;');
  } else if (area.type === 'name') {
    header.push(`(area["name"=${quote(area.name)}];area["name:en"=${quote(area.name)}];)->.searchArea;`);
  }
  return [...header, '(', ...lines, ');', 'out center;'].join('\n');
}

async function runOverpass(query, ep, log) {
  for (let round = 1; round <= 2; round += 1) {
    for (const endpoint of ep.overpass) {
      const host = endpoint.replace(/^https?:\/\//, '').split('/')[0];
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': botUserAgent(), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(200000),
        });
        if (!res.ok) {
          log(`   Overpass ${host}: HTTP ${res.status}, trying another server…`);
          continue;
        }
        const json = await res.json();
        if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) {
          log(`   Overpass ${host}: ${json.remark.slice(0, 120)}, trying another server…`);
          continue;
        }
        return json.elements || [];
      } catch (err) {
        log(`   Overpass ${host}: ${err.message}, trying another server…`);
      }
    }
    if (round === 1) await sleep(30000);
  }
  throw new Error('Could not reach any OpenStreetMap (Overpass) server. It will retry next run.');
}

function formatAddress(t) {
  if (t['addr:full']) return t['addr:full'];
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const parts = [street, t['addr:suburb'] || t['addr:district'] || t['addr:neighbourhood'], t['addr:city']].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function socialUrl(value, site) {
  if (!value) return null;
  const v = String(value).split(';')[0].trim();
  let url;
  if (/^https?:\/\//i.test(v)) url = v;
  else if (/^(www\.)?(facebook|instagram)\.com\//i.test(v)) url = `https://${v}`;
  else url = `https://www.${site}.com/${v.replace(/^@/, '')}`;
  // Anyone can edit OpenStreetMap; a malformed link would make Discord reject the whole message.
  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}

/** OSM elements → candidate businesses (with safety filters in case a server ignores part of the query). */
export function toCandidates(elements, { defs, cfg }) {
  const out = [];
  const seen = new Set();
  for (const el of elements) {
    const t = el.tags || {};
    if (!t.name) continue;
    if (t.website || t['contact:website'] || t.url) continue;
    if (cfg.skipChains && t['brand:wikidata']) continue;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const def = defs.find((d) => d.tags.some(({ key, value }) => t[key] === value));
    if (!def) continue;

    // The same shop is sometimes mapped twice (a point and a building) — keep one.
    const dupeKey = `${compact(t.name)}@${lat.toFixed(3)},${lon.toFixed(3)}`;
    if (seen.has(dupeKey)) continue;
    seen.add(dupeKey);

    const names = [...new Set(
      [t.name, t['name:en'], ...(t.alt_name || '').split(';'), t.official_name, t.short_name]
        .map((s) => (s || '').trim())
        .filter(Boolean),
    )];
    const searchName = /[a-z]/i.test(t.name) ? t.name : (t['name:en'] || t.name);
    const phone = (t.phone || t['contact:phone'] || t['contact:mobile'] || t.mobile || '').split(';')[0].trim();
    out.push({
      key: `${el.type}/${el.id}`,
      name: t.name,
      searchName,
      names,
      profile: businessProfile(names, cfg.city),
      category: def.id,
      categoryLabel: def.label,
      lat,
      lon,
      city: cfg.city,
      phone: phone || null,
      email: (t.email || t['contact:email'] || '').split(';')[0].trim() || null,
      address: formatAddress(t),
      openingHours: t.opening_hours || null,
      socials: [
        socialUrl(t['contact:facebook'] || t.facebook, 'facebook'),
        socialUrl(t['contact:instagram'] || t.instagram, 'instagram'),
      ].filter(Boolean),
      osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    });
  }
  return out;
}

export async function fetchCandidates({ cfg, area, defs, ep, log = () => {} }) {
  const query = buildOverpassQuery({ defs, area, skipChains: cfg.skipChains });
  const elements = await runOverpass(query, ep, log);
  return toCandidates(elements, { defs, cfg });
}

/** Businesses with a phone number / address are easier to pitch, so they go first. */
export function scoreCandidate(c) {
  let s = 0;
  if (c.phone) s += 3;
  if (c.address) s += 1;
  if (c.openingHours) s += 1;
  if (c.socials.length) s += 1;
  if (!/[a-z]/i.test(c.searchName)) s -= 2;
  return s;
}

/**
 * Picks this run's batch: never-checked businesses first (best-scored, mixing categories),
 * then ones that couldn't be verified last time.
 */
export function pickQueue(candidates, state, limit, maxAttempts = 3) {
  const fresh = [];
  const retry = [];
  for (const c of candidates) {
    const rec = state.places[c.key];
    if (!rec) fresh.push(c);
    else if (rec.status === 'unverified' && (rec.attempts || 0) < maxAttempts) retry.push(c);
  }
  fresh.sort((a, b) => scoreCandidate(b) - scoreCandidate(a) || a.key.localeCompare(b.key));
  const groups = new Map();
  for (const c of fresh) {
    if (!groups.has(c.category)) groups.set(c.category, []);
    groups.get(c.category).push(c);
  }
  const ordered = [];
  const lanes = [...groups.values()];
  while (lanes.some((lane) => lane.length)) {
    for (const lane of lanes) if (lane.length) ordered.push(lane.shift());
  }
  retry.sort((a, b) => (state.places[a.key].attempts || 0) - (state.places[b.key].attempts || 0));
  const all = [...ordered, ...retry];
  return { queue: all.slice(0, limit), pending: all.length };
}
