// Layer 2 — Google Maps: open the business's listing and look for a "Website" button.

import { gotoPage, isBlocked } from './browser.js';
import { hostOf, namesMatch } from './matching.js';

// A place that always has a website on Maps. If the bot can't see it, Maps is blocked or its layout changed.
export const MAPS_CANARY = {
  searchName: 'Eiffel Tower',
  city: 'Paris',
  names: ['Eiffel Tower', 'Tour Eiffel'],
  lat: 48.8584,
  lon: 2.2945,
  expectHost: 'toureiffel.paris',
};

export function mapsSearchUrl(base, biz) {
  const query = [biz.searchName, biz.city].filter(Boolean).join(' ');
  const at = Number.isFinite(biz.lat) && Number.isFinite(biz.lon)
    ? `/@${biz.lat.toFixed(6)},${biz.lon.toFixed(6)},17z`
    : '';
  return `${base}/search/${encodeURIComponent(query)}${at}?hl=en`;
}

function withEnglish(url) {
  try {
    const u = new URL(url);
    u.searchParams.set('hl', 'en');
    return u.href;
  } catch {
    return url;
  }
}

/** 'list' (several results), 'place' (one listing open), 'empty' (no results) or null (still loading). */
function detectView(page) {
  return page
    .evaluate(() => {
      if (document.querySelector('div[role="feed"]')) return 'list';
      const main = document.querySelector('div[role="main"]');
      const h1 = (main && main.querySelector('h1')) || document.querySelector('h1.DUwDvf');
      const title = h1 ? h1.textContent.trim() : '';
      if (title && !/^results$/i.test(title)) return 'place';
      const text = document.body ? document.body.innerText : '';
      if (/can['’]t find|no results found|did not match any/i.test(text)) return 'empty';
      return null;
    })
    .catch(() => null);
}

async function waitForView(page, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    let view = await detectView(page);
    if (view === 'place') {
      // A results list can take a moment to replace the header, so look once more.
      await page.waitForTimeout(1200);
      view = (await detectView(page)) || view;
    }
    if (view) return view;
    await page.waitForTimeout(500);
  }
  return 'timeout';
}

function readPlace(page) {
  return page.evaluate(() => {
    const main = document.querySelector('div[role="main"][aria-label]') || document.querySelector('div[role="main"]') || document.body;
    const pick = (...selectors) => {
      for (const s of selectors) {
        const el = main.querySelector(s) || document.querySelector(s);
        if (el) return el;
      }
      return null;
    };
    const h1 = main.querySelector('h1') || document.querySelector('h1.DUwDvf');
    const websiteEl = pick('a[data-item-id="authority"]', 'a[aria-label^="Website"]', 'a[data-tooltip="Open website"]');
    const phoneEl = pick('button[data-item-id^="phone:tel:"]', 'button[aria-label^="Phone"]');
    const addressEl = pick('button[data-item-id="address"]', 'button[aria-label^="Address"]');

    let rating = null;
    let reviews = null;
    for (const el of main.querySelectorAll('[aria-label]')) {
      const label = el.getAttribute('aria-label') || '';
      if (rating === null) {
        const m = label.match(/^\s*([0-5](?:[.,]\d)?)\s+stars?\b/i);
        if (m) rating = Number(m[1].replace(',', '.'));
      }
      if (reviews === null) {
        const m = label.match(/([\d.,]+)\s+reviews?\b/i);
        if (m) reviews = Number(m[1].replace(/[^\d]/g, ''));
      }
      if (rating !== null && reviews !== null) break;
    }

    // Match the short status line exactly, so a review that says "permanently closed" doesn't count.
    const status = (re) => Array.from(main.querySelectorAll('span, div')).some((el) => re.test((el.textContent || '').trim()));
    const phoneTel = phoneEl ? (phoneEl.getAttribute('data-item-id') || '').replace(/^phone:tel:/, '') : '';
    const phoneLabel = phoneEl ? (phoneEl.getAttribute('aria-label') || '').replace(/^Phone:\s*/i, '').trim() : '';
    return {
      title: ((h1 && h1.textContent) || main.getAttribute('aria-label') || '').trim(),
      website: websiteEl ? websiteEl.href : null,
      phone: phoneLabel || phoneTel || null,
      phoneTel: phoneTel || null,
      address: addressEl ? (addressEl.getAttribute('aria-label') || '').replace(/^Address:\s*/i, '').trim() || null : null,
      rating,
      reviews,
      permanentlyClosed: status(/^permanently closed[\s.·]*$/i),
      temporarilyClosed: status(/^temporarily closed[\s.·]*$/i),
      claimable: /claim this business/i.test(main.innerText || ''),
      limitedView: /limited view/i.test(document.body ? document.body.innerText : ''),
    };
  });
}

/**
 * status: 'found' (listing opened), 'not_found', 'blocked' or 'error'.
 * When found: website, phone, address, rating, reviews, permanentlyClosed, temporarilyClosed, claimable, mapsUrl.
 */
export async function checkMaps(page, biz, { mapsBase, timeoutMs = 20000 }) {
  const searchUrl = mapsSearchUrl(mapsBase, biz);
  try {
    await gotoPage(page, searchUrl);
    if (await isBlocked(page)) return { status: 'blocked' };
    let view = await waitForView(page, timeoutMs);
    if (view === 'timeout' && (await isBlocked(page))) return { status: 'blocked' };

    if (view === 'list') {
      // The list box appears before its results are filled in, so wait for the result links.
      const linkSelector = 'div[role="feed"] a[href*="/maps/place/"]';
      await page.waitForSelector(linkSelector, { state: 'attached', timeout: 8000 }).catch(() => {});
      const items = await page.$$eval(linkSelector, (links) =>
        links.map((a) => ({ href: a.href, label: a.getAttribute('aria-label') || a.textContent || '' })));
      if (!items.length) return { status: 'error', reason: 'the results list did not load' };
      const hit = items.slice(0, 10).find((item) => namesMatch(item.label, biz.names));
      if (!hit) return { status: 'not_found', searchUrl };
      await gotoPage(page, withEnglish(hit.href));
      if (await isBlocked(page)) return { status: 'blocked' };
      view = await waitForView(page, timeoutMs);
      if (view !== 'place') return { status: 'error', reason: 'the listing did not load' };
    }
    if (view === 'empty') return { status: 'not_found', searchUrl };
    if (view !== 'place') return { status: 'error', reason: 'Google Maps did not load' };

    await page
      .waitForSelector('button[data-item-id="address"], a[data-item-id="authority"], button[data-item-id^="phone:tel:"]', { state: 'attached', timeout: 4000 })
      .catch(() => {});
    const info = await readPlace(page);
    if (!namesMatch(info.title, biz.names)) return { status: 'not_found', searchUrl, shownInstead: info.title };
    return { status: 'found', ...info, mapsUrl: page.url() };
  } catch (err) {
    if (await isBlocked(page).catch(() => false)) return { status: 'blocked' };
    return { status: 'error', reason: String(err.message || err).split('\n')[0] };
  }
}

/** Checks the canary place. ok=false means layer 2 can't be trusted this run. */
export async function mapsSelfTest(page, opts, log = () => {}) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const r = await checkMaps(page, MAPS_CANARY, opts);
    if (r.status === 'blocked') return { ok: false, reason: 'blocked' };
    if (r.status === 'found' && r.website && hostOf(r.website).endsWith(MAPS_CANARY.expectHost)) return { ok: true };
    const detail = r.status === 'found' ? 'no website button found' : r.reason || r.status;
    log(`   Maps self-test attempt ${attempt}: ${detail}`);
    if (attempt === 1) await page.waitForTimeout(3000);
  }
  return { ok: false, reason: 'layout' };
}
