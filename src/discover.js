// Finding businesses on Google Maps itself ("plumbers in Jackson, Mississippi"), for when OpenStreetMap
// doesn't have enough. OpenStreetMap rarely maps trades (plumbers, roofers, …) in the US, for example.

import { gotoPage, isBlocked } from './browser.js';
import { businessProfile } from './matching.js';

const FEED_LINK = 'div[role="feed"] a[href*="/maps/place/"]';

/** Every place in the results list: name, link, and the website link its card shows (if any). */
function readFeed() {
  return Array.from(document.querySelectorAll('div[role="feed"] a[href*="/maps/place/"]')).map((a) => {
    // Climb to the place's card: the biggest box that still holds only this one place.
    let card = a;
    while (card.parentElement && card.parentElement.querySelectorAll('a[href*="/maps/place/"]').length === 1) card = card.parentElement;
    const site = Array.from(card.querySelectorAll('a[href^="http"]'))
      .find((x) => x !== a && !/\/maps\/|google\.[a-z.]+\/(maps|url|search)/.test(x.href));
    return { href: a.href, name: (a.getAttribute('aria-label') || a.textContent || '').trim(), website: site ? site.href : null };
  });
}

/** Google's place ID from a listing link (the part after "!1s0x…:0x"), as a number. */
export function placeIdOf(href) {
  const m = String(href).match(/!1s0x[0-9a-f]+:0x([0-9a-f]+)/i);
  return m ? BigInt(`0x${m[1]}`).toString() : null;
}

/** The pin's position from a listing link ("!3d<lat>!4d<lon>"). */
function coordsOf(href) {
  const m = String(href).match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  return m ? { lat: Number(m[1]), lon: Number(m[2]) } : { lat: null, lon: null };
}

/**
 * Searches Google Maps for `term` in the city and scrolls the results until it has `want` places the
 * bot hasn't seen before (isKnown(key) → true for already-checked ones) or the list ends.
 * Returns { blocked, places: [{ key, name, href, website, lat, lon }] } with only new places.
 */
export async function discoverOnMaps(page, { term, city, country, area, mapsBase, want = 30, isKnown = () => false, log = () => {} }) {
  const query = `${term} in ${[city, country].filter(Boolean).join(', ')}`;
  // Centre the map on a city; for a whole state or country let Google frame it ("plumbers in Mississippi").
  const wide = ['state', 'country', 'region', 'province'].includes(area?.kind);
  const at = !wide && area && Number.isFinite(area.lat) && Number.isFinite(area.lon) ? `/@${area.lat.toFixed(5)},${area.lon.toFixed(5)},12z` : '';
  log(`🔎 Google Maps: searching "${query}"…`);
  await gotoPage(page, `${mapsBase}/search/${encodeURIComponent(query)}${at}?hl=en`);
  if (await isBlocked(page)) return { blocked: true, places: [] };
  await page.waitForSelector(FEED_LINK, { state: 'attached', timeout: 15000 }).catch(() => {});

  const found = new Map();
  let stale = 0;
  for (let round = 0; round < 30; round += 1) {
    const before = found.size;
    for (const item of await page.evaluate(readFeed).catch(() => [])) {
      const id = placeIdOf(item.href);
      const key = id ? `gmaps/${id}` : `gmaps/${item.name.toLowerCase()}`;
      if (!item.name || found.has(key)) continue;
      found.set(key, { key, ...item, ...coordsOf(item.href) });
    }
    const fresh = [...found.values()].filter((p) => !isKnown(p.key)).length;
    if (fresh >= want) break;
    const ended = await page.evaluate(() => /reached the end of the list/i.test(document.querySelector('div[role="feed"]')?.innerText || '')).catch(() => true);
    if (ended) break;
    stale = found.size === before ? stale + 1 : 0;
    if (stale >= 3) break; // nothing new after a few scrolls
    // The results list loads more places as it scrolls.
    await page.evaluate(() => { const feed = document.querySelector('div[role="feed"]'); if (feed) feed.scrollBy(0, feed.scrollHeight); }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  if (await isBlocked(page).catch(() => false)) return { blocked: true, places: [] };
  const places = [...found.values()].filter((p) => !isKnown(p.key));
  log(`   ${found.size} on Google Maps, ${places.length} not checked before`);
  return { blocked: false, places, total: found.size };
}

/** A discovered place in the same shape as an OpenStreetMap candidate, so the normal checks run on it. */
export function toCandidate(place, { def, city }) {
  return {
    key: place.key,
    name: place.name,
    searchName: place.name,
    names: [place.name],
    profile: businessProfile([place.name], city),
    category: def.id,
    categoryLabel: def.label,
    lat: place.lat,
    lon: place.lon,
    city,
    phone: null,
    email: null,
    address: null,
    openingHours: null,
    socials: [],
    osmUrl: null,
    placeUrl: place.href, // open this listing directly instead of searching for the name
    source: 'maps',
  };
}
