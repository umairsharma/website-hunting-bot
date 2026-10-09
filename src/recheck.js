// Rechecking earlier leads with the bot's latest checks (booking links, phone numbers, stricter matching).
// data/recheck.json holds the leads still to recheck; each recheck run takes a batch, and the ones that
// still have no website are sent again and saved to leads.csv. The rest are dropped.

import fs from 'node:fs';
import path from 'node:path';
import { businessProfile } from './matching.js';
import { callingCodeFor } from './inputs.js';

const FILE = 'recheck.json';

// Leads from before cities had a country saved: the cities the bot has searched outside the US.
const COUNTRY_OF_CITY = { birmingham: 'United Kingdom', lahore: 'Pakistan' };

export function loadRecheck(dir) {
  try {
    const items = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

export function saveRecheck(dir, items) {
  const file = path.join(dir, FILE);
  if (!items.length) {
    fs.rmSync(file, { force: true });
    return;
  }
  // One lead per line keeps the file readable and the git history small.
  fs.writeFileSync(file, `[\n${items.map((i) => `  ${JSON.stringify(i)}`).join(',\n')}\n]\n`);
}

/** Rows of a CSV file as objects (handles quoted cells with commas, quotes and line breaks). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header = [], ...body] = rows;
  // csvCell() puts a ' in front of cells that look like formulas; take it off again.
  return body.map((r) => Object.fromEntries(header.map((h, j) => [h, (r[j] ?? '').replace(/^'(?=[=@+-])/, '')])));
}

/**
 * The recheck list from leads.csv: one entry per business (the latest row), with the key it has in
 * seen.json so its status gets updated. Leads already rechecked today are left out.
 */
export function buildRecheckList(csvText, state) {
  const byName = new Map(); // seen.json keys of earlier leads, by name
  for (const [key, v] of Object.entries(state.places)) {
    if (v.status === 'lead' && !v.sameAs && !byName.has(v.name)) byName.set(v.name, key);
  }
  const out = new Map();
  for (const r of parseCsv(csvText)) {
    if (!r.name) continue;
    const cid = (r.google_maps.match(/[?&]cid=(\d+)/) || [])[1];
    const key = byName.get(r.name) || (cid ? `gmaps/${cid}` : `recheck/${r.name}|${r.city}`);
    const country = COUNTRY_OF_CITY[String(r.city).toLowerCase()] || 'United States';
    out.set(key, {
      key,
      name: r.name,
      category: r.category,
      city: r.city,
      country,
      phone: r.phone || null,
      address: r.address || null,
      email: r.email || null,
      mapsUrl: cid ? `https://maps.google.com/?cid=${cid}` : null,
      osmUrl: r.osm_link || null,
      foundOn: r.found_on,
    });
  }
  return [...out.values()];
}

/** A recheck entry in the shape the checks expect. */
export function recheckCandidate(item) {
  return {
    key: item.key,
    name: item.name,
    searchName: item.name,
    names: [item.name],
    profile: businessProfile([item.name], item.city),
    category: item.category,
    categoryLabel: item.category,
    lat: null,
    lon: null,
    city: item.city,
    country: item.country,
    phoneCountryCode: callingCodeFor(item.country),
    phone: item.phone,
    email: item.email,
    address: item.address,
    openingHours: null,
    socials: [],
    osmUrl: item.osmUrl,
    placeUrl: item.mapsUrl, // their Google Maps listing, opened directly
    recheck: true,
  };
}
