// Gemini (Google's AI), used as a second pair of eyes: is this Google Maps listing the same business,
// does this website belong to it, and (searching Google itself) does the business have a website at all?
// Needs GEMINI_API_KEY. Without it, or once the free daily quota runs out, every question answers null
// and the bot carries on with its own checks.

import { sleep } from './util.js';

const DEFAULT_MODEL = 'gemini-3.1-flash-lite'; // gemini-2.5-flash is no longer available on the API
// Tried in turn if Google retires the one before (HTTP 404), or a key's free plan doesn't include it.
const FALLBACK_MODELS = ['gemini-3.6-flash', 'gemini-2.5-flash'];

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
  const state = { calls: 0, searches: 0, off: apiKey ? null : 'no GEMINI_API_KEY', searchOff: null };
  let last = 0; // the free tier allows 10 questions a minute: keep them at least minIntervalMs apart

  const models = [...new Set([model, ...FALLBACK_MODELS])];
  const searchModels = [...models]; // Google searches have their own quota, which can differ by model
  let failures = 0;
  const failed = (why) => {
    // Say why an answer didn't come (the first few times), so a broken setup shows in the log.
    failures += 1;
    if (failures <= 3) log(`   🤖 AI gave no answer: ${why}`);
    return null;
  };

  async function request(prompt, search) {
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, ...(search ? {} : { responseMimeType: 'application/json' }) },
      ...(search ? { tools: [{ google_search: {} }] } : {}),
    };
    const res = await fetch(`${base}/v1beta/models/${search ? searchModels[0] : models[0]}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text(); // always read the body (an unread one can crash Node's fetch)
    return { status: res.status, text };
  }

  /** { text, sources } of the model's reply (sources: the Google results it used), or null. */
  async function askText(prompt, { search = false } = {}) {
    if (state.off || (search && state.searchOff)) return null;
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
        // A model Google has retired (or not on this key): the next one.
        const list = search ? searchModels : models;
        if (r.status === 404 && list.length > 1) {
          log(`   🤖 Gemini model ${list[0]} isn't available, using ${list[1]}`);
          const gone = list.shift();
          if (!search && searchModels[0] === gone && searchModels.length > 1) searchModels.shift();
          attempt -= 1;
          continue;
        }
        if (r.status === 429) {
          const noFreeQuota = /limit:\s*0\b/.test(r.text); // not in this key's free plan at all
          const daily = /per ?day/i.test(r.text);
          const detail = r.text.replace(/\s+/g, ' ').match(/"message":\s*"([^"]{0,300})/)?.[1] || r.text.slice(0, 300);
          // Google searches have their own quota: when it's gone, the AI still answers everything else.
          if (search && noFreeQuota && searchModels.length > 1) {
            log(`   🤖 Google searches through ${searchModels[0]} aren't in this key's free plan, trying ${searchModels[1]}`);
            searchModels.shift();
            attempt -= 1;
            continue;
          }
          if (search && (noFreeQuota || daily || attempt >= 1)) {
            state.searchOff = noFreeQuota ? "Google searches through Gemini aren't included in this key's free plan"
              : daily ? "today's free Google searches through Gemini are used up" : 'Gemini kept refusing Google searches (over its quota)';
            log(`   🤖 ${state.searchOff}; searching with the other engines instead. Gemini said: ${detail}`);
            return null;
          }
          if (noFreeQuota && models.length > 1) {
            log(`   🤖 Gemini model ${models[0]} has no free quota on this key, using ${models[1]}`);
            models.shift();
            attempt -= 1;
            continue;
          }
          if (daily || noFreeQuota) {
            state.off = "Gemini's free daily limit was reached";
            log(`   🤖 ${state.off}; carrying on without the AI. Gemini said: ${detail}`);
            return null;
          }
        } else if (r.status < 500) {
          break;
        }
        // Per-minute limit or a busy server: wait as long as Gemini asks (or 20 s), then ask again.
        const asked = Number(r.text.match(/"retryDelay":\s*"(\d+)/)?.[1]);
        if (attempt < 2) await sleep(asked > 0 && asked <= 60 ? asked * 1000 + 500 : retryWaitMs);
      }
      if (r.status === 400 || r.status === 401 || r.status === 403) {
        state.off = `Gemini refused the request (HTTP ${r.status}: ${r.text.slice(0, 160).replace(/\s+/g, ' ')}). Check the GEMINI_API_KEY secret`;
        log(`   🤖 ${state.off}`);
        return null;
      }
      if (r.status !== 200) return failed(`HTTP ${r.status} ${r.text.slice(0, 160).replace(/\s+/g, ' ')}`);
      const json = JSON.parse(r.text);
      const cand = json.candidates?.[0];
      const text = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
      if (!text) return failed(`empty reply (${cand?.finishReason || json.promptFeedback?.blockReason || 'no reason given'})`);
      const sources = (cand.groundingMetadata?.groundingChunks || [])
        .map((c) => ({ uri: c.web?.uri || '', title: c.web?.title || '' })).filter((c) => c.uri || c.title);
      return { text, sources };
    } catch (err) {
      return failed(String(err?.message || err).split('\n')[0]); // network hiccup or timeout
    }
  }

  /** The JSON object in the reply, or null. */
  async function ask(prompt, opts) {
    const r = await askText(prompt, opts);
    if (!r) return null;
    return parseJson(r.text) || failed(`unreadable reply: ${r.text.slice(0, 120).replace(/\s+/g, ' ')}`);
  }

  return { get enabled() { return !state.off; }, ask, askText, state };
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

/**
 * A Google search, done by Gemini (Google Search grounding): { results: [{ url, title, snippet }] }, or
 * { error, fatal? }. Only pages on sites Google actually returned are kept, so a made-up address never counts.
 */
export async function aiGoogleSearch(ai, query) {
  if (!ai?.enabled || ai.state.searchOff) return { error: ai?.state.searchOff || ai?.state.off || 'the AI is off', fatal: true };
  const r = await ai.askText(`Search Google for: ${query}

List the results Google shows for this search (up to 10), in order: each page's full address, its title,
and the text shown under it. Only list pages the search actually returned; never make an address up.
Reply with JSON only: {"results": [{"url": "https://…", "title": "…", "snippet": "…"}]}`, { search: true });
  if (!r) return ai.enabled && !ai.state.searchOff ? { error: 'Gemini gave no answer' } : { error: ai.state.searchOff || ai.state.off, fatal: true };
  const bare = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
  // The sites Google returned (Gemini names each source by its domain).
  const hosts = [...new Set(r.sources.map((s) => bare(s.title)).filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)))];
  const onHost = (host) => hosts.find((h) => host === h || host.endsWith(`.${h}`) || h.endsWith(`.${host}`));
  const results = [];
  const covered = new Set();
  for (const item of parseJson(r.text)?.results || []) {
    let url;
    try {
      url = new URL(String(item?.url || ''));
    } catch {
      continue;
    }
    const host = bare(url.hostname);
    if (!/^https?:$/.test(url.protocol) || /(^|\.)(google|googleusercontent|vertexaisearch\.cloud\.google)\./.test(host)) continue;
    const source = onHost(host);
    if (!source) continue;
    covered.add(source);
    results.push({ url: url.href, title: String(item.title || host).slice(0, 200), snippet: String(item.snippet || '').slice(0, 600) });
  }
  for (const h of hosts) if (!covered.has(h)) results.push({ url: `https://${h}/`, title: h, snippet: '' });
  return { results };
}
