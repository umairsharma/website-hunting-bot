// Is this website theirs? A business's own site shows its phone number, whatever the domain is called
// (Culpepper Plumbing at cpimemphis.com). So when the domain doesn't give it away, open the site and look.

import http from 'node:http';
import https from 'node:https';
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

/**
 * The page's HTML, or null. Uses Node's plain http/https rather than fetch(): fetch() on a page whose
 * body is never read can crash the whole run (a Node bug), and websites are often slow or odd.
 * Tests point this at the fake server with SITE_FETCH_BASE.
 */
export function fetchPage(url, { timeoutMs = 10000, maxBytes = 2_000_000, redirects = 4 } = {}) {
  const base = process.env.SITE_FETCH_BASE;
  const target = base ? `${base}/site?url=${encodeURIComponent(url)}` : url;
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    let req;
    try {
      const u = new URL(target);
      const lib = u.protocol === 'http:' ? http : https;
      req = lib.get(u, { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'en' }, timeout: timeoutMs }, (res) => {
        const { statusCode = 0, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location && redirects > 0 && !base) {
          res.resume();
          fetchPage(new URL(headers.location, u).href, { timeoutMs, maxBytes, redirects: redirects - 1 }).then(finish);
          return;
        }
        if (statusCode !== 200 || !/html|text/i.test(headers['content-type'] || 'text/html')) {
          res.resume(); // read and drop the body, so the connection closes cleanly
          finish(null);
          return;
        }
        let size = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          size += chunk.length;
          chunks.push(chunk);
          if (size > maxBytes) {
            finish(Buffer.concat(chunks).toString('utf8'));
            res.destroy();
          }
        });
        res.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
        res.on('error', () => finish(null));
      });
      req.on('timeout', () => {
        req.destroy();
        finish(null);
      });
      req.on('error', () => finish(null));
    } catch {
      finish(null);
    }
    // Belt and braces: a site that trickles data forever still ends.
    setTimeout(() => {
      req?.destroy();
      finish(null);
    }, timeoutMs + 5000).unref();
  });
}

/** The first of these sites that shows the business's phone number (homepage, then /contact), or null. */
export function confirmByPhone(origins, phone, fetchFn = fetchPage) {
  return confirmSite(origins, { phone }, fetchFn).then((r) => r?.origin || null);
}

// Free email services: an address there says nothing about a website.
export const FREE_MAIL = /@(gmail|googlemail|yahoo|ymail|rocketmail|hotmail|outlook|live|msn|icloud|me|mac|aol|comcast|att|sbcglobal|bellsouth|verizon|cox|charter|earthlink|juno|protonmail|proton|gmx|mail|zoho|yandex|frontier|windstream|centurylink|q|optonline|roadrunner|rr)\.[a-z.]+$/i;

/** "1566 Memorial Dr SE" from "1566 Memorial Dr SE, Atlanta, GA 30317", or null if it has no house number. */
export function streetOf(address) {
  const first = String(address || '').split(',')[0].trim();
  return /^\d+[a-z]?\s+\S+/i.test(first) && first.length <= 60 ? first : null;
}

const squash = (s) => String(s || '').toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9]+/g, '');

/**
 * The first of these sites that is clearly the business's: its homepage or contact page shows their phone
 * number or email, or their street address together with their name. Returns { origin, by } or null.
 * facts: { phone, email, street, nameKeys } (nameKeys: the name squashed, e.g. "leoshandcarwash").
 */
export async function confirmSite(origins, facts, fetchFn = fetchPage) {
  const pattern = phonePattern(facts.phone);
  const email = facts.email ? facts.email.toLowerCase() : null;
  const street = facts.street ? squash(facts.street) : null;
  const names = (facts.nameKeys || []).filter((k) => k.length >= 6);
  if (!pattern && !email && !(street && names.length)) return null;
  for (const origin of origins) {
    for (const path of ['/', '/contact', '/contact-us']) {
      const html = await fetchFn(`${origin}${path}`);
      if (html === null && path === '/') break; // site down or not a web page
      if (!html) continue;
      if (pattern && pattern.test(html)) return { origin, by: 'their phone number is on it' };
      if (email && html.toLowerCase().includes(email)) return { origin, by: 'their email is on it' };
      if (street && names.length) {
        const text = squash(html);
        if (text.includes(street) && names.some((k) => text.includes(k))) return { origin, by: 'their address and name are on it' };
      }
    }
  }
  return null;
}
