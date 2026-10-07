// Layer 1 — OpenStreetMap: find named businesses in the area that have no website tag.

import fs from 'node:fs';
import path from 'node:path';
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
  // kind: city, state, county… (a whole state is searched differently on Google Maps)
  return { type: 'area', areaId: offset + Number(best.osm_id), lat, lon, label: best.display_name, kind: best.addresstype || best.type || null };
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
  const header = ['[out:json][timeout:120];'];
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

/**
 * Tries each server once (twice if there's time), best server first.
 * Returns the elements, or null if every server failed. Moves the server that worked to the front.
 */
async function runOverpass(query, servers, log, deadline, retryDelayMs) {
  for (let round = 1; round <= 2; round += 1) {
    for (const endpoint of [...servers]) {
      const left = deadline - Date.now();
      if (left < 15000) return null;
      const host = endpoint.replace(/^https?:\/\//, '').split('/')[0];
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': botUserAgent(), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(Math.min(135000, left)),
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
        servers.splice(servers.indexOf(endpoint), 1);
        servers.unshift(endpoint);
        return json.elements || [];
      } catch (err) {
        log(`   Overpass ${host}: ${err.message}, trying another server…`);
      }
    }
    if (round === 1 && deadline - Date.now() > 60000) await sleep(retryDelayMs);
  }
  return null;
}

// ── OpenStreetMap cache (data/osm-cache.json) ──
// Shops change slowly, so each category is downloaded at most once a week. If the servers are down,
// an older copy (up to STALE_DAYS) is used instead, so a bad day for OpenStreetMap doesn't stop the bot.
const CACHE_FILE = 'osm-cache.json';
const FRESH_DAYS = 7;
const STALE_DAYS = 60;
const LAYER1_BUDGET_MS = 15 * 60000;

function loadCache(dir) {
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(dir, CACHE_FILE), 'utf8'));
    if (cache && typeof cache === 'object') return cache;
  } catch {
    // no cache yet
  }
  return {};
}

function saveCache(dir, cache) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, CACHE_FILE);
  // One element per line keeps the weekly git diff small.
  const entries = Object.entries(cache).map(([key, { fetched, elements }]) => {
    const rows = elements.map((el) => `   ${JSON.stringify(el)}`).join(',\n');
    return ` ${JSON.stringify(key)}: {"fetched": ${JSON.stringify(fetched)}, "elements": [\n${rows}\n ]}`;
  });
  fs.writeFileSync(`${file}.tmp`, `{\n${entries.join(',\n')}\n}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

const slim = (el) => ({ type: el.type, id: el.id, lat: el.lat, lon: el.lon, center: el.center, tags: el.tags });

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
  const seen = new Map(); // name → positions already kept
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

    // The same shop is sometimes mapped twice (a point and a building, or two points) — keep one.
    // Same name within about 150 m counts as the same shop.
    const nameKey = compact(t.name);
    const spots = seen.get(nameKey) || [];
    if (spots.some(([a, b]) => Math.abs(a - lat) < 0.0014 && Math.abs(b - lon) * Math.cos((lat * Math.PI) / 180) < 0.0014)) continue;
    seen.set(nameKey, [...spots, [lat, lon]]);

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

/**
 * Layer 1: one small Overpass query per category (one big query for a whole city times out).
 * Returns { candidates, notes }. Throws only when no category could be loaded at all.
 */
export async function fetchCandidates({ cfg, area, defs, ep, dataDir = null, save = false, log = () => {}, retryDelayMs = 20000 }) {
  const cache = dataDir ? loadCache(dataDir) : {};
  const place = [cfg.city, cfg.country, cfg.radiusKm, cfg.center ? `${cfg.center.lat},${cfg.center.lon}` : ''].join('|');
  const servers = [...ep.overpass];
  const deadline = Date.now() + LAYER1_BUDGET_MS;
  const elements = [];
  const stale = [];
  const missing = [];
  let changed = false;

  for (const def of defs) {
    const key = `${place}|${cfg.skipChains ? 'no-chains' : 'all'}|${def.tags.map((t) => `${t.key}=${t.value}`).join(',')}`;
    const cached = cache[key];
    const ageDays = cached ? (Date.now() - Date.parse(cached.fetched)) / 86400000 : Infinity;
    if (ageDays < FRESH_DAYS) {
      elements.push(...cached.elements);
      continue;
    }
    log(`   OpenStreetMap: loading ${def.label}…`);
    const query = buildOverpassQuery({ defs: [def], area, skipChains: cfg.skipChains });
    const got = await runOverpass(query, servers, log, deadline, retryDelayMs);
    if (got) {
      cache[key] = { fetched: new Date().toISOString(), elements: got.map(slim) };
      elements.push(...got);
      changed = true;
    } else if (cached && ageDays < STALE_DAYS) {
      elements.push(...cached.elements);
      stale.push(def.label);
    } else {
      missing.push(def.label);
    }
  }

  if (missing.length === defs.length) {
    throw new Error('Could not reach any OpenStreetMap (Overpass) server. It will retry next run.');
  }
  if (changed && save && dataDir) saveCache(dataDir, cache);
  const notes = [];
  if (stale.length) notes.push(`OpenStreetMap servers were busy, so older saved data was used for: ${stale.join(', ')}.`);
  if (missing.length) notes.push(`OpenStreetMap servers were busy, so these were skipped this run: ${missing.join(', ')}.`);
  return { candidates: toCandidates(elements, { defs, cfg }), notes };
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
