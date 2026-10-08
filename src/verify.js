// Is this website theirs? A business's own site shows its phone number, whatever the domain is called
// (Culpepper Plumbing at cpimemphis.com). So when the domain doesn't give it away, open the site and look.

import { classifyUrl } from './matching.js';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/**
 * A pattern for a phone number as websites write it: (901) 685-8842, 901.685.8842, +1 901 685 8842,
 * tel:+19016858842. Uses the last 10 digits (the number without the country code), or null if too short.
 */
export function phonePattern(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 7) return null;
  const core = digits.slice(-10).replace(/^0/, '');
  // No check before the number: it may follow a country code (tel:+1901…) or a 0 (0321-…).
  return new RegExp(`${core.split('').join('[^0-9a-z]{0,3}')}(?!\\d)`, 'i');
}

/** Each site's homepage (and /contact), from search results that are websites, not directories or socials. */
export function siteOrigins(results, limit = 3) {
  const out = [];
  for (const r of results) {
    const site = classifyUrl(r.url);
    if (!site || site.kind !== 'website') continue;
    const origin = new URL(site.url).origin;
    if (!out.includes(origin)) out.push(origin);
    if (out.length >= limit) break;
  }
  return out;
}

/** The page's HTML, or null. Tests point this at the fake server with SITE_FETCH_BASE. */
export async function fetchPage(url, { timeoutMs = 10000 } = {}) {
  const base = process.env.SITE_FETCH_BASE;
  const target = base ? `${base}/site?url=${encodeURIComponent(url)}` : url;
  try {
    const res = await fetch(target, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'en' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok || !/html|text/i.test(res.headers.get('content-type') || 'text/html')) return null;
    return (await res.text()).slice(0, 2_000_000);
  } catch {
    return null;
  }
}

/** The first of these sites that shows the business's phone number (homepage, then /contact), or null. */
export async function confirmByPhone(origins, phone, fetchFn = fetchPage) {
  const pattern = phonePattern(phone);
  if (!pattern) return null;
  for (const origin of origins) {
    for (const path of ['/', '/contact', '/contact-us']) {
      const html = await fetchFn(`${origin}${path}`);
      if (html && pattern.test(html)) return origin;
      if (html === null && path === '/') break; // site down or not a web page
    }
  }
  return null;
}
