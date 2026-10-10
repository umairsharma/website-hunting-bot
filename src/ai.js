// Gemini (Google's AI), used as a second pair of eyes: is this Google Maps listing the same business,
// does this website belong to it, and (searching Google itself) does the business have a website at all?
// Needs GEMINI_API_KEY. Without it, or once the free daily quota runs out, every question answers null
// and the bot carries on with its own checks.

import { sleep } from './util.js';

const DEFAULT_MODEL = 'gemini-2.5-flash'; // free tier includes Google Search grounding on this model

/** The first JSON object in a model reply (which may wrap it in ```json fences or a sentence). */
export function parseJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  for (let end = s.lastIndexOf('}'); end > start; end = s.lastIndexOf('}', end - 1)) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      // try a shorter span
    }
  }
  return null;
}

/**
 * { enabled, ask(prompt, { search }), state }. ask() resolves the reply's JSON object, or null when the
 * AI is off, out of quota, or answered something unreadable.
 */
export function createAi({
  apiKey = process.env.GEMINI_API_KEY, base = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
  model = DEFAULT_MODEL, maxCalls = 100, log = () => {}, timeoutMs = 60000, retryWaitMs = 20000, minIntervalMs = 6500,
} = {}) {
  const state = { calls: 0, searches: 0, off: apiKey ? null : 'no GEMINI_API_KEY' };
  let last = 0; // the free tier allows 10 questions a minute: keep them at least minIntervalMs apart

  async function request(prompt, search) {
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, ...(search ? {} : { responseMimeType: 'application/json' }) },
      ...(search ? { tools: [{ google_search: {} }] } : {}),
    };
    const res = await fetch(`${base}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text(); // always read the body (an unread one can crash Node's fetch)
    return { status: res.status, text };
  }

  async function ask(prompt, { search = false } = {}) {
    if (state.off) return null;
    if (state.calls >= maxCalls) {
      state.off = `the per-run limit of ${maxCalls} AI questions was reached`;
      return null;
    }
    state.calls += 1;
    if (search) state.searches += 1;
    try {
      let r;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const wait = last + minIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
        r = await request(prompt, search);
        if (r.status !== 429 && r.status < 500) break;
        // The daily quota is used up: no point asking again today.
        if (r.status === 429 && /per ?day/i.test(r.text)) {
          state.off = "Gemini's free daily limit was reached";
          log(`   🤖 ${state.off}; carrying on without the AI`);
          return null;
        }
        if (attempt < 2) await sleep(retryWaitMs); // per-minute limit or a busy server: wait, then ask again
      }
      if (r.status === 400 || r.status === 401 || r.status === 403) {
        state.off = `Gemini refused the request (HTTP ${r.status}: ${r.text.slice(0, 120).replace(/\s+/g, ' ')}). Check the GEMINI_API_KEY secret`;
        log(`   🤖 ${state.off}`);
        return null;
      }
      if (r.status !== 200) return null;
      const json = JSON.parse(r.text);
      const reply = (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      return parseJson(reply);
    } catch {
      return null; // network hiccup or timeout: this one question goes unanswered
    }
  }

  return { get enabled() { return !state.off; }, ask, state };
}

/** A web page's readable text (no scripts, styles or tags), for the AI to read. */
export function visibleText(html, max = 6000) {
  return String(html || '')
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const describe = (biz) => [
  `Name: ${biz.name}`,
  biz.category ? `Type: ${biz.category}` : null,
  biz.address ? `Address: ${biz.address}` : null,
  biz.city ? `Town/area: ${biz.city}${biz.country ? `, ${biz.country}` : ''}` : null,
  biz.phones?.length ? `Phone: ${biz.phones.join(' / ')}` : null,
  biz.emails?.length ? `Email: ${biz.emails.join(' / ')}` : null,
].filter(Boolean).join('\n');

const sure = (c) => /^(high|medium)$/i.test(String(c || ''));

/**
 * Google Maps showed other names for this business's search: which one (if any) is it?
 * options: [{ label, detail? }]. Returns the index, or null.
 */
export async function aiPickListing(ai, biz, options) {
  if (!ai?.enabled || !options.length) return null;
  const list = options.map((o, i) => `${i}. ${o.label}${o.detail ? ` (${o.detail})` : ''}`).join('\n');
  const a = await ai.ask(`A local business (from OpenStreetMap):
${describe(biz)}

Google Maps showed these listings when searching for it:
${list}

Which listing is this same business (same business, possibly a slightly different or longer name), if any?
A different business with a similar name, or a chain branch elsewhere, is NOT a match.
Reply with JSON only: {"match": <number or null>, "confidence": "high"|"medium"|"low", "reason": "<short>"}`);
  const i = a && Number.isInteger(a.match) ? a.match : null;
  return i !== null && i >= 0 && i < options.length && sure(a.confidence) ? i : null;
}

/** Does this website belong to the business? pageText: the site's visible text. */
export async function aiSiteBelongs(ai, biz, url, pageText) {
  if (!ai?.enabled) return null;
  const a = await ai.ask(`Does this website belong to this local business (its own site, not a directory, review site,
marketplace, social network, or another business with a similar name)?

Business:
${describe(biz)}

Website: ${url}
Text from the website (start of the page):
"""${String(pageText).slice(0, 6000)}"""

Reply with JSON only: {"belongs": true|false, "confidence": "high"|"medium"|"low", "reason": "<short>"}`);
  return a ? { belongs: a.belongs === true && sure(a.confidence), reason: String(a.reason || '').slice(0, 200) } : null;
}

/** Gemini searches Google itself: does the business have its own website? */
export async function aiFindWebsite(ai, biz) {
  if (!ai?.enabled) return null;
  const a = await ai.ask(`Search Google to find out whether this local business has its own website.
Try its name with its town, its phone number, and its address.

${describe(biz)}

Its own website means a site run by or for this business (its own domain, or a site builder page like
Wix/Square/GoDaddy for it). These do NOT count: Facebook, Instagram or other social pages, Yelp, Yellow Pages,
BBB, Google listings or any directory/review/booking site, and websites of other businesses with similar names.

Give the website's own address (like https://joesplumbing.com), never a Google or vertexaisearch redirect link.
Reply with JSON only: {"hasWebsite": true|false, "url": "<their website, or null>", "confidence": "high"|"medium"|"low", "reason": "<short>"}`, { search: true });
  if (!a) return null;
  if (typeof a.url === 'string' && /(^|[/.])(google|googleusercontent|vertexaisearch\.cloud\.google)\.[a-z.]+(\/|$)/i.test(a.url)) a.url = null;
  const url = typeof a.url === 'string' && /^https?:\/\//i.test(a.url) ? a.url : (typeof a.url === 'string' && /^[a-z0-9.-]+\.[a-z]{2,}/i.test(a.url) ? `https://${a.url}` : null);
  return { hasWebsite: a.hasWebsite === true, url, confident: sure(a.confidence), high: /^high$/i.test(String(a.confidence)), reason: String(a.reason || '').slice(0, 200) };
}
